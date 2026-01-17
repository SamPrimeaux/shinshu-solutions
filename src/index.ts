import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { authenticateUser, createSession, getUserBySession, deleteSession } from './auth';

// Define environment bindings
interface Env {
    DB: D1Database;
    R2: R2Bucket;
    CLOUDFLARE_API_TOKEN: string;
    RESEND_API_KEY: string;
    RESEND_SIGNING_SECRET: string;
    RESEND_FROM_EMAIL: string;
    ENVIRONMENT: string;
}

type Variables = {
    user?: {
        id: string;
        email: string;
        name: string;
        role: string;
    };
};

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// Content-Type mapping for common file extensions
const CONTENT_TYPES: Record<string, string> = {
    'html': 'text/html; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'js': 'application/javascript; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'webp': 'image/webp',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'eot': 'application/vnd.ms-fontobject',
    'pdf': 'application/pdf',
    'xml': 'application/xml',
    'txt': 'text/plain; charset=utf-8',
};

// Helper function to get content type from filename
function getContentType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    return CONTENT_TYPES[ext] || 'application/octet-stream';
}

// Helper function to serve files from R2
// Helper function to serve files from R2 with optional content injection
async function serveFromR2(
    r2: R2Bucket,
    path: string,
    defaultFile: string = 'index.html',
    db?: D1Database
): Promise<Response | null> {
    try {
        // Clean the path
        let cleanPath = path.replace(/^\/+/, '').replace(/\/+$/, '');

        // If path is empty or ends with /, append default file
        if (!cleanPath || cleanPath.endsWith('/')) {
            cleanPath = cleanPath + defaultFile;
        }

        // If no extension, try adding .html
        if (!cleanPath.includes('.')) {
            cleanPath = cleanPath + '.html';
        }

        console.log(`Attempting to fetch from R2: ${cleanPath}`);

        // Try to get the object from R2
        const object = await r2.get(cleanPath);

        if (!object) {
            console.log(`Object not found in R2: ${cleanPath}`);
            return null;
        }

        // Get content type
        const contentType = object.httpMetadata?.contentType || getContentType(cleanPath);
        const headers = {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=3600',
            'ETag': object.httpEtag || '',
        };

        // If HTML and DB provided, inject content
        if (contentType.includes('text/html') && db) {
            let text = await object.text();

            try {
                const { results } = await db.prepare('SELECT * FROM site_content').all();
                if (results && results.length > 0) {
                    results.forEach((row: any) => {
                        // Regex to replace content of element with data-content-key="KEY"
                        // Robust regex covering attributes before/after, and any tag
                        const key = row.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape regex chars
                        const regex = new RegExp(`(<[^>]+data-content-key=["']${key}["'][^>]*>)([^<]*)(</[^>]+>)`, 'g');
                        text = text.replace(regex, `$1${row.value}$3`);
                    });
                }
            } catch (e) { console.error('Error injecting content:', e); }

            return new Response(text, { headers });
        }

        // Return stream for non-HTML
        return new Response(object.body, { headers });
    } catch (error) {
        console.error('Error serving from R2:', error);
        return null;
    }
}

// Health check endpoint
app.get('/api/health', (c) => {
    return c.json({
        status: 'healthy',
        environment: c.env.ENVIRONMENT || 'production',
        timestamp: new Date().toISOString(),
    });
});

// Database test endpoint
app.get('/api/db-test', async (c) => {
    try {
        const result = await c.env.DB.prepare('SELECT 1 as test').first();
        return c.json({
            success: true,
            database: 'connected',
            result,
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        }, 500);
    }
});

// R2 test endpoint - list objects
app.get('/api/r2-test', async (c) => {
    try {
        const listed = await c.env.R2.list({ limit: 10 });
        return c.json({
            success: true,
            storage: 'connected',
            objectCount: listed.objects.length,
            objects: listed.objects.map(obj => ({
                key: obj.key,
                size: obj.size,
                uploaded: obj.uploaded,
            })),
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        }, 500);
    }
});

// Gallery images endpoint - list all images from R2
app.get('/api/gallery/images', async (c) => {
    try {
        const listed = await c.env.R2.list({ limit: 1000 });

        // Filter for image files
        const images = listed.objects
            .filter(obj => /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(obj.key))
            .map(obj => ({
                key: obj.key,
                url: `https://shinshusolutions.com/${obj.key}`,
                size: obj.size,
                uploaded: obj.uploaded,
            }));

        return c.json({
            success: true,
            count: images.length,
            images,
        });
    } catch (error) {
        return c.json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        }, 500);
    }
});

// Contact form endpoint - send email via Resend
// Contact form endpoint - send email via Resend and save to DB
app.post('/api/contact', async (c) => {
    try {
        const { name, email, message } = await c.req.json();

        if (!name || !email || !message) {
            return c.json({ success: false, error: 'All fields are required' }, 400);
        }

        // 1. Save to DB
        const id = crypto.randomUUID();
        const timestamp = Date.now();
        await c.env.DB.prepare(
            'INSERT INTO inbox_messages (id, name, email, message, received_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(id, name, email, message, timestamp).run();

        // 2. Send email to Admin via Resend
        await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: c.env.RESEND_FROM_EMAIL,
                to: 'jawaalk@shinshusolutions.com',
                reply_to: email, // Direct reply
                subject: `New Contact: ${name}`,
                html: `
                    <h2>New Message from ${name}</h2>
                    <p><strong>Email:</strong> ${email}</p>
                    <p><strong>Message:</strong></p>
                    <blockquote style="background: #f9f9f9; padding: 15px; border-left: 4px solid #FF8C42;">${message.replace(/\n/g, '<br>')}</blockquote>
                `,
            }),
        });

        // 3. Send Auto-Reply to Client
        await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                from: c.env.RESEND_FROM_EMAIL,
                to: email,
                subject: `We received your message - Shinshu Solutions`,
                html: `
                    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                        <img src="https://pub-c341cc62c3274ccba5aa77286b26fb90.r2.dev/iconography/shinshu-solutions-icon.png" width="80" alt="Shinshu Solutions" style="margin-bottom: 20px;">
                        <h2 style="color: #FF8C42;">Thank you for contacting us, ${name}!</h2>
                        <p>We have received your message and will get back to you shortly.</p>
                        <p>For urgent inquiries, please contact us directly at <a href="mailto:jawaalk@shinshusolutions.com">jawaalk@shinshusolutions.com</a>.</p>
                        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                        <p style="color: #666; font-size: 0.9rem;">Shinshu Solutions<br>Nagano, Japan</p>
                    </div>
                `,
            }),
        });

        return c.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Contact form error:', error);
        return c.json({ success: false, error: 'Failed to send message' }, 500);
    }
});

// --- DASHBOARD APIs ---

// 1. Assets Management (True CRUD)
app.get('/api/assets', async (c) => {
    try {
        // List ALL objects (up to 1000)
        const listed = await c.env.R2.list({ limit: 1000 });

        const assets = listed.objects.map(obj => ({
            key: obj.key,
            url: `https://shinshusolutions.com/${obj.key}`, // Assuming public access or worker routing
            size: obj.size,
            uploaded: obj.uploaded,
            type: getContentType(obj.key)
        }));

        return c.json({ success: true, assets });
    } catch (error) {
        return c.json({ success: false, error: error instanceof Error ? error.message : 'Error listing assets' }, 500);
    }
});

app.delete('/api/assets/:key', async (c) => {
    try {
        const key = c.req.param('key');
        // Prevent deleting critical system files if needed, but for now allow all
        await c.env.R2.delete(key);
        return c.json({ success: true, message: 'Asset deleted' });
    } catch (error) {
        return c.json({ success: false, error: 'Delete failed' }, 500);
    }
});

app.post('/api/assets/upload', async (c) => {
    try {
        const body = await c.req.parseBody();
        const file = body['file']; // Expecting 'file' field

        if (!file || !(file instanceof File)) {
            return c.json({ success: false, error: 'No file uploaded' }, 400);
        }

        const buffer = await file.arrayBuffer();
        const key = file.name; // Or generate random name

        // Upload to R2
        await c.env.R2.put(key, buffer, {
            httpMetadata: { contentType: file.type }
        });

        return c.json({ success: true, key, url: `https://shinshusolutions.com/${key}` });
    } catch (error) {
        console.error('Upload error:', error);
        return c.json({ success: false, error: 'Upload failed' }, 500);
    }
});

// 2. Content Management (Site Content)
app.get('/api/content', async (c) => {
    try {
        const { results } = await c.env.DB.prepare('SELECT * FROM site_content').all();
        // Convert array to object for easier frontend consumption { key: value }
        const contentMap: Record<string, string> = {};
        if (results) {
            results.forEach((row: any) => {
                contentMap[row.key] = row.value;
            });
        }
        return c.json({ success: true, content: contentMap });
    } catch (error) {
        return c.json({ success: false, error: 'Failed to fetch content' }, 500);
    }
});

app.post('/api/content', async (c) => {
    try {
        const { updates } = await c.req.json(); // Expecting { updates: { key: value, key2: value2 } }

        if (!updates) return c.json({ success: false, error: 'No updates provided' }, 400);

        const stmt = c.env.DB.prepare('INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at');
        const batch = [];
        const now = Date.now();

        for (const [key, value] of Object.entries(updates)) {
            batch.push(stmt.bind(key, value, now));
        }

        await c.env.DB.batch(batch);
        return c.json({ success: true, message: 'Content updated' });
    } catch (error) {
        return c.json({ success: false, error: 'Update failed' }, 500);
    }
});

// 3. Messages (Inbox)
app.get('/api/messages', async (c) => {
    try {
        const { results } = await c.env.DB.prepare('SELECT * FROM inbox_messages ORDER BY received_at DESC').all();
        return c.json({ success: true, messages: results });
    } catch (error) {
        return c.json({ success: false, error: 'Failed to fetch messages' }, 500);
    }
});



// Authentication: Login endpoint
app.post('/api/auth/login', async (c) => {
    try {
        const { email, password } = await c.req.json();

        if (!email || !password) {
            return c.json({ success: false, error: 'Email and password are required' }, 400);
        }

        // Authenticate user
        const user = await authenticateUser(c.env.DB, email, password);

        if (!user) {
            return c.json({ success: false, error: 'Invalid email or password' }, 401);
        }

        // Create session
        const sessionId = await createSession(c.env.DB, user.id);

        // Set session cookie (7 days)
        setCookie(c, 'session_id', sessionId, {
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
            maxAge: 7 * 24 * 60 * 60, // 7 days
            path: '/',
        });

        return c.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
            },
        });
    } catch (error) {
        console.error('Login error:', error);
        return c.json({ success: false, error: 'Authentication failed' }, 500);
    }
});

// Authentication: Logout endpoint
app.post('/api/auth/logout', async (c) => {
    try {
        const sessionId = getCookie(c, 'session_id');

        if (sessionId) {
            await deleteSession(c.env.DB, sessionId);
        }

        deleteCookie(c, 'session_id', { path: '/' });

        return c.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        console.error('Logout error:', error);
        return c.json({ success: false, error: 'Logout failed' }, 500);
    }
});

// Authentication: Check session endpoint
app.get('/api/auth/me', async (c) => {
    try {
        const sessionId = getCookie(c, 'session_id');

        if (!sessionId) {
            return c.json({ success: false, error: 'Not authenticated' }, 401);
        }

        const user = await getUserBySession(c.env.DB, sessionId);

        if (!user) {
            deleteCookie(c, 'session_id', { path: '/' });
            return c.json({ success: false, error: 'Session expired' }, 401);
        }

        return c.json({
            success: true,
            user: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role,
            },
        });
    } catch (error) {
        console.error('Session check error:', error);
        return c.json({ success: false, error: 'Session check failed' }, 500);
    }
});


// Catch-all route for serving pages from R2
app.get('*', async (c) => {
    const path = c.req.path;

    // Skip API routes
    if (path.startsWith('/api/')) {
        return c.json({ error: 'API endpoint not found' }, 404);
    }

    // Try to serve from R2 (with content injection)
    const r2Response = await serveFromR2(c.env.R2, path, 'index.html', c.env.DB);

    if (r2Response) {
        return r2Response;
    }

    // If not found, try to serve 404.html from R2
    const notFoundPage = await serveFromR2(c.env.R2, '404.html', 'index.html', c.env.DB);

    if (notFoundPage) {
        return new Response(notFoundPage.body, {
            status: 404,
            headers: notFoundPage.headers,
        });
    }

    // Fallback 404 response
    return c.html(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>404 - Page Not Found | Shinshu Solutions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 20px;
      padding: 60px 40px;
      max-width: 600px;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    }
    h1 { font-size: 4rem; color: #667eea; margin-bottom: 20px; }
    p { color: #4a5568; font-size: 1.2rem; margin-bottom: 30px; }
    a {
      display: inline-block;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 15px 30px;
      border-radius: 50px;
      text-decoration: none;
      font-weight: 600;
      transition: transform 0.3s ease;
    }
    a:hover { transform: translateY(-2px); }
  </style>
</head>
<body>
  <div class="container">
    <h1>404</h1>
    <p>Page not found</p>
    <p style="font-size: 1rem; margin-bottom: 30px;">The page you're looking for doesn't exist.</p>
    <a href="/">Return Home</a>
  </div>
</body>
</html>`,
        404
    );
});

export default app;
