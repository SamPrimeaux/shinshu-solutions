import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { authenticateUser, createSession, getUserBySession, deleteSession } from './auth';

// ─── Env ──────────────────────────────────────────────────────────────────────

interface Env {
    DB: D1Database;
    R2: R2Bucket;
    MCP_SECRET: string;
    CLOUDFLARE_API_TOKEN: string;
    RESEND_API_KEY: string;
    RESEND_SIGNING_SECRET: string;
    RESEND_FROM_EMAIL: string;
    ENVIRONMENT: string;
    TENANT_ID: string;
    CLIENT_ID: string;
}

type Variables = {
    user?: { id: string; email: string; name: string; role: string };
};

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}

// ─── DB-driven tool row ───────────────────────────────────────────────────────

interface MpcToolRow {
    id: string;
    server_id: string;
    name: string;
    description: string;
    input_schema: string;   // JSON string
    category: string;
    is_active: number;
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Content-Type helpers ─────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
    html: 'text/html; charset=utf-8',   css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
    png: 'image/png',   jpg: 'image/jpeg',   jpeg: 'image/jpeg',
    gif: 'image/gif',   svg: 'image/svg+xml', webp: 'image/webp',
    ico: 'image/x-icon', woff: 'font/woff',  woff2: 'font/woff2',
    ttf: 'font/ttf',    eot: 'application/vnd.ms-fontobject',
    pdf: 'application/pdf', xml: 'application/xml', txt: 'text/plain; charset=utf-8',
};

function getContentType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// ─── R2 serve with content injection ─────────────────────────────────────────

async function serveFromR2(
    r2: R2Bucket,
    path: string,
    defaultFile = 'index.html',
    db?: D1Database
): Promise<Response | null> {
    try {
        let cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '');
        if (!cleanPath || cleanPath.endsWith('/')) cleanPath += defaultFile;
        if (!cleanPath.includes('.')) cleanPath += '.html';

        const object = await r2.get(cleanPath);
        if (!object) return null;

        const contentType = object.httpMetadata?.contentType || getContentType(cleanPath);
        const headers = {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=3600',
            'ETag': object.httpEtag || '',
        };

        if (contentType.includes('text/html') && db) {
            let text = await object.text();
            try {
                const { results } = await db.prepare('SELECT * FROM site_content').all();
                if (results?.length) {
                    results.forEach((row: any) => {
                        const key = row.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const re = new RegExp(`(<[^>]+data-content-key=["']${key}["'][^>]*>)([^<]*)(</[^>]+>)`, 'g');
                        text = text.replace(re, `$1${row.value}$3`);
                    });
                }
            } catch (e) { console.error('Content injection error:', e); }
            return new Response(text, { headers });
        }

        return new Response(object.body, { headers });
    } catch (error) {
        console.error('R2 serve error:', error);
        return null;
    }
}

// ─── MCP: load tools from DB ──────────────────────────────────────────────────
// Tools are stored in mcp_tools table (server_id = 'mcp_site').
// Disable a tool: UPDATE mcp_tools SET is_active=0 WHERE name='ss_schema_inspect';
// Add a tool:     INSERT INTO mcp_tools (id,server_id,name,description,input_schema,category) VALUES (...)
// Edit desc:      UPDATE mcp_tools SET description='...' WHERE name='ss_list_pages';
// No redeploy needed — changes are live on next request.

async function loadTools(db: D1Database): Promise<MpcToolRow[]> {
    try {
        const { results } = await db
            .prepare("SELECT * FROM mcp_tools WHERE server_id = 'mcp_site' AND is_active = 1 ORDER BY category, name")
            .all();
        return (results ?? []) as MpcToolRow[];
    } catch {
        // mcp_tools table not yet created — return empty, don't crash
        return [];
    }
}

function toolRowToMcpDef(row: MpcToolRow) {
    let inputSchema: Record<string, unknown> = { type: 'object', properties: {}, required: [] };
    try { inputSchema = JSON.parse(row.input_schema); } catch {}
    return { name: row.name, description: row.description, inputSchema };
}

// ─── MCP: tool executor ───────────────────────────────────────────────────────
// Add new tool implementations here when you INSERT into mcp_tools.
// The DB controls visibility/metadata; this switch controls behavior.

async function executeTool(name: string, args: Record<string, unknown>, db: D1Database): Promise<unknown> {
    switch (name) {

        // ── CMS: pages ────────────────────────────────────────────────────────
        case 'ss_list_pages': {
            const { results } = await db.prepare(
                'SELECT id, slug, title, meta_description, sort_order FROM pages ORDER BY sort_order ASC, id ASC'
            ).all();
            return results;
        }
        case 'ss_get_page': {
            const slug = args.slug as string;
            const page = await db.prepare('SELECT * FROM pages WHERE slug = ?').bind(slug).first();
            if (!page) return { error: `Page not found: ${slug}` };
            const { results: content } = await db
                .prepare('SELECT * FROM site_content WHERE page_slug = ? ORDER BY section, key')
                .bind(slug).all();
            return { page, content };
        }
        case 'ss_update_page_meta': {
            const { slug, title, meta_description, meta_keywords } = args as Record<string, string>;
            const fields: string[] = [];
            const vals: unknown[] = [];
            if (title !== undefined)            { fields.push('title = ?');            vals.push(title); }
            if (meta_description !== undefined) { fields.push('meta_description = ?'); vals.push(meta_description); }
            if (meta_keywords !== undefined)    { fields.push('meta_keywords = ?');    vals.push(meta_keywords); }
            if (!fields.length) return { error: 'Provide at least one field to update' };
            vals.push(Date.now(), slug);
            await db.prepare(`UPDATE pages SET ${fields.join(', ')}, updated_at = ? WHERE slug = ?`).bind(...vals).run();
            return { success: true, slug, updated: fields.map(f => f.split(' ')[0]) };
        }

        // ── CMS: content blocks ───────────────────────────────────────────────
        case 'ss_list_content': {
            const { page_slug, section } = args as Record<string, string | undefined>;
            const clauses: string[] = [];
            const vals: unknown[] = [];
            if (page_slug) { clauses.push('page_slug = ?'); vals.push(page_slug); }
            if (section)   { clauses.push('section = ?');   vals.push(section); }
            const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
            const { results } = await db
                .prepare(`SELECT * FROM site_content${where} ORDER BY page_slug, section, key`)
                .bind(...vals).all();
            return results;
        }
        case 'ss_update_content': {
            const { key, value } = args as { key: string; value: string };
            await db.prepare(
                'INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?) ' +
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
            ).bind(key, value, Date.now()).run();
            return { success: true, key };
        }
        case 'ss_bulk_update_content': {
            const updates = args.updates as Record<string, string>;
            const entries = Object.entries(updates);
            if (!entries.length) return { error: 'No updates provided' };
            const stmt = db.prepare(
                'INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?) ' +
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
            );
            await db.batch(entries.map(([k, v]) => stmt.bind(k, v, Date.now())));
            return { success: true, updated: entries.map(([k]) => k) };
        }

        // ── CMS: settings ─────────────────────────────────────────────────────
        case 'ss_get_settings': {
            const { results } = await db.prepare('SELECT * FROM site_settings').all();
            const map: Record<string, unknown> = {};
            results?.forEach((r: any) => { map[r.key] = r.value; });
            return map;
        }
        case 'ss_update_setting': {
            const { key, value } = args as { key: string; value: string };
            await db.prepare(
                'INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
                'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
            ).bind(key, value, Date.now()).run();
            return { success: true, key };
        }

        // ── CMS: nav ──────────────────────────────────────────────────────────
        case 'ss_list_site_pages': {
            const { results } = await db.prepare('SELECT * FROM site_pages ORDER BY sort_order ASC, id ASC').all();
            return results;
        }
        case 'ss_update_site_page': {
            const { slug, nav_visible, sort_order, nav_label } = args as {
                slug: string; nav_visible?: boolean; sort_order?: number; nav_label?: string;
            };
            const fields: string[] = [];
            const vals: unknown[] = [];
            if (nav_visible !== undefined) { fields.push('nav_visible = ?'); vals.push(nav_visible ? 1 : 0); }
            if (sort_order !== undefined)  { fields.push('sort_order = ?');  vals.push(sort_order); }
            if (nav_label !== undefined)   { fields.push('nav_label = ?');   vals.push(nav_label); }
            if (!fields.length) return { error: 'Provide at least one field to update' };
            vals.push(Date.now(), slug);
            await db.prepare(`UPDATE site_pages SET ${fields.join(', ')}, updated_at = ? WHERE slug = ?`).bind(...vals).run();
            return { success: true, slug };
        }

        // ── Media ─────────────────────────────────────────────────────────────
        case 'ss_list_r2_assets': {
            // R2 not accessible from executeTool — signal to caller to handle
            return { error: 'ss_list_r2_assets requires R2 binding — handled at MCP route level' };
        }

        // ── Diagnostics ───────────────────────────────────────────────────────
        case 'ss_schema_inspect': {
            const table = (args.table as string).replace(/[^a-zA-Z0-9_]/g, '');
            const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
            return results;
        }

        // ── MCP self-management (DB-driven) ───────────────────────────────────
        case 'ss_list_mcp_tools': {
            // List all tools including inactive ones — for Agent Sam to manage the registry
            const { results } = await db.prepare(
                "SELECT id, name, description, category, is_active FROM mcp_tools WHERE server_id = 'mcp_site' ORDER BY category, name"
            ).all();
            return results;
        }
        case 'ss_toggle_mcp_tool': {
            // Enable or disable a tool by name — no redeploy needed
            const { tool_name, active } = args as { tool_name: string; active: boolean };
            await db.prepare(
                "UPDATE mcp_tools SET is_active = ? WHERE name = ? AND server_id = 'mcp_site'"
            ).bind(active ? 1 : 0, tool_name).run();
            return { success: true, tool_name, is_active: active };
        }
        case 'ss_update_mcp_tool_description': {
            // Edit a tool's description in DB — reflects immediately on next tools/list call
            const { tool_name, description } = args as { tool_name: string; description: string };
            await db.prepare(
                "UPDATE mcp_tools SET description = ? WHERE name = ? AND server_id = 'mcp_site'"
            ).bind(description, tool_name).run();
            return { success: true, tool_name };
        }
        case 'ss_add_mcp_tool': {
            // Register a new tool stub in DB — add its implementation to executeTool switch above
            const { id, name, description, category, input_schema } = args as Record<string, string>;
            await db.prepare(
                'INSERT INTO mcp_tools (id, server_id, name, description, category, input_schema, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)'
            ).bind(id, 'mcp_site', name, description, category ?? 'custom', input_schema ?? '{"type":"object","properties":{},"required":[]}').run();
            return { success: true, name, note: 'Tool registered. Add implementation to executeTool switch and redeploy.' };
        }

        // ── Agent knowledge ───────────────────────────────────────────────────
        case 'ss_search_knowledge': {
            const query = args.query as string;
            const { results } = await db.prepare(
                'SELECT id, topic, title, content FROM agent_knowledge WHERE content LIKE ? OR title LIKE ? OR topic LIKE ? LIMIT 10'
            ).bind(`%${query}%`, `%${query}%`, `%${query}%`).all();
            return results;
        }
        case 'ss_add_knowledge': {
            const { topic, title, content } = args as { topic: string; title: string; content: string };
            await db.prepare(
                'INSERT INTO agent_knowledge (topic, title, content) VALUES (?, ?, ?)'
            ).bind(topic, title, content).run();
            return { success: true };
        }

        default:
            throw new Error(`Unknown tool: ${name}. Check mcp_tools table — is_active may be 0 or implementation missing.`);
    }
}

// ─── MCP helpers ─────────────────────────────────────────────────────────────

const CORS = {
    'Access-Control-Allow-Origin': 'https://dashboard.shinshusolutions.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function rpcOk(id: string | number | null, result: unknown) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
    });
}
function rpcErr(id: string | number | null, code: number, message: string, status = 200) {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
        status, headers: { 'Content-Type': 'application/json', ...CORS },
    });
}

// ─── MCP endpoint ─────────────────────────────────────────────────────────────

app.options('/mcp', (c) => new Response(null, { status: 204, headers: CORS }));

app.post('/mcp', async (c) => {
    // Auth
    const auth = c.req.header('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!c.env.MCP_SECRET || token !== c.env.MCP_SECRET)
        return rpcErr(null, -32001, 'Unauthorized', 401);

    // Parse
    let rpc: JsonRpcRequest;
    try { rpc = await c.req.json<JsonRpcRequest>(); }
    catch { return rpcErr(null, -32700, 'Parse error'); }

    const { id = null, method, params = {} } = rpc;

    try {
        switch (method) {

            case 'initialize':
                return rpcOk(id, {
                    protocolVersion: '2024-11-05',
                    serverInfo: { name: 'shinshu-solutions-mcp', version: '2.0.0' },
                    capabilities: { tools: {} },
                });

            // tools/list — always reads from DB, zero redeploy needed
            case 'tools/list': {
                const rows = await loadTools(c.env.DB);
                const tools = rows.map(toolRowToMcpDef);

                // Always inject the meta-management tools so Agent Sam can manage the registry
                tools.push(
                    { name: 'ss_list_mcp_tools',              description: 'List all MCP tools including inactive ones', inputSchema: { type: 'object', properties: {}, required: [] } },
                    { name: 'ss_toggle_mcp_tool',             description: 'Enable or disable a tool by name without redeploying', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, active: { type: 'boolean' } }, required: ['tool_name', 'active'] } },
                    { name: 'ss_update_mcp_tool_description', description: 'Edit a tool description in DB — live immediately', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, description: { type: 'string' } }, required: ['tool_name', 'description'] } },
                    { name: 'ss_add_mcp_tool',                description: 'Register a new tool stub in mcp_tools DB table', inputSchema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, category: { type: 'string' }, input_schema: { type: 'string' } }, required: ['id', 'name', 'description'] } },
                    { name: 'ss_search_knowledge',            description: 'Search agent_knowledge for context', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
                    { name: 'ss_add_knowledge',               description: 'Add a new row to agent_knowledge', inputSchema: { type: 'object', properties: { topic: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['topic', 'title', 'content'] } }
                );

                return rpcOk(id, { tools });
            }

            case 'tools/call': {
                const toolName = params.name as string;
                const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
                if (!toolName) return rpcErr(id, -32602, 'Missing params.name');

                // Special case: ss_list_r2_assets needs R2 binding
                if (toolName === 'ss_list_r2_assets') {
                    const prefix = toolArgs.prefix as string | undefined;
                    const limit = Math.min(Number(toolArgs.limit ?? 100), 1000);
                    const opts: R2ListOptions = { limit };
                    if (prefix) opts.prefix = prefix;
                    const listed = await c.env.R2.list(opts);
                    const result = listed.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded }));
                    return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
                }

                const result = await executeTool(toolName, toolArgs, c.env.DB);
                return rpcOk(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
            }

            default:
                return rpcErr(id, -32601, `Method not found: ${method}`);
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Internal error';
        console.error(`[MCP] ${method} error:`, e);
        return rpcErr(id, -32603, msg);
    }
});

// ─── Health / diagnostics ─────────────────────────────────────────────────────

app.get('/api/health', (c) =>
    c.json({ status: 'healthy', environment: c.env.ENVIRONMENT, timestamp: new Date().toISOString() })
);
app.get('/api/db-test', async (c) => {
    try {
        const result = await c.env.DB.prepare('SELECT 1 as test').first();
        return c.json({ success: true, database: 'connected', result });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Unknown' }, 500);
    }
});
app.get('/api/r2-test', async (c) => {
    try {
        const listed = await c.env.R2.list({ limit: 10 });
        return c.json({ success: true, storage: 'connected', objectCount: listed.objects.length });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Unknown' }, 500);
    }
});

// ─── Gallery ──────────────────────────────────────────────────────────────────

app.get('/api/gallery/images', async (c) => {
    try {
        const listed = await c.env.R2.list({ limit: 1000 });
        const images = listed.objects
            .filter(o => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(o.key))
            .map(o => ({ key: o.key, url: `https://shinshusolutions.com/${o.key}`, size: o.size, uploaded: o.uploaded }));
        return c.json({ success: true, count: images.length, images });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Unknown' }, 500);
    }
});

// ─── Contact ──────────────────────────────────────────────────────────────────

app.post('/api/contact', async (c) => {
    try {
        const { name, email, message } = await c.req.json();
        if (!name || !email || !message)
            return c.json({ success: false, error: 'All fields are required' }, 400);

        await c.env.DB.prepare(
            'INSERT INTO inbox_messages (id, name, email, message, received_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(crypto.randomUUID(), name, email, message, Date.now()).run();

        const h = { 'Authorization': `Bearer ${c.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
        await fetch('https://api.resend.com/emails', { method: 'POST', headers: h, body: JSON.stringify({ from: c.env.RESEND_FROM_EMAIL, to: 'jawaalk@shinshusolutions.com', reply_to: email, subject: `New Contact: ${name}`, html: `<h2>New Message from ${name}</h2><p><strong>Email:</strong> ${email}</p><blockquote style="background:#f9f9f9;padding:15px;border-left:4px solid #FF8C42;">${message.replace(/\n/g, '<br>')}</blockquote>` }) });
        await fetch('https://api.resend.com/emails', { method: 'POST', headers: h, body: JSON.stringify({ from: c.env.RESEND_FROM_EMAIL, to: email, subject: `We received your message - Shinshu Solutions`, html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;"><img src="https://pub-c341cc62c3274ccba5aa77286b26fb90.r2.dev/iconography/shinshu-solutions-icon.png" width="80" alt="Shinshu Solutions" style="margin-bottom:20px;"><h2 style="color:#FF8C42;">Thank you, ${name}!</h2><p>We received your message and will be in touch shortly.</p><hr style="border:0;border-top:1px solid #eee;margin:20px 0;"><p style="color:#666;font-size:.9rem;">Shinshu Solutions · Nagano, Japan</p></div>` }) });

        return c.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Contact form error:', error);
        return c.json({ success: false, error: 'Failed to send message' }, 500);
    }
});

// ─── Dashboard APIs ───────────────────────────────────────────────────────────

app.get('/api/assets', async (c) => {
    try {
        const listed = await c.env.R2.list({ limit: 1000 });
        return c.json({ success: true, assets: listed.objects.map(o => ({ key: o.key, url: `https://shinshusolutions.com/${o.key}`, size: o.size, uploaded: o.uploaded, type: getContentType(o.key) })) });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Error' }, 500);
    }
});
app.delete('/api/assets/:key', async (c) => {
    try { await c.env.R2.delete(c.req.param('key')); return c.json({ success: true }); }
    catch { return c.json({ success: false, error: 'Delete failed' }, 500); }
});
app.post('/api/assets/upload', async (c) => {
    try {
        const body = await c.req.parseBody();
        const file = body['file'];
        if (!file || !(file instanceof File)) return c.json({ success: false, error: 'No file' }, 400);
        await c.env.R2.put(file.name, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
        return c.json({ success: true, key: file.name, url: `https://shinshusolutions.com/${file.name}` });
    } catch { return c.json({ success: false, error: 'Upload failed' }, 500); }
});
app.get('/api/content', async (c) => {
    try {
        const { results } = await c.env.DB.prepare('SELECT * FROM site_content').all();
        const map: Record<string, string> = {};
        results?.forEach((r: any) => { map[r.key] = r.value; });
        return c.json({ success: true, content: map });
    } catch { return c.json({ success: false, error: 'Failed to fetch content' }, 500); }
});
app.post('/api/content', async (c) => {
    try {
        const { updates } = await c.req.json();
        if (!updates) return c.json({ success: false, error: 'No updates' }, 400);
        const stmt = c.env.DB.prepare('INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at');
        await c.env.DB.batch(Object.entries(updates).map(([k, v]) => stmt.bind(k, v, Date.now())));
        return c.json({ success: true });
    } catch { return c.json({ success: false, error: 'Update failed' }, 500); }
});
app.get('/api/messages', async (c) => {
    try {
        const { results } = await c.env.DB.prepare('SELECT * FROM inbox_messages ORDER BY received_at DESC').all();
        return c.json({ success: true, messages: results });
    } catch { return c.json({ success: false, error: 'Failed to fetch messages' }, 500); }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (c) => {
    try {
        const { email, password } = await c.req.json();
        if (!email || !password) return c.json({ success: false, error: 'Email and password required' }, 400);
        const user = await authenticateUser(c.env.DB, email, password);
        if (!user) return c.json({ success: false, error: 'Invalid credentials' }, 401);
        const sessionId = await createSession(c.env.DB, user.id);
        setCookie(c, 'session_id', sessionId, { httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 7 * 24 * 60 * 60, path: '/' });
        return c.json({ success: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch { return c.json({ success: false, error: 'Authentication failed' }, 500); }
});
app.post('/api/auth/logout', async (c) => {
    try {
        const sessionId = getCookie(c, 'session_id');
        if (sessionId) await deleteSession(c.env.DB, sessionId);
        deleteCookie(c, 'session_id', { path: '/' });
        return c.json({ success: true });
    } catch { return c.json({ success: false, error: 'Logout failed' }, 500); }
});
app.get('/api/auth/me', async (c) => {
    try {
        const sessionId = getCookie(c, 'session_id');
        if (!sessionId) return c.json({ success: false, error: 'Not authenticated' }, 401);
        const user = await getUserBySession(c.env.DB, sessionId);
        if (!user) { deleteCookie(c, 'session_id', { path: '/' }); return c.json({ success: false, error: 'Session expired' }, 401); }
        return c.json({ success: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch { return c.json({ success: false, error: 'Session check failed' }, 500); }
});

// ─── Catch-all: R2 serve ──────────────────────────────────────────────────────

app.get('*', async (c) => {
    const path = c.req.path;
    if (path.startsWith('/api/')) return c.json({ error: 'Not found' }, 404);

    const r2Response = await serveFromR2(c.env.R2, path, 'index.html', c.env.DB);
    if (r2Response) return r2Response;

    const notFoundPage = await serveFromR2(c.env.R2, '404.html', 'index.html', c.env.DB);
    if (notFoundPage) return new Response(notFoundPage.body, { status: 404, headers: notFoundPage.headers });

    return c.html(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>404 | Shinshu Solutions</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:system-ui,sans-serif;background:linear-gradient(135deg,#667eea,#764ba2);min-height:100vh;display:flex;align-items:center;justify-content:center}.box{background:#fff;border-radius:20px;padding:60px 40px;max-width:500px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3)}h1{font-size:4rem;color:#667eea}p{color:#4a5568;margin:16px 0 30px}a{background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;padding:14px 28px;border-radius:50px;text-decoration:none;font-weight:600}</style>
</head><body><div class="box"><h1>404</h1><p>Page not found</p><a href="/">Return Home</a></div></body></html>`, 404);
});

export default app;

// Durable Object stub — preserves existing ShinshuState binding
export class ShinshuState {
    state: DurableObjectState;
    constructor(state: DurableObjectState) { this.state = state; }
    async fetch(request: Request): Promise<Response> {
        return new Response('ShinshuState OK');
    }
}
