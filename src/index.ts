import { Hono } from 'hono';

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

const app = new Hono<{ Bindings: Env }>();

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
async function serveFromR2(
    r2: R2Bucket,
    path: string,
    defaultFile: string = 'index.html'
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

        // Return the response
        return new Response(object.body, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=3600',
                'ETag': object.httpEtag || '',
            },
        });
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

// Catch-all route for serving pages from R2
app.get('*', async (c) => {
    const path = c.req.path;

    // Skip API routes
    if (path.startsWith('/api/')) {
        return c.json({ error: 'API endpoint not found' }, 404);
    }

    // Try to serve from R2
    const r2Response = await serveFromR2(c.env.R2, path);

    if (r2Response) {
        return r2Response;
    }

    // If not found, try to serve 404.html from R2
    const notFoundPage = await serveFromR2(c.env.R2, '404.html');

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
