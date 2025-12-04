# SwiftDrop Deployment Guide

Complete step-by-step guide to deploy SwiftDrop to Cloudflare Workers.

## Prerequisites Checklist

- [ ] Cloudflare account (free tier works)
- [ ] Node.js 16+ installed
- [ ] npm or yarn installed
- [ ] Git installed (optional, for version control)

## Step-by-Step Deployment

### 1. Install Wrangler CLI

```bash
# Install globally
npm install -g wrangler

# Or use with npx (no global install needed)
npx wrangler --version
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

This will:
- Open your browser
- Ask you to log in to Cloudflare
- Authorize Wrangler to access your account

### 3. Update Account ID (if needed)

Open `wrangler.toml` and verify your account ID:

```bash
# Get your account ID
wrangler whoami
```

Update in `wrangler.toml`:
```toml
account_id = "your-account-id-here"
```

### 4. Create R2 Bucket

```bash
# Create the bucket
wrangler r2 bucket create swiftdrop-files

# Verify creation
wrangler r2 bucket list
```

**Expected output:**
```
┌───────────────────┬──────────────────────┐
│ name              │ creation_date        │
├───────────────────┼──────────────────────┤
│ swiftdrop-files   │ 2024-12-04T10:30:00Z │
└───────────────────┴──────────────────────┘
```

### 5. Deploy the Worker

```bash
# From the project directory
wrangler deploy
```

**Expected output:**
```
⛅️ wrangler 3.x.x
------------------
Total Upload: XX.XX KiB / gzip: XX.XX KiB
Uploaded swiftdrop (X.XX sec)
Published swiftdrop (X.XX sec)
  https://swiftdrop.your-subdomain.workers.dev
Current Deployment ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 6. Test the Deployment

1. Copy the deployed URL
2. Open it in two browser tabs/windows
3. Test P2P transfer:
   - Tab 1: Select a file
   - Tab 2: Enter room code
   - Verify file transfers
4. Test fallback (optional):
   - Disable WebRTC in browser dev tools
   - Repeat transfer
   - Should use cloud fallback

## Verification Checklist

After deployment, verify:

- [ ] Worker is accessible at the deployed URL
- [ ] Room code is generated on page load
- [ ] WebSocket connection establishes (check browser console)
- [ ] File selection works
- [ ] P2P transfer completes successfully
- [ ] Fallback upload works (if P2P fails)
- [ ] Download from R2 works

## Common Deployment Issues

### Issue: "Error: No account_id found"

**Solution:**
```bash
# Get your account ID
wrangler whoami

# Update wrangler.toml with the account_id
```

### Issue: "Error: R2 bucket not found"

**Solution:**
```bash
# List buckets to verify
wrangler r2 bucket list

# Create if missing
wrangler r2 bucket create swiftdrop-files

# Verify binding name matches wrangler.toml
```

### Issue: "Durable Object migration error"

**Solution:**
```bash
# Delete existing deployment
wrangler delete

# Redeploy with fresh migration
wrangler deploy
```

### Issue: WebSocket connection fails in production

**Solution:**
1. Check CORS settings in worker
2. Verify Durable Object deployed: `wrangler deployments list`
3. Check browser console for specific errors
4. Try clearing browser cache

## Production Configuration

### 1. Custom Domain (Optional)

Add a custom domain in Cloudflare dashboard:

1. Go to Workers & Pages
2. Select your worker
3. Click "Triggers" tab
4. Add custom domain

Or via wrangler:
```bash
wrangler domains add yourdomain.com
```

### 2. Environment Variables

Add secrets for production:

```bash
# Example: Add API key for external service
wrangler secret put API_KEY
```

### 3. R2 Lifecycle Rules

Set up automatic cleanup of expired files:

1. Go to R2 dashboard
2. Select `swiftdrop-files` bucket
3. Add lifecycle rule:
   - Delete objects older than 1 day

### 4. Rate Limiting (Recommended)

Consider adding rate limiting to prevent abuse:

```javascript
// In worker.js
const RATE_LIMIT = 10; // requests per minute
```

### 5. Analytics

Enable Workers Analytics:

```bash
# In wrangler.toml, add:
[observability]
enabled = true
```

## Monitoring

### View Live Logs

```bash
# Tail logs in real-time
wrangler tail

# Filter by specific status
wrangler tail --status error

# Output as JSON
wrangler tail --format json
```

### View Deployments

```bash
# List recent deployments
wrangler deployments list

# View specific deployment
wrangler deployments view <deployment-id>
```

### Check Usage

Monitor your usage in Cloudflare dashboard:
- Workers requests
- R2 storage
- R2 operations (Class A/B)
- Durable Objects requests

## Updating the Application

### Deploy New Version

```bash
# Make changes to worker.js
# Test locally first
wrangler dev

# Deploy when ready
wrangler deploy
```

### Rollback

```bash
# List deployments
wrangler deployments list

# Rollback to specific deployment
wrangler rollback <deployment-id>
```

## Development Workflow

### Local Development

```bash
# Start local dev server
wrangler dev

# Access at http://localhost:8787
```

**Note:** Durable Objects and R2 work locally with `wrangler dev`!

### Testing Changes

```bash
# Option 1: Local testing
wrangler dev

# Option 2: Remote development (uses production resources)
wrangler dev --remote

# Option 3: Deploy to staging
wrangler deploy --env staging
```

### Environment Setup

Create `wrangler.toml` environments:

```toml
[env.staging]
name = "swiftdrop-staging"
vars = { ENVIRONMENT = "staging" }

[env.production]
name = "swiftdrop"
vars = { ENVIRONMENT = "production" }
```

Deploy to staging:
```bash
wrangler deploy --env staging
```

## Cost Estimation

### Cloudflare Workers (Free Tier)
- 100,000 requests/day
- 10ms CPU time per request
- Usually sufficient for personal use

### R2 Storage (Free Tier)
- 10 GB storage
- 1 million Class A operations/month (writes)
- 10 million Class B operations/month (reads)

### Estimated Costs (Paid Tier)
- Workers: $5/month (10 million requests)
- R2 Storage: $0.015/GB/month
- R2 Operations: $4.50 per million Class A ops

**Example:** 1000 file transfers/day with 10MB average:
- Storage: ~10GB = $0.15/month
- Operations: ~30k writes = $0.13/month
- Workers: ~30k requests = Free or $0.15/month
- **Total: ~$0.30-$0.45/month**

## Cleanup

### Delete Worker

```bash
wrangler delete
```

### Delete R2 Bucket

```bash
# List all objects first
wrangler r2 object list --bucket swiftdrop-files

# Delete all objects
wrangler r2 object delete --bucket swiftdrop-files --key <object-key>

# Delete bucket
wrangler r2 bucket delete swiftdrop-files
```

## Next Steps

After successful deployment:

1. ✅ Test with various file sizes
2. ✅ Test P2P from different networks
3. ✅ Test fallback by blocking WebRTC
4. ✅ Monitor logs for errors
5. ✅ Set up custom domain (optional)
6. ✅ Configure R2 lifecycle rules
7. ✅ Enable analytics
8. ✅ Share your deployment!

## Support

If you encounter issues:

1. Check [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
2. Check [R2 Documentation](https://developers.cloudflare.com/r2/)
3. Search [Cloudflare Community](https://community.cloudflare.com/)
4. Review browser console for client-side errors
5. Check `wrangler tail` for server-side errors

---

**Congratulations!** 🎉 Your SwiftDrop instance is now live!
