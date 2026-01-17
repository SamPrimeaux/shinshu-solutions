// Script to generate password hashes for seeding users
// Run with: node --experimental-modules seed-users.mjs

import bcrypt from 'bcryptjs';

const users = [
    {
        email: 'jawaalk@shinshusolutions.com',
        password: 'summit2026',
        full_name: 'Jake Waalk',
        role: 'admin'
    },
    {
        email: 'admin@shinshusolutions.com',
        password: 'summit2026',
        full_name: 'Admin User',
        role: 'admin'
    }
];

async function generateHashes() {
    console.log('-- Generated password hashes for users');
    console.log('-- Password for both users: summit2026\n');

    for (const user of users) {
        const hash = await bcrypt.hash(user.password, 10);
        console.log(`INSERT INTO users (email, password_hash, full_name, role) VALUES`);
        console.log(`('${user.email}', '${hash}', '${user.full_name}', '${user.role}');`);
        console.log('');
    }
}

generateHashes();
