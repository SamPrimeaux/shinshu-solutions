---
description: Deploy to CI/CD Worker Environment
---

# Deploy to CI/CD Worker

This workflow deploys the Shinshu Solutions worker to the **CI/CD environment** at `shinshu-solutions-ci-di.jawaalk.workers.dev`.

## Prerequisites

- Updated worker code with MPA routing
- Cloudflare API token set
- R2 bucket with HTML pages

## Deployment Steps

### 1. Set Environment Variable

```bash
export CLOUDFLARE_API_TOKEN="pd4INhYztXJy5Mqjc66WTw4fLPeDWB8zydnY6K7h"
```

### 2. Deploy to CI/CD Worker

The CI/CD worker name is `shinshu-solutions-ci-di`. Deploy using:

```bash
wrangler deploy --name shinshu-solutions-ci-di
```

**OR** if you have a separate wrangler config for CI/CD:

```bash
wrangler deploy --config wrangler.ci-di.toml
```

### 3. Verify Deployment

Test the CI/CD worker:

```bash
# Test homepage
curl https://shinshu-solutions-ci-di.jawaalk.workers.dev/

# Test clean URLs
curl https://shinshu-solutions-ci-di.jawaalk.workers.dev/about

# Test API health
curl https://shinshu-solutions-ci-di.jawaalk.workers.dev/api/health

# Test R2 connection
curl https://shinshu-solutions-ci-di.jawaalk.workers.dev/api/r2-test
```

### 4. View Logs

Monitor the CI/CD worker logs:

```bash
wrangler tail --name shinshu-solutions-ci-di
```

## Notes

- The CI/CD worker should use the **same R2 bucket** and **D1 database** as production
- Ensure the worker name matches exactly: `shinshu-solutions-ci-di`
- The MPA routing system will automatically serve pages from R2 with clean URLs
- No SPA routing - all pages are properly routed as separate HTML files

## Troubleshooting

### Worker Name Mismatch

If deployment fails, check the worker name in Cloudflare dashboard and use:

```bash
wrangler deployments list --name shinshu-solutions-ci-di
```

### Still Showing SPA Routing

If the CI/CD worker still shows SPA behavior after deployment:
1. Verify the deployment completed successfully
2. Check that the latest code was deployed
3. Clear Cloudflare cache if needed
4. Check worker logs for errors
