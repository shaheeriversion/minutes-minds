# Quick Webhook Setup Guide

## What is a Microsoft Graph Subscription?

A subscription is like a "notification registration" that tells Microsoft Graph:
- **What to watch**: Online meetings in your organization
- **What changes to notify about**: When meetings are created or updated
- **Where to send notifications**: Your webhook URL
- **How to verify it's you**: Using your webhook secret

## Step-by-Step Setup

### 1. Generate Your Webhook Secret

This is a password you create to verify webhook requests are legitimate.

**Generate it:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Example output:**
```
a7f3e9d2c8b4f1a6e5d9c3b7a2f8e4d1c9b5a3f7e2d8c4b1a6f9e3d7c2b8a5f4
```

### 2. Update Your .env File

Add these lines to your `.env` file:

```bash
# Your deployed app URL (or ngrok URL for testing)
WEBHOOK_URL="https://your-app.azurewebsites.net/webhook/meeting-ended"

# The secret you just generated
WEBHOOK_SECRET="a7f3e9d2c8b4f1a6e5d9c3b7a2f8e4d1c9b5a3f7e2d8c4b1a6f9e3d7c2b8a5f4"

# How many days before subscription expires (max 3 for most resources)
SUBSCRIPTION_DAYS="3"
```

### 3. Make Sure Your Server is Running

The subscription creation process will send a validation request to your webhook URL.

```bash
npm start
```

Your server should be accessible at the URL you specified in `WEBHOOK_URL`.

### 4. Run the Setup Script

```bash
node setup-webhook.js
```

### 5. What Happens Next

1. **Script authenticates** with Microsoft Graph using your Azure credentials
2. **Lists existing subscriptions** (if any)
3. **Deletes old subscriptions** with the same URL (to avoid duplicates)
4. **Creates new subscription** with your configuration
5. **Microsoft validates** by sending a GET request to your webhook URL
6. **Your server responds** with the validation token
7. **Subscription is active** and will send notifications for 3 days

## Understanding the Output

### Success Output
```
✅ Webhook subscription created successfully!

📝 Subscription Details:
   ID: 7f392407-e9c4-4d5a-9b8f-3c2d1e0a9b7c
   Resource: /communications/onlineMeetings
   Change Types: created,updated
   Notification URL: https://your-app.azurewebsites.net/webhook/meeting-ended
   Expires: 2026-01-06T12:34:56.789Z
   Created: 2026-01-03T12:34:56.789Z
```

**What this means:**
- Your subscription is active
- Microsoft will send notifications to your URL when meetings are created/updated
- It expires in 3 days (you'll need to renew it)
- The subscription ID is saved (you can use it to renew or delete)

## Common Issues

### Issue: "Subscription validation request failed"

**Cause:** Microsoft couldn't reach your webhook URL or it didn't respond correctly.

**Solutions:**
1. Make sure your server is running: `npm start`
2. Check your WEBHOOK_URL is correct and publicly accessible
3. Test your webhook endpoint:
   ```bash
   curl "https://your-app.azurewebsites.net/webhook/meeting-ended?validationToken=test123"
   ```
   Should return: `test123`

### Issue: "Insufficient privileges to complete the operation"

**Cause:** Your Azure app doesn't have the required permissions or admin consent wasn't granted.

**Solutions:**
1. Go to Azure Portal > App Registrations > Your App > API Permissions
2. Verify these permissions are added:
   - `OnlineMeetings.Read.All`
   - `OnlineMeetingTranscript.Read.All`
   - `Chat.ReadWrite`
3. Click "Grant admin consent for [Your Organization]"
4. Wait 5 minutes and try again

### Issue: "The specified object was not found"

**Cause:** Invalid tenant ID, client ID, or the app doesn't exist.

**Solutions:**
1. Double-check your `.env` file:
   - `AZURE_TENANT_ID`
   - `AZURE_CLIENT_ID`
   - `AZURE_CLIENT_SECRET`
2. Verify these match your Azure App Registration

### Issue: "Invalid client secret"

**Cause:** The client secret is wrong or expired.

**Solutions:**
1. Go to Azure Portal > App Registrations > Your App > Certificates & secrets
2. Create a new client secret
3. Update `AZURE_CLIENT_SECRET` in your `.env` file

## Testing Locally with ngrok

If you want to test locally before deploying to Azure:

### 1. Install ngrok
```bash
# Windows (with Chocolatey)
choco install ngrok

# Or download from: https://ngrok.com/download
```

### 2. Start your local server
```bash
npm start
```

### 3. Start ngrok in another terminal
```bash
ngrok http 3000
```

### 4. Copy the ngrok URL
```
Forwarding  https://abc123def456.ngrok.io -> http://localhost:3000
```

### 5. Update your .env
```bash
WEBHOOK_URL="https://abc123def456.ngrok.io/webhook/meeting-ended"
```

### 6. Run the setup script
```bash
node setup-webhook.js
```

**Note:** ngrok URLs change every time you restart ngrok (unless you have a paid account). You'll need to update the subscription each time.

## Renewing Subscriptions

Subscriptions expire after 3 days. You have two options:

### Option 1: Run the setup script again
```bash
node setup-webhook.js
```
This will delete the old subscription and create a new one.

### Option 2: Implement auto-renewal (Advanced)
Add a scheduled job to your server that renews the subscription before it expires.

## Verifying Your Subscription

### List all subscriptions
```bash
# Add this to setup-webhook.js or run in Node REPL
const { listSubscriptions, getAccessToken } = require('./setup-webhook.js');

(async () => {
  const token = await getAccessToken();
  await listSubscriptions(token);
})();
```

### Check subscription status
Look for:
- ✅ Active: Expiration date is in the future
- ⚠️ Expired: Expiration date has passed

## What Happens When a Meeting Ends?

1. **Meeting ends** in Teams
2. **Microsoft Graph detects** the change
3. **Notification sent** to your webhook URL
4. **Your server receives** the notification
5. **Validates** the webhook secret matches
6. **Queues the meeting** for processing
7. **Returns 202 Accepted** immediately
8. **Background job** fetches transcript and generates minutes
9. **Posts minutes** to the Teams chat

## Next Steps

After setting up the webhook:

1. ✅ Verify subscription is active: `node setup-webhook.js` (check output)
2. ✅ Test your webhook endpoint: Check `/health` endpoint
3. ✅ Start a test meeting with transcription enabled
4. ✅ End the meeting and wait for minutes to be posted
5. ✅ Check logs: `tail -f combined.log`
6. ✅ Monitor metrics: `curl http://localhost:3000/metrics`

## Troubleshooting Checklist

- [ ] Server is running and accessible
- [ ] WEBHOOK_URL is correct and publicly accessible
- [ ] WEBHOOK_SECRET is set and matches in subscription
- [ ] Azure app has required permissions
- [ ] Admin consent has been granted
- [ ] Subscription is not expired
- [ ] Redis is running (for job queue)
- [ ] All environment variables are set in .env

## Getting Help

If you're still having issues:

1. Check the logs: `tail -f error.log`
2. Test the health endpoint: `curl http://localhost:3000/health`
3. Verify webhook validation: `curl "http://localhost:3000/webhook/meeting-ended?validationToken=test"`
4. Check Microsoft Graph documentation: https://docs.microsoft.com/graph/webhooks
5. Review Azure app permissions in Azure Portal
