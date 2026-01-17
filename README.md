# Shinshu Solutions

A Cloudflare Workers project with D1 database and R2 storage integration.

## Project Structure

```
shinshu-solutions/
├── src/
│   └── index.ts          # Main worker entry point
├── static/               # Static assets (uploaded to R2)
├── wrangler.toml         # Cloudflare configuration
├── WRANGLER_SECRETS.md   # Credentials and deployment commands
├── package.json          # Node dependencies
└── tsconfig.json         # TypeScript configuration
```

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Set Environment Variables
```bash

```

### 3. Set Secrets
```bash
wrangler secret put RESEND_API_TOKEN
wrangler secret put RESEND_SIGNING_SECRET
wrangler secret put RESEND_FROM_EMAIL
wrangler secret put RESEND_ADMIN_EMAIL
```

### 4. Deploy
```bash
# Development
wrangler deploy

# Production
wrangler deploy --env production
```

## R2 Asset Upload

Upload static files to R2 bucket (always use `--remote`):

```bash

wrangler r2 object put shinshu-solutions/FILENAME --file=static/FILENAME --content-type="TYPE" --remote
```

### Common Content Types
- HTML: `text/html`
- CSS: `text/css`
- JavaScript: `application/javascript`
- Images (PNG): `image/png`
- Images (JPEG): `image/jpeg`
- Images (SVG): `image/svg+xml`

## Resources

- **Account ID**: `e3b02eefdc01c8bd458e608e6cffccb8`
- **R2 Bucket**: `shinshu-solutions`
- **D1 Database**: `shinshu-solutions` (ID: `b3463aea-6a59-4794-9f9d-e9a56167fb46`)
- **Contact Email**: `jawaalk@shinshusolutions.com`

## Security Notes

⚠️ **IMPORTANT**: Never commit `WRANGLER_SECRETS.md` to public repositories. This file contains sensitive credentials.

Add to `.gitignore`:
```
WRANGLER_SECRETS.md
.env
.dev.vars
```
