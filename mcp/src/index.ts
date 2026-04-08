// shinshu-solutions-mcp — standalone Cloudflare Worker
// Zero deps. Protocol: MCP over JSON-RPC 2.0. Auth: Bearer MCP_SECRET

interface Env {
    DB: D1Database;
    R2: R2Bucket;
    MCP_SECRET: string;
    ENVIRONMENT: string;
    TENANT_ID: string;
    CLIENT_ID: string;
    GITHUB_TOKEN: string;
    RESEND_API_KEY: string;
    RESEND_FROM_EMAIL: string;
}
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
const CORS = {
    'Access-Control-Allow-Origin': 'https://dashboard.shinshusolutions.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const TOOLS: ToolDef[] = [
    { name: 'ss_list_pages', description: 'List all pages', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'ss_get_page', description: 'Get page + content blocks by slug', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
    { name: 'ss_update_page_meta', description: 'Patch title/meta_description/meta_keywords by slug', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, title: { type: 'string' }, meta_description: { type: 'string' }, meta_keywords: { type: 'string' } }, required: ['slug'] } },
    { name: 'ss_list_content', description: 'List site_content blocks, filter by page_slug/section', inputSchema: { type: 'object', properties: { page_slug: { type: 'string' }, section: { type: 'string' } } } },
    { name: 'ss_update_content', description: 'Upsert a content block by key', inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
    { name: 'ss_bulk_update_content', description: 'Batch upsert content blocks', inputSchema: { type: 'object', properties: { updates: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['updates'] } },
    { name: 'ss_get_settings', description: 'Get all site_settings', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'ss_update_setting', description: 'Upsert a site setting', inputSchema: { type: 'object', properties: { key: { type: 'string' }, value: { type: 'string' } }, required: ['key', 'value'] } },
    { name: 'ss_list_site_pages', description: 'List nav config', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'ss_update_site_page', description: 'Update nav visibility/order/label', inputSchema: { type: 'object', properties: { slug: { type: 'string' }, nav_visible: { type: 'boolean' }, sort_order: { type: 'number' }, nav_label: { type: 'string' } }, required: ['slug'] } },
    { name: 'ss_schema_inspect', description: 'PRAGMA table_info for any table', inputSchema: { type: 'object', properties: { table: { type: 'string' } }, required: ['table'] } },
    { name: 'ss_list_r2_assets', description: 'List R2 objects', inputSchema: { type: 'object', properties: { prefix: { type: 'string' }, limit: { type: 'number' } } } },
    { name: 'ss_list_mcp_tools', description: 'List all MCP tools including inactive', inputSchema: { type: 'object', properties: {}, required: [] } },
    { name: 'ss_toggle_mcp_tool', description: 'Enable/disable a tool by name', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, active: { type: 'boolean' } }, required: ['tool_name', 'active'] } },
    { name: 'ss_search_knowledge', description: 'Search agent_knowledge', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'ss_add_knowledge', description: 'Add a row to agent_knowledge', inputSchema: { type: 'object', properties: { topic: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['topic', 'title', 'content'] } },
];
async function runTool(name: string, args: Record<string, unknown>, env: Env): Promise<unknown> {
    const db = env.DB;
    switch (name) {
        case 'ss_list_pages': { const { results } = await db.prepare('SELECT id,slug,title,meta_description,sort_order FROM pages ORDER BY sort_order ASC,id ASC').all(); return results; }
        case 'ss_get_page': { const slug = args.slug as string; const page = await db.prepare('SELECT * FROM pages WHERE slug=?').bind(slug).first(); if (!page) return { error: `Not found: ${slug}` }; const { results: content } = await db.prepare('SELECT * FROM site_content WHERE page_slug=? ORDER BY section,key').bind(slug).all(); return { page, content }; }
        case 'ss_update_page_meta': { const { slug, title, meta_description, meta_keywords } = args as Record<string, string>; const f: string[] = []; const v: unknown[] = []; if (title !== undefined) { f.push('title=?'); v.push(title); } if (meta_description !== undefined) { f.push('meta_description=?'); v.push(meta_description); } if (meta_keywords !== undefined) { f.push('meta_keywords=?'); v.push(meta_keywords); } if (!f.length) return { error: 'No fields' }; v.push(Date.now(), slug); await db.prepare(`UPDATE pages SET ${f.join(',')},updated_at=? WHERE slug=?`).bind(...v).run(); return { success: true, slug }; }
        case 'ss_list_content': { const { page_slug, section } = args as Record<string, string | undefined>; const c: string[] = []; const v: unknown[] = []; if (page_slug) { c.push('page_slug=?'); v.push(page_slug); } if (section) { c.push('section=?'); v.push(section); } const w = c.length ? ' WHERE ' + c.join(' AND ') : ''; const { results } = await db.prepare(`SELECT * FROM site_content${w} ORDER BY page_slug,section,key`).bind(...v).all(); return results; }
        case 'ss_update_content': { const { key, value } = args as { key: string; value: string }; await db.prepare('INSERT INTO site_content (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key, value, Date.now()).run(); return { success: true, key }; }
        case 'ss_bulk_update_content': { const updates = args.updates as Record<string, string>; const entries = Object.entries(updates); if (!entries.length) return { error: 'No updates' }; const stmt = db.prepare('INSERT INTO site_content (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at'); await db.batch(entries.map(([k, v]) => stmt.bind(k, v, Date.now()))); return { success: true, updated: entries.map(([k]) => k) }; }
        case 'ss_get_settings': { const { results } = await db.prepare('SELECT * FROM site_settings').all(); const map: Record<string, unknown> = {}; results?.forEach((r: any) => { map[r.key] = r.value; }); return map; }
        case 'ss_update_setting': { const { key, value } = args as { key: string; value: string }; await db.prepare('INSERT INTO site_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(key, value, Date.now()).run(); return { success: true, key }; }
        case 'ss_list_site_pages': { const { results } = await db.prepare('SELECT * FROM site_pages ORDER BY sort_order ASC,id ASC').all(); return results; }
        case 'ss_update_site_page': { const { slug, nav_visible, sort_order, nav_label } = args as { slug: string; nav_visible?: boolean; sort_order?: number; nav_label?: string }; const f: string[] = []; const v: unknown[] = []; if (nav_visible !== undefined) { f.push('nav_visible=?'); v.push(nav_visible ? 1 : 0); } if (sort_order !== undefined) { f.push('sort_order=?'); v.push(sort_order); } if (nav_label !== undefined) { f.push('nav_label=?'); v.push(nav_label); } if (!f.length) return { error: 'No fields' }; v.push(Date.now(), slug); await db.prepare(`UPDATE site_pages SET ${f.join(',')},updated_at=? WHERE slug=?`).bind(...v).run(); return { success: true, slug }; }
        case 'ss_schema_inspect': { const table = (args.table as string).replace(/[^a-zA-Z0-9_]/g, ''); const { results } = await db.prepare(`PRAGMA table_info(${table})`).all(); return results; }
        case 'ss_list_r2_assets': { const prefix = args.prefix as string | undefined; const limit = Math.min(Number(args.limit ?? 100), 1000); const opts: R2ListOptions = { limit }; if (prefix) opts.prefix = prefix; const listed = await env.R2.list(opts); return listed.objects.map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded })); }
        case 'ss_list_mcp_tools': { const { results } = await db.prepare("SELECT id,name,description,category,is_active FROM mcp_tools WHERE server_id='mcp_site' ORDER BY category,name").all(); return results; }
        case 'ss_toggle_mcp_tool': { const { tool_name, active } = args as { tool_name: string; active: boolean }; await db.prepare("UPDATE mcp_tools SET is_active=? WHERE name=? AND server_id='mcp_site'").bind(active ? 1 : 0, tool_name).run(); return { success: true, tool_name, is_active: active }; }
        case 'ss_search_knowledge': { const query = args.query as string; const { results } = await db.prepare('SELECT id,topic,title,content FROM agent_knowledge WHERE content LIKE ? OR title LIKE ? OR topic LIKE ? LIMIT 10').bind(`%${query}%`, `%${query}%`, `%${query}%`).all(); return results; }
        case 'ss_add_knowledge': { const { topic, title, content } = args as { topic: string; title: string; content: string }; await db.prepare('INSERT INTO agent_knowledge (topic,title,content) VALUES (?,?,?)').bind(topic, title, content).run(); return { success: true }; }
        default: throw new Error(`Unknown tool: ${name}`);
    }
}
function ok(id: string | number | null, result: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { headers: { 'Content-Type': 'application/json', ...CORS } });
}
function err(id: string | number | null, code: number, message: string, status = 200): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
}
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
        if (url.pathname === '/health' && request.method === 'GET') {
            return new Response(JSON.stringify({ status: 'ok', worker: 'shinshu-solutions-mcp', environment: env.ENVIRONMENT, tools: TOOLS.length, timestamp: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json', ...CORS } });
        }
        if (url.pathname !== '/mcp' || request.method !== 'POST') return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        const auth = request.headers.get('Authorization') ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!env.MCP_SECRET || token !== env.MCP_SECRET) return err(null, -32001, 'Unauthorized', 401);
        let rpc: JsonRpcRequest;
        try { rpc = await request.json<JsonRpcRequest>(); } catch { return err(null, -32700, 'Parse error'); }
        const { id = null, method, params = {} } = rpc;
        try {
            switch (method) {
                case 'initialize': return ok(id, { protocolVersion: '2024-11-05', serverInfo: { name: 'shinshu-solutions-mcp', version: '1.0.0' }, capabilities: { tools: {} } });
                case 'tools/list': return ok(id, { tools: TOOLS });
                case 'tools/call': {
                    const toolName = params.name as string | undefined;
                    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
                    if (!toolName) return err(id, -32602, 'Missing params.name');
                    const result = await runTool(toolName, toolArgs, env);
                    return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
                }
                default: return err(id, -32601, `Method not found: ${method}`);
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Internal error';
            console.error(`[MCP] ${method} error:`, e);
            return err(id, -32603, msg);
        }
    },
};

// ─── Gmail + GitHub tool implementations (append to runTool switch) ───────────
// Add these cases to the switch in runTool() before the default: throw line
// Copy each case block into the switch manually or via Cursor

/*
        case 'gmail_list_messages': {
            const token = args.oauth_token as string;
            const query = args.query as string ?? '';
            const limit = args.limit as number ?? 10;
            if (!token) return { error: 'oauth_token required — pass Google access token from session' };
            const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}${query ? `&q=${encodeURIComponent(query)}` : ''}`;
            const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
            const data: any = await res.json();
            if (!res.ok) return { error: data.error?.message ?? 'Gmail API error', status: res.status };
            const messages = data.messages ?? [];
            // Fetch snippet for each message
            const details = await Promise.all(messages.slice(0, 5).map(async (m: any) => {
                const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
                    { headers: { 'Authorization': `Bearer ${token}` } });
                const d: any = await r.json();
                const headers = d.payload?.headers ?? [];
                const get = (name: string) => headers.find((h: any) => h.name === name)?.value ?? '';
                return { id: m.id, subject: get('Subject'), from: get('From'), date: get('Date'), snippet: d.snippet };
            }));
            return { total: data.resultSizeEstimate, messages: details };
        }

        case 'gmail_send_message': {
            const token = args.oauth_token as string;
            const to = args.to as string;
            const subject = args.subject as string;
            const body = args.body as string;
            const html = args.html as boolean ?? false;
            if (!token) return { error: 'oauth_token required' };
            const contentType = html ? 'text/html' : 'text/plain';
            const raw = btoa(
                `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: ${contentType}; charset=utf-8\r\n\r\n${body}`
            ).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ raw }),
            });
            const data: any = await res.json();
            if (!res.ok) return { error: data.error?.message ?? 'Send failed', status: res.status };
            return { success: true, message_id: data.id, thread_id: data.threadId };
        }

        case 'gmail_get_message': {
            const token = args.oauth_token as string;
            const message_id = args.message_id as string;
            if (!token || !message_id) return { error: 'oauth_token and message_id required' };
            const res = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message_id}?format=full`,
                { headers: { 'Authorization': `Bearer ${token}` } }
            );
            const data: any = await res.json();
            if (!res.ok) return { error: data.error?.message ?? 'Fetch failed' };
            const headers = data.payload?.headers ?? [];
            const get = (name: string) => headers.find((h: any) => h.name === name)?.value ?? '';
            const getBody = (payload: any): string => {
                if (payload.body?.data) return atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
                if (payload.parts) return payload.parts.map((p: any) => getBody(p)).join('\n');
                return '';
            };
            return { id: data.id, subject: get('Subject'), from: get('From'), to: get('To'), date: get('Date'), body: getBody(data.payload), snippet: data.snippet };
        }

        case 'github_get_commits': {
            const repo = args.repo as string ?? 'shinshu-solutions';
            const branch = args.branch as string ?? 'main';
            const limit = args.limit as number ?? 10;
            const res = await fetch(
                `https://api.github.com/repos/SamPrimeaux/${repo}/commits?sha=${branch}&per_page=${limit}`,
                { headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'shinshu-solutions-mcp' } }
            );
            const data: any = await res.json();
            if (!res.ok) return { error: data.message ?? 'GitHub API error' };
            return data.map((c: any) => ({ sha: c.sha.slice(0, 7), message: c.commit.message, author: c.commit.author.name, date: c.commit.author.date }));
        }

        case 'github_get_actions': {
            const repo = args.repo as string ?? 'shinshu-solutions';
            const limit = args.limit as number ?? 5;
            const res = await fetch(
                `https://api.github.com/repos/SamPrimeaux/${repo}/actions/runs?per_page=${limit}`,
                { headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'shinshu-solutions-mcp' } }
            );
            const data: any = await res.json();
            if (!res.ok) return { error: data.message ?? 'GitHub API error' };
            return (data.workflow_runs ?? []).map((r: any) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, branch: r.head_branch, sha: r.head_sha.slice(0, 7), created_at: r.created_at, url: r.html_url }));
        }

        case 'github_get_file': {
            const repo = args.repo as string ?? 'shinshu-solutions';
            const path = args.path as string;
            const branch = args.branch as string ?? 'main';
            const res = await fetch(
                `https://api.github.com/repos/SamPrimeaux/${repo}/contents/${path}?ref=${branch}`,
                { headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'shinshu-solutions-mcp' } }
            );
            const data: any = await res.json();
            if (!res.ok) return { error: data.message ?? 'File not found' };
            const content = data.content ? atob(data.content.replace(/\n/g, '')) : '';
            return { path: data.path, size: data.size, sha: data.sha, content: content.slice(0, 5000) };
        }

        case 'github_create_issue': {
            const repo = args.repo as string ?? 'shinshu-solutions';
            const title = args.title as string;
            const body = args.body as string ?? '';
            const res = await fetch(
                `https://api.github.com/repos/SamPrimeaux/${repo}/issues`,
                { method: 'POST', headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'shinshu-solutions-mcp', 'Content-Type': 'application/json' },
                  body: JSON.stringify({ title, body }) }
            );
            const data: any = await res.json();
            if (!res.ok) return { error: data.message ?? 'Create issue failed' };
            return { success: true, number: data.number, url: data.html_url, title: data.title };
        }
*/
