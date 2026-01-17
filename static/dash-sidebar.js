function renderSidebar(activePage) {
    const navItems = [
        { id: 'overview', label: 'Overview', href: '/dashboard', icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
        { id: 'media', label: 'Media Assets', href: '/dashboard-media', icon: 'M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z' },
        { id: 'content', label: 'Site Content', href: '/dashboard-content', icon: 'M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z' },
        { id: 'inbox', label: 'Inbox', href: '/dashboard-inbox', icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' }
    ];

    const navHtml = navItems.map(item => `
        <a href="${item.href}" class="nav-item ${activePage === item.id ? 'active' : ''}">
            <svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="${item.icon}"></path>
            </svg>
            <span>${item.label}</span>
        </a>
    `).join('');

    document.write(`
    <aside>
        <a href="/dashboard" class="brand">
            <img src="https://pub-c341cc62c3274ccba5aa77286b26fb90.r2.dev/iconography/shinshu-solutions-icon.png" alt="Logo">
        </a>

        <nav>
            ${navHtml}
            <button class="nav-item logout-btn" onclick="logout()">
                <svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
                </svg>
                <span>Logout</span>
            </button>
        </nav>
    </aside>
    `);
}

async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
}

async function checkAuth() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) {
            window.location.href = '/login';
            return null;
        }
        const data = await res.json();
        return data.user;
    } catch (e) {
        window.location.href = '/login';
        return null;
    }
}
