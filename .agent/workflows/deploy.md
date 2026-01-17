---
description: Deploy Shinshu Solutions to Cloudflare
---

# Deploy Shinshu Solutions Workflow

This workflow guides you through deploying the Shinshu Solutions project to Cloudflare Workers.

## Prerequisites

- Cloudflare account with API token
- D1 database created: `shinshu-solutions`
- R2 bucket created: `shinshu-solutions`
- Resend account with API credentials

## Deployment Steps

### 1. Install Dependencies

```bash
cd /Users/samprimeaux/.gemini/antigravity/scratch/shinshu-solutions
npm install
```

### 2. Set Environment Variable

Export the Cloudflare API token:

```bash
export CLOUDFLARE_API_TOKEN="pd4INhYztXJy5Mqjc66WTw4fLPeDWB8zydnY6K7h"
```

### 3. Configure Secrets

Set the Resend secrets in Cloudflare:

```bash
# Set RESEND_API_TOKEN
echo "re_8KpWKe2u_GDRMRnLhxLbNGBhQqfmLuwNy" | wrangler secret put RESEND_API_TOKEN

# Set RESEND_SIGNING_SECRET
echo "whsec_+WaSe/aNqcdujHv9GRqus33Uxak5ngsx" | wrangler secret put RESEND_SIGNING_SECRET

# Set RESEND_FROM_EMAIL
echo "jawaalk@shinshusolutions.com" | wrangler secret put RESEND_FROM_EMAIL

# Set RESEND_ADMIN_EMAIL
echo "jawaalk@shinshusolutions.com" | wrangler secret put RESEND_ADMIN_EMAIL
```

### 4. Deploy to Development

```bash
wrangler deploy
```

### 5. Deploy to Production

```bash
wrangler deploy --env production
```

### 6. Verify Deployment

Test the deployed worker:

```bash
# Get the worker URL from deployment output, then:
curl https://shinshu-solutions.YOUR-SUBDOMAIN.workers.dev/health
```

## Uploading Static Assets to R2

To upload files from the `static/` directory to R2:

```bash
# Example: Upload an HTML file
wrangler r2 object put shinshu-solutions/index.html \
  --file=static/index.html \
  --content-type="text/html" \
  --remote

# Example: Upload a CSS file
wrangler r2 object put shinshu-solutions/styles.css \
  --file=static/styles.css \
  --content-type="text/css" \
  --remote

# Example: Upload an image
wrangler r2 object put shinshu-solutions/logo.png \
  --file=static/logo.png \
  --content-type="image/png" \
  --remote
```

**Important**: Always use the `--remote` flag for R2 operations.

## Troubleshooting

### Authentication Issues

If you get authentication errors:
1. Verify the API token is correctly exported
2. Check that the account ID in `wrangler.toml` matches your Cloudflare account

### Database Connection Issues

If D1 database connection fails:
1. Verify the database ID in `wrangler.toml`
2. Check that the database exists: `wrangler d1 list`

### R2 Bucket Issues

If R2 operations fail:
1. Verify the bucket name in `wrangler.toml`
2. Check that the bucket exists: `wrangler r2 bucket list`

## Monitoring

View live logs:

```bash
# Development
wrangler tail

# Production
wrangler tail --env production
```

## Rollback

If you need to rollback a deployment:

```bash
wrangler rollback
```
