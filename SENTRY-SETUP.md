# Sentry Error Tracking Setup

## Quick Setup

### 1. Create a Sentry Account
1. Go to https://sentry.io/signup/
2. Create a free account (includes 5,000 errors/month)

### 2. Create a New Project
1. Click "Create Project"
2. Select **Node.js** as the platform
3. Name it "teams-meeting-minutes" or similar
4. Click "Create Project"

### 3. Get Your DSN
After creating the project, Sentry will show you a DSN that looks like:
```
https://abc123def456@o123456.ingest.sentry.io/7890123
```

### 4. Add DSN to Your .env File
```env
SENTRY_DSN=https://abc123def456@o123456.ingest.sentry.io/7890123
```

### 5. Restart Your Server
```cmd
node server.js
```

## What Gets Tracked

Sentry will automatically capture:
- ✅ Unhandled exceptions
- ✅ Failed API calls to Microsoft Graph
- ✅ AI generation errors
- ✅ Meeting processing failures
- ✅ Access token errors
- ✅ Request context (correlation IDs, meeting IDs)

## Viewing Errors

1. Go to https://sentry.io
2. Select your project
3. View errors in real-time with:
   - Full stack traces
   - Request context
   - User impact
   - Error frequency
   - Performance data

## Features

### Error Grouping
Similar errors are automatically grouped together

### Alerts
Set up alerts for:
- New error types
- Error frequency spikes
- Specific error patterns

### Releases
Track errors by deployment version:
```javascript
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  release: 'meeting-bot@1.0.0'
});
```

### Performance Monitoring
Already enabled with `tracesSampleRate: 1.0`
- Track API response times
- Monitor slow operations
- Identify bottlenecks

## Testing Sentry

Test that Sentry is working:

```javascript
// Add this temporary route to server.js
app.get('/test-sentry', (req, res) => {
  throw new Error('Test Sentry error!');
});
```

Visit `http://localhost:3000/test-sentry` and check Sentry dashboard.

## Best Practices

1. **Don't log sensitive data**
   - Sentry automatically scrubs common PII
   - Be careful with custom context

2. **Use breadcrumbs** for debugging flow:
   ```javascript
   Sentry.addBreadcrumb({
     message: 'Fetching transcript',
     level: 'info',
     data: { meetingId }
   });
   ```

3. **Set user context** for better tracking:
   ```javascript
   Sentry.setUser({ id: userId, email: userEmail });
   ```

4. **Use tags** for filtering:
   ```javascript
   Sentry.setTag('meeting_type', 'recurring');
   ```

## Disabling Sentry

To disable Sentry (for local development):
1. Remove or comment out `SENTRY_DSN` in `.env`
2. Restart server

The app will work normally without Sentry.

## Cost

- **Free tier**: 5,000 errors/month
- **Team tier**: $26/month for 50,000 errors
- **Business tier**: $80/month for 100,000 errors

For most use cases, the free tier is sufficient.
