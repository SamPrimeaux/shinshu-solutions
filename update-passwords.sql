-- Update existing users with bcrypt hashed passwords
-- Password for both users: summit2026
UPDATE users
SET password_hash = '$2a$10$k5B63ovfdBI8J/ZjSI8qpOGPSYwmyqeobrJLb2Eaxf50QuRyoah2i'
WHERE email = 'jawaalk@shinshusolutions.com';
UPDATE users
SET password_hash = '$2a$10$j0OeeEoaE34tOJKcmjKTt.qzDx7ibVmUzfWrTK.VgSgqiCGY9CuDS'
WHERE email = 'tech@shinshusolutions.com';