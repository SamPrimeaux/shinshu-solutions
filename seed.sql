-- Insert two users
-- Password for both users is: "summit2026" (hashed with bcrypt)
-- Note: In production, these should be properly hashed. For demo, using a simple hash representation
INSERT INTO users (email, password_hash, full_name, role)
VALUES (
        'jawaalk@shinshusolutions.com',
        '$2a$10$YourHashedPasswordHere1',
        'Jake Waalk',
        'admin'
    ),
    (
        'admin@shinshusolutions.com',
        '$2a$10$YourHashedPasswordHere2',
        'Admin User',
        'admin'
    );
-- Note: The actual password hashing will be done in the worker code
-- These are placeholder hashes that will be replaced by proper bcrypt hashes