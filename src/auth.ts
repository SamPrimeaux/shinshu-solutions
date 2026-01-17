import bcrypt from 'bcryptjs';

export interface User {
    id: string; // TEXT in existing schema
    email: string;
    name: string; // 'name' not 'full_name' in existing schema
    role: string;
}

export interface Session {
    id: string;
    user_id: string; // TEXT to match user id
    expires_at: string;
}

// Generate a random session ID
export function generateSessionId(): string {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Hash password using bcrypt
export async function hashPassword(password: string): Promise<string> {
    const salt = await bcrypt.genSalt(10);
    return bcrypt.hash(password, salt);
}

// Verify password against hash
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
}

// Create a new session for a user
export async function createSession(db: D1Database, userId: string): Promise<string> {
    const sessionId = generateSessionId();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await db.prepare(
        'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ).bind(sessionId, userId, expiresAt.toISOString()).run();

    return sessionId;
}

// Get user by session ID
export async function getUserBySession(db: D1Database, sessionId: string): Promise<User | null> {
    const result = await db.prepare(`
    SELECT u.id, u.email, u.name, u.role
    FROM users u
    INNER JOIN sessions s ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > datetime('now') AND u.is_active = 1
  `).bind(sessionId).first<User>();

    return result || null;
}

// Authenticate user by email and password
export async function authenticateUser(
    db: D1Database,
    email: string,
    password: string
): Promise<User | null> {
    const result = await db.prepare(
        'SELECT id, email, password_hash, name, role FROM users WHERE email = ? AND is_active = 1'
    ).bind(email).first<User & { password_hash: string }>();

    if (!result) {
        return null;
    }

    const isValid = await verifyPassword(password, result.password_hash);

    if (!isValid) {
        return null;
    }

    // Update last login
    await db.prepare(
        'UPDATE users SET last_login = unixepoch() WHERE id = ?'
    ).bind(result.id).run();

    return {
        id: result.id,
        email: result.email,
        name: result.name,
        role: result.role,
    };
}

// Delete session (logout)
export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
}

// Clean up expired sessions
export async function cleanupExpiredSessions(db: D1Database): Promise<void> {
    await db.prepare('DELETE FROM sessions WHERE expires_at < datetime(\'now\')').run();
}
