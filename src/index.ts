import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { authenticateUser, createSession, getUserBySession, deleteSession } from './auth';

// ─── Env ────────────────────────────────────────────────────────────────────

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

// ─── MCP Types ───────────────────────────────────────────────────────────────

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: string | number | null;
    method: string;
    params?: Record<string, unknown>;
}

interface ToolDef {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

// ─── App ─────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// ─── Content-Type helpers ─────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    webp: 'image/webp',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    eot: 'application/vnd.ms-fontobject',
    pdf: 'application/pdf',
    xml: 'application/xml',
    txt: 'text/plain; charset=utf-8',
};

function getContentType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// ─── R2 Serve ─────────────────────────────────────────────────────────────────

async function serveFromR2(
    r2: R2Bucket,
    path: string,
    defaultFile = 'index.html',
    db?: D1Database
): Promise<Response | null> {
    try {
        let cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '');
        if (!cleanPath || cleanPath.endsWith('/')) cleanPath = cleanPath + defaultFile;
        if (!cleanPath.includes('.')) cleanPath = cleanPath + '.html';

        console.log(`R2 fetch: ${cleanPath}`);
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
                        const re = new RegExp(
                            `(<[^>]+data-content-key=["']${key}["'][^>]*>)([^<]*)(</[^>]+>)`,
                            'g'
                        );
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

// ─── MCP Tool Definitions ─────────────────────────────────────────────────────

const MCP_TOOLS: ToolDef[] = [
    {
        name: 'ss_list_pages',
        description: 'List all pages in the shinshu-solutions site (id, slug, title, meta_description)',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'ss_get_page',
        description: 'Get full page details plus all site_content rows for a given page slug',
        inputSchema: {
            type: 'object',
            properties: { slug: { type: 'string', description: 'Page slug, e.g. "home" or "about"' } },
            required: ['slug'],
        },
    },
    {
        name: 'ss_update_page_meta',
        description: 'Update title, meta_description, or meta_keywords for a page by slug',
        inputSchema: {
            type: 'object',
            properties: {
                slug: { type: 'string' },
                title: { type: 'string' },
                meta_description: { type: 'string' },
                meta_keywords: { type: 'string' },
            },
            required: ['slug'],
        },
    },
    {
        name: 'ss_list_content',
        description: 'List site_content blocks. Optionally filter by page_slug or section.',
        inputSchema: {
            type: 'object',
            properties: {
                page_slug: { type: 'string', description: 'Filter by page slug' },
                section: { type: 'string', description: 'Filter by section name' },
            },
        },
    },
    {
        name: 'ss_update_content',
        description: 'Update a single site_content block by its key. Creates it if it does not exist.',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string', description: 'Content key (data-content-key value)' },
                value: { type: 'string', description: 'New content value' },
            },
            required: ['key', 'value'],
        },
    },
    {
        name: 'ss_get_settings',
        description: 'Retrieve all site_settings key-value pairs',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'ss_update_setting',
        description: 'Upsert a single site_settings entry by key',
        inputSchema: {
            type: 'object',
            properties: {
                key: { type: 'string' },
                value: { type: 'string' },
            },
            required: ['key', 'value'],
        },
    },
    {
        name: 'ss_list_site_pages',
        description: 'List site_pages navigation config (visibility, sort order, nav labels)',
        inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
        name: 'ss_update_site_page',
        description: 'Toggle nav visibility, update sort order, or rename nav label for a page by slug',
        inputSchema: {
            type: 'object',
            properties: {
                slug: { type: 'string' },
                nav_visible: { type: 'boolean' },
                sort_order: { type: 'number' },
                nav_label: { type: 'string' },
            },
            required: ['slug'],
        },
    },
    {
        name: 'ss_schema_inspect',
        description: 'Run PRAGMA table_info on any shinshu-solutions D1 table to inspect its schema',
        inputSchema: {
            type: 'object',
            properties: {
                table: {
                    type: 'string',
                    description: 'Table name, e.g. "pages", "site_content", "site_settings"',
                },
            },
            required: ['table'],
        },
    },
];

// ─── MCP Tool Executor ────────────────────────────────────────────────────────

async function executeTool(
    name: string,
    args: Record<string, unknown>,
    db: D1Database
): Promise<unknown> {
    switch (name) {

        case 'ss_list_pages': {
            const { results } = await db.prepare(
                'SELECT id, slug, title, meta_description FROM pages ORDER BY sort_order ASC, id ASC'
            ).all();
            return results;
        }

        case 'ss_get_page': {
            const slug = args.slug as string;
            const page = await db
                .prepare('SELECT * FROM pages WHERE slug = ?')
                .bind(slug)
                .first();
            if (!page) return { error: `Page not found: ${slug}` };

            const { results: content } = await db
                .prepare('SELECT * FROM site_content WHERE page_slug = ? ORDER BY section, key')
                .bind(slug)
                .all();
            return { page, content };
        }

        case 'ss_update_page_meta': {
            const { slug, title, meta_description, meta_keywords } = args as Record<string, string>;
            const fields: string[] = [];
            const bindings: unknown[] = [];

            if (title !== undefined) { fields.push('title = ?'); bindings.push(title); }
            if (meta_description !== undefined) { fields.push('meta_description = ?'); bindings.push(meta_description); }
            if (meta_keywords !== undefined) { fields.push('meta_keywords = ?'); bindings.push(meta_keywords); }

            if (!fields.length) return { error: 'No fields to update' };
            bindings.push(Date.now(), slug);

            await db
                .prepare(`UPDATE pages SET ${fields.join(', ')}, updated_at = ? WHERE slug = ?`)
                .bind(...bindings)
                .run();
            return { success: true, slug, updated: fields.map(f => f.split(' ')[0]) };
        }

        case 'ss_list_content': {
            const { page_slug, section } = args as Record<string, string | undefined>;
            let sql = 'SELECT * FROM site_content';
            const clauses: string[] = [];
            const bindings: unknown[] = [];

            if (page_slug) { clauses.push('page_slug = ?'); bindings.push(page_slug); }
            if (section) { clauses.push('section = ?'); bindings.push(section); }
            if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
            sql += ' ORDER BY page_slug, section, key';

            const { results } = await db.prepare(sql).bind(...bindings).all();
            return results;
        }

        case 'ss_update_content': {
            const { key, value } = args as { key: string; value: string };
            await db
                .prepare(
                    'INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?) ' +
                    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
                )
                .bind(key, value, Date.now())
                .run();
            return { success: true, key };
        }

        case 'ss_get_settings': {
            const { results } = await db.prepare('SELECT * FROM site_settings').all();
            const map: Record<string, unknown> = {};
            results?.forEach((r: any) => { map[r.key] = r.value; });
            return map;
        }

        case 'ss_update_setting': {
            const { key, value } = args as { key: string; value: string };
            await db
                .prepare(
                    'INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?) ' +
                    'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
                )
                .bind(key, value, Date.now())
                .run();
            return { success: true, key };
        }

        case 'ss_list_site_pages': {
            const { results } = await db
                .prepare('SELECT * FROM site_pages ORDER BY sort_order ASC, id ASC')
                .all();
            return results;
        }

        case 'ss_update_site_page': {
            const { slug, nav_visible, sort_order, nav_label } = args as {
                slug: string;
                nav_visible?: boolean;
                sort_order?: number;
                nav_label?: string;
            };
            const fields: string[] = [];
            const bindings: unknown[] = [];

            if (nav_visible !== undefined) { fields.push('nav_visible = ?'); bindings.push(nav_visible ? 1 : 0); }
            if (sort_order !== undefined) { fields.push('sort_order = ?'); bindings.push(sort_order); }
            if (nav_label !== undefined) { fields.push('nav_label = ?'); bindings.push(nav_label); }

            if (!fields.length) return { error: 'No fields to update' };
            bindings.push(Date.now(), slug);

            await db
                .prepare(`UPDATE site_pages SET ${fields.join(', ')}, updated_at = ? WHERE slug = ?`)
                .bind(...bindings)
                .run();
            return { success: true, slug, updated: fields.map(f => f.split(' ')[0]) };
        }

        case 'ss_schema_inspect': {
            const table = (args.table as string).replace(/[^a-zA-Z0-9_]/g, '');
            const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
            return results;
        }

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

// ─── MCP JSON-RPC helpers ─────────────────────────────────────────────────────

function rpcOk(id: string | number | null, result: unknown) {
    return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, result }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}

function rpcErr(id: string | number | null, code: number, message: string) {
    return new Response(
        JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
}

// ─── MCP Endpoint ─────────────────────────────────────────────────────────────

// OPTIONS — CORS preflight (for dashboard fetch calls)
app.options('/mcp', (c) => {
    return new Response(null, {
        status: 204,
        headers: {
            'Access-Control-Allow-Origin': 'https://dashboard.shinshusolutions.com',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
    });
});

app.post('/mcp', async (c) => {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

    if (!c.env.MCP_SECRET || token !== c.env.MCP_SECRET) {
        return new Response(
            JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }),
            { status: 401, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // ── Parse ─────────────────────────────────────────────────────────────────
    let rpc: JsonRpcRequest;
    try {
        rpc = await c.req.json<JsonRpcRequest>();
    } catch {
        return rpcErr(null, -32700, 'Parse error');
    }

    const { id, method, params = {} } = rpc;

    // ── Dispatch ──────────────────────────────────────────────────────────────
    try {
        switch (method) {

            // Handshake
            case 'initialize':
                return rpcOk(id, {
                    protocolVersion: '2024-11-05',
                    serverInfo: { name: 'shinshu-solutions-mcp', version: '1.0.0' },
                    capabilities: { tools: {} },
                });

            // Tool list
            case 'tools/list':
                return rpcOk(id, { tools: MCP_TOOLS });

            // Tool call
            case 'tools/call': {
                const toolName = params.name as string;
                const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

                if (!toolName) return rpcErr(id, -32602, 'Missing tool name');

                const result = await executeTool(toolName, toolArgs, c.env.DB);

                return rpcOk(id, {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                });
            }

            default:
                return rpcErr(id, -32601, `Method not found: ${method}`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Internal error';
        console.error(`MCP tool error [${method}]:`, err);
        return rpcErr(id, -32603, msg);
    }
});

// ─── Health / DB / R2 diagnostics ─────────────────────────────────────────────

app.get('/api/health', (c) =>
    c.json({ status: 'healthy', environment: c.env.ENVIRONMENT || 'production', timestamp: new Date().toISOString() })
);

app.get('/api/db-test', async (c) => {
    try {
        const result = await c.env.DB.prepare('SELECT 1 as test').first();
        return c.json({ success: true, database: 'connected', result });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
});

app.get('/api/r2-test', async (c) => {
    try {
        const listed = await c.env.R2.list({ limit: 10 });
        return c.json({
            success: true,
            storage: 'connected',
            objectCount: listed.objects.length,
            objects: listed.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
        });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
});

// ─── Gallery ──────────────────────────────────────────────────────────────────

app.get('/api/gallery/images', async (c) => {
    try {
        const listed = await c.env.R2.list({ limit: 1000 });
        const images = listed.objects
            .filter(o => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(o.key))
            .map(o => ({
                key: o.key,
                url: `https://shinshusolutions.com/${o.key}`,
                size: o.size,
                uploaded: o.uploaded,
            }));
        return c.json({ success: true, count: images.length, images });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
});

// ─── Contact ──────────────────────────────────────────────────────────────────

app.post('/api/contact', async (c) => {
    try {
        const { name, email, message } = await c.req.json();
        if (!name || !email || !message)
            return c.json({ success: false, error: 'All fields are required' }, 400);

        const id = crypto.randomUUID();
        const timestamp = Date.now();
        await c.env.DB.prepare(
            'INSERT INTO inbox_messages (id, name, email, message, received_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, name, email, message, timestamp).run();

        const emailHeaders = {
            'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
        };

        await fetch('https://api.resend.com/emails', {
            method: 'POST', headers: emailHeaders,
            body: JSON.stringify({
                from: c.env.RESEND_FROM_EMAIL,
                to: 'jawaalk@shinshusolutions.com',
                reply_to: email,
                subject: `New Contact: ${name}`,
                html: `<h2>New Message from ${name}</h2><p><strong>Email:</strong> ${email}</p><p><strong>Message:</strong></p><blockquote style="background:#f9f9f9;padding:15px;border-left:4px solid #FF8C42;">${message.replace(/\n/g, '<br>')}</blockquote>`,
            }),
        });

        await fetch('https://api.resend.com/emails', {
            method: 'POST', headers: emailHeaders,
            body: JSON.stringify({
                from: c.env.RESEND_FROM_EMAIL,
                to: email,
                subject: `We received your message - Shinshu Solutions`,
                html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;"><img src="https://pub-c341cc62c3274ccba5aa77286b26fb90.r2.dev/iconography/shinshu-solutions-icon.png" width="80" alt="Shinshu Solutions" style="margin-bottom:20px;"><h2 style="color:#FF8C42;">Thank you for contacting us, ${name}!</h2><p>We have received your message and will get back to you shortly.</p><p>For urgent inquiries, please contact us directly at <a href="mailto:jawaalk@shinshusolutions.com">jawaalk@shinshusolutions.com</a>.</p><hr style="border:0;border-top:1px solid #eee;margin:20px 0;"><p style="color:#666;font-size:0.9rem;">Shinshu Solutions<br>Nagano, Japan</p></div>`,
            }),
        });

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
        const assets = listed.objects.map(o => ({
            key: o.key,
            url: `https://shinshusolutions.com/${o.key}`,
            size: o.size,
            uploaded: o.uploaded,
            type: getContentType(o.key),
        }));
        return c.json({ success: true, assets });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Error listing assets' }, 500);
    }
});

app.delete('/api/assets/:key', async (c) => {
    try {
        await c.env.R2.delete(c.req.param('key'));
        return c.json({ success: true, message: 'Asset deleted' });
    } catch {
        return c.json({ success: false, error: 'Delete failed' }, 500);
    }
});

app.post('/api/assets/upload', async (c) => {
    try {
        const body = await c.req.parseBody();
        const file = body['file'];
        if (!file || !(file instanceof File))
            return c.json({ success: false, error: 'No file uploaded' }, 400);

        const buffer = await file.arrayBuffer();
        await c.env.R2.put(file.name, buffer, { httpMetadata: { contentType: file.type } });
        return c.json({ success: true, key: file.name, url: `https://shinshusolutions.com/${file.name}` });
    } catch (error) {
        console.error('Upload error:', error);
        return c.json({ success: false, error: 'Upload failed' }, 500);
    }
});

app.get('/api/content', async (c) => {
    try {
        const { results } = await c.env.DB.prepare('SELECT * FROM site_content').all();
        const contentMap: Record<string, string> = {};
        results?.forEach((row: any) => { contentMap[row.key] = row.value; });
        return c.json({ success: true, content: contentMap });
    } catch {
        return c.json({ success: false, error: 'Failed to fetch content' }, 500);
    }
});

app.post('/api/content', async (c) => {
    try {
        const { updates } = await c.req.json();
        if (!updates) return c.json({ success: false, error: 'No updates provided' }, 400);

        const stmt = c.env.DB.prepare(
            'INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?) ' +
            'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
        );
        const now = Date.now();
        const batch = Object.entries(updates).map(([k, v]) => stmt.bind(k, v, now));
        await c.env.DB.batch(batch);
        return c.json({ success: true, message: 'Content updated' });
    } catch {
        return c.json({ success: false, error: 'Update failed' }, 500);
    }
});

app.get('/api/messages', async (c) => {
    try {
        const { results } = await c.env.DB.prepare(
            'SELECT * FROM inbox_messages ORDER BY received_at DESC'
        ).all();
        return c.json({ success: true, messages: results });
    } catch {
        return c.json({ success: false, error: 'Failed to fetch messages' }, 500);
    }
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (c) => {
    try {
        const { email, password } = await c.req.json();
        if (!email || !password)
            return c.json({ success: false, error: 'Email and password are required' }, 400);

        const user = await authenticateUser(c.env.DB, email, password);
        if (!user)
            return c.json({ success: false, error: 'Invalid email or password' }, 401);

        const sessionId = await createSession(c.env.DB, user.id);
        setCookie(c, 'session_id', sessionId, {
            httpOnly: true, secure: true, sameSite: 'Lax',
            maxAge: 7 * 24 * 60 * 60, path: '/',
        });
        return c.json({ success: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (error) {
        console.error('Login error:', error);
        return c.json({ success: false, error: 'Authentication failed' }, 500);
    }
});

app.post('/api/auth/logout', async (c) => {
    try {
        const sessionId = getCookie(c, 'session_id');
        if (sessionId) await deleteSession(c.env.DB, sessionId);
        deleteCookie(c, 'session_id', { path: '/' });
        return c.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        return c.json({ success: false, error: 'Logout failed' }, 500);
    }
});

app.get('/api/auth/me', async (c) => {
    try {
        const sessionId = getCookie(c, 'session_id');
        if (!sessionId)
            return c.json({ success: false, error: 'Not authenticated' }, 401);

        const user = await getUserBySession(c.env.DB, sessionId);
        if (!user) {
            deleteCookie(c, 'session_id', { path: '/' });
            return c.json({ success: false, error: 'Session expired' }, 401);
        }
        return c.json({ success: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
    } catch (error) {
        console.error('Session check error:', error);
        return c.json({ success: false, error: 'Session check failed' }, 500);
    }
});

// ─── Catch-all: serve from R2 ─────────────────────────────────────────────────

app.get('*', async (c) => {
    const path = c.req.path;

    if (path.startsWith('/api/'))
        return c.json({ error: 'API endpoint not found' }, 404);

    const r2Response = await serveFromR2(c.env.R2, path, 'index.html', c.env.DB);
    if (r2Response) return r2Response;

    const notFoundPage = await serveFromR2(c.env.R2, '404.html', 'index.html', c.env.DB);
    if (notFoundPage) {
        return new Response(notFoundPage.body, { status: 404, headers: notFoundPage.headers });
    }

    return c.html(
        `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - Page Not Found | Shinshu Solutions</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .container{background:white;border-radius:20px;padding:60px 40px;max-width:600px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.3)}
    h1{font-size:4rem;color:#667eea;margin-bottom:20px}
    p{color:#4a5568;font-size:1.2rem;margin-bottom:30px}
    a{display:inline-block;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:15px 30px;border-radius:50px;text-decoration:none;font-weight:600;transition:transform .3s ease}
    a:hover{transform:translateY(-2px)}
  </style>
</head><body>
  <div class="container">
    <h1>404</h1>
    <p>Page not found</p>
    <p style="font-size:1rem;margin-bottom:30px">The page you're looking for doesn't exist.</p>
    <a href="/">Return Home</a>
  </div>
</body></html>`,
        404
    );
});

export default app;
