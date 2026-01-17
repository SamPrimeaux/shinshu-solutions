import { Hono } from 'hono';

// Define environment bindings
interface Env {
    DB: D1Database;
    R2: R2Bucket;
    RESEND_API_TOKEN: string;
    RESEND_SIGNING_SECRET: string;
    RESEND_FROM_EMAIL: string;
    RESEND_ADMIN_EMAIL: string;
    ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Env }>();

// Root route
app.get('/', (c) => {
    return c.json({
        message: 'Welcome to Shinshu Solutions API',
        environment: c.env.ENVIRONMENT || 'development',
        timestamp: new Date().toISOString(),
    });
});

// Health check endpoint
app.get('/health', (c) => {
    return c.json({
        status: 'healthy',
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

// R2 test endpoint
app.get('/api/r2-test', async (c) => {
    try {
        const objects = await c.env.R2.list({ limit: 5 });
        return c.json({
            success: true,
            storage: 'connected',
            objectCount: objects.objects.length,
            objects: objects.objects.map(obj => ({
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

// Example API endpoint
app.get('/api/example', async (c) => {
    return c.json({
        message: 'This is an example API endpoint',
        data: {
            project: 'Shinshu Solutions',
            contact: c.env.RESEND_FROM_EMAIL,
        },
    });
});

// 404 handler
app.notFound((c) => {
    return c.json({
        error: 'Not Found',
        path: c.req.path,
    }, 404);
});

// Error handler
app.onError((err, c) => {
    console.error('Error:', err);
    return c.json({
        error: 'Internal Server Error',
        message: err.message,
    }, 500);
});

export default app;
