# Shinshu Solutions - Quick Command Reference

## Environment Setup
```bash
export CLOUDFLARE_API_TOKEN="pd4INhYztXJy5Mqjc66WTw4fLPeDWB8zydnY6K7h"
```

## Development
```bash
npm install              # Install dependencies
npm run dev             # Start local development server
```

## Deployment
```bash
npm run deploy          # Deploy to development
npm run deploy:prod     # Deploy to production
```

## R2 Operations
```bash
# Upload file (always use --remote)
wrangler r2 object put shinshu-solutions/FILE --file=static/FILE --content-type="TYPE" --remote

# List objects
wrangler r2 object list shinshu-solutions --remote

# Download object
wrangler r2 object get shinshu-solutions/FILE --remote
```

## D1 Database
```bash
# Execute SQL
wrangler d1 execute shinshu-solutions --command="SELECT * FROM table_name"

# Run migrations
wrangler d1 migrations apply shinshu-solutions

# Create migration
wrangler d1 migrations create shinshu-solutions migration_name
```

## Monitoring
```bash
npm run tail            # View dev logs
npm run tail:prod       # View production logs
```

## Secrets Management
```bash
# Set a secret
wrangler secret put SECRET_NAME

# List secrets
wrangler secret list

# Delete a secret
wrangler secret delete SECRET_NAME
```

## Resource IDs
- **Account**: `e3b02eefdc01c8bd458e608e6cffccb8`
- **D1 DB**: `b3463aea-6a59-4794-9f9d-e9a56167fb46`
- **R2 Bucket**: `shinshu-solutions`
- **Contact**: `jawaalk@shinshusolutions.com`
