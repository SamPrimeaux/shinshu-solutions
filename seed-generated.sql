-- Generated password hashes for users
-- Password for both users: summit2026
INSERT INTO users (
        id,
        email,
        password_hash,
        name,
        role,
        created_at,
        updated_at
    )
VALUES (
        'user_' || hex(randomblob(16)),
        'jawaalk@shinshusolutions.com',
        '$2a$10$k5B63ovfdBI8J/ZjSI8qpOGPSYwmyqeobrJLb2Eaxf50QuRyoah2i',
        'Jake Waalk',
        'admin',
        unixepoch(),
        unixepoch()
    );
INSERT INTO users (
        id,
        email,
        password_hash,
        name,
        role,
        created_at,
        updated_at
    )
VALUES (
        'user_' || hex(randomblob(16)),
        'admin@shinshusolutions.com',
        '$2a$10$j0OeeEoaE34tOJKcmjKTt.qzDx7ibVmUzfWrTK.VgSgqiCGY9CuDS',
        'Admin User',
        'admin',
        unixepoch(),
        unixepoch()
    );