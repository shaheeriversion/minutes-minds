 # Teams Meeting Minutes Bot Setup Guide

## Prerequisites
- Azure subscription
- Microsoft 365 tenant with Teams
- Node.js 16+ installed
- Redis server (for job queue)
- Anthropic API key
    ,
    ## Step 1: Azure AD App Registration,
    ,
    1. Go to Azure Portal > Azure Active Directory > App Registrations,
    2. Click 'New registration',
    3. Name: 'Meeting Minutes Bot',
    4. Supported account types: 'Accounts in this organizational directory only',
    5. Click 'Register',
    ,
    ## Step 2: Configure API Permissions,
    ,
    In your app registration:,
    1. Go to 'API permissions',
    2. Click 'Add a permission' > 'Microsoft Graph' > 'Application permissions',
    3. Add these permissions:,
       - OnlineMeetings.Read.All,
       - OnlineMeetingTranscript.Read.All,
       - Chat.ReadWrite,
       - Files.ReadWrite.All,
    4. Click 'Grant admin consent' (requires admin),
    ,
    ## Step 3: Create Client Secret,
    ,
    1. Go to 'Certificates & secrets',
    2. Click 'New client secret',
    3. Add description and expiry,
    4. Copy the secret value (you won't see it again!),
    ,
    ## Step 4: Install Dependencies,
    ,
    ```bash,
    npm install,
    ```,
    ,
    ## Step 5: Install Redis

Redis is required for the job queue system:

**Windows:**
```bash
# Using Chocolatey
choco install redis-64

# Or download from: https://github.com/microsoftarchive/redis/releases
```

**Linux/Mac:**
```bash
# Ubuntu/Debian
sudo apt-get install redis-server

# Mac
brew install redis
```

Start Redis:
```bash
redis-server
```

## Step 6: Configure Environment Variables

1. Copy `.env.example` to `.env`
2. Fill in your values:
   - AZURE_CLIENT_ID: From app registration overview
   - AZURE_CLIENT_SECRET: From step 3
   - AZURE_TENANT_ID: From app registration overview
   - ANTHROPIC_API_KEY: Your Claude API key
   - WEBHOOK_SECRET: Generate a secure random string
   - REDIS_URL: Your Redis connection string (default: redis://127.0.0.1:6379)
   - SENTRY_DSN: (Optional) Your Sentry DSN for error tracking

## Step 6.5: Setup Error Tracking (Optional)

For production deployments, we recommend setting up Sentry for error tracking:

1. See [SENTRY-SETUP.md](SENTRY-SETUP.md) for detailed instructions
2. Add your `SENTRY_DSN` to `.env`
3. Sentry will automatically track errors, performance, and provide alerts

**Benefits:**
- Real-time error notifications
- Full stack traces with context
- Performance monitoring
- Error grouping and trends
- Free tier includes 5,000 errors/month

Skip this step for local development.

## Step 7: Deploy the Service
    ,
    ### Local Testing,
    ```bash,
    npm start,
    ```,
    ,
    ### Azure Deployment,
    ```bash,
    # Create Azure Web App,
    az webapp up --name meeting-minutes-bot --resource-group your-rg,
    ,
    # Configure environment variables,
    az webapp config appsettings set --name meeting-minutes-bot --resource-group your-rg --settings @.env,
    ```,
    ,
    ## Step 8: Create Teams App
    ,
    1. Update manifest.json with your app IDs,
    2. Create icons (color.png 192x192, outline.png 32x32),
    3. Zip manifest.json and icons into app.zip,
    4. Go to Teams > Apps > Manage apps > Upload custom app,
    5. Upload app.zip,
    ,
    ## Step 9: Subscribe to Meeting Events

Microsoft Graph uses webhooks to notify your app when meetings end. You need to create a subscription:

### Prerequisites
1. Your webhook endpoint must be publicly accessible (deployed to Azure or use ngrok for testing)
2. Your server must be running to handle the validation request

### Setup Steps

1. **Update your .env file with webhook details:**
```bash
WEBHOOK_URL="https://your-app.azurewebsites.net/webhook/meeting-ended"
WEBHOOK_SECRET="your-generated-secret-from-earlier"
SUBSCRIPTION_DAYS="3"
```

2. **Run the setup script:**
```bash
node setup-webhook.js
```

This script will:
- Authenticate with Microsoft Graph
- List any existing subscriptions
- Delete old subscriptions with the same URL
- Create a new subscription
- Display subscription details

### Expected Output
```
🚀 Microsoft Graph Webhook Setup Tool

🔑 Getting access token...
✅ Access token obtained

📋 Fetching existing subscriptions...
   No existing subscriptions found

🔔 Creating new webhook subscription...
   Notification URL: https://your-app.azurewebsites.net/webhook/meeting-ended
   Resource: /communications/onlineMeetings
✅ Webhook subscription created successfully!

📝 Subscription Details:
   ID: abc123...
   Resource: /communications/onlineMeetings
   Change Types: created,updated
   Notification URL: https://your-app.azurewebsites.net/webhook/meeting-ended
   Expires: 2026-01-06T...
   Created: 2026-01-03T...
```

### Important Notes
- **Subscriptions expire**: Maximum 3 days for most resources
- **Renewal required**: Run the script again before expiration or implement auto-renewal
- **Validation**: Microsoft will send a validation request to your webhook URL when creating the subscription
- **Public accessibility**: Your webhook endpoint must be reachable from the internet

### Testing with ngrok (Local Development)
If testing locally, use ngrok to expose your local server:

```bash
# Start your server
npm start

# In another terminal, start ngrok
ngrok http 3000

# Use the ngrok URL in your .env
WEBHOOK_URL="https://abc123.ngrok.io/webhook/meeting-ended"

# Run setup
node setup-webhook.js
```

### Troubleshooting Subscription Creation

**Error: "Subscription validation request failed"**
- Ensure your server is running
- Check that the webhook URL is publicly accessible
- Verify your server responds to GET requests with the validationToken

**Error: "Insufficient privileges"**
- Verify admin consent was granted for all permissions
- Check that your app has `OnlineMeetings.Read.All` permission

**Error: "Invalid clientState"**
- Ensure WEBHOOK_SECRET matches in both .env and the subscription

### Manual Subscription (Alternative)

You can also create subscriptions manually using Graph Explorer or Postman:

**POST** `https://graph.microsoft.com/v1.0/subscriptions`

**Headers:**
```
Authorization: Bearer {your-access-token}
Content-Type: application/json
```

**Body:**
```json
{
  "changeType": "created,updated",
  "notificationUrl": "https://your-app.azurewebsites.net/webhook/meeting-ended",
  "resource": "/communications/onlineMeetings",
  "expirationDateTime": "2026-01-06T18:23:45.9356913Z",
  "clientState": "your-webhook-secret"
}
```
    ,
    ## Usage

1. Install the bot in your Teams
2. Start a meeting with transcription enabled
3. When the meeting ends, the bot will:
   - Receive webhook notification
   - Queue the meeting for processing
   - Wait for transcript availability (with automatic retries)
   - Fetch the transcript
   - Generate meeting minutes using AI
   - Post the minutes to the meeting chat

## New Features

### Reliability Improvements
- **Token Caching**: Access tokens are cached for 1 hour to reduce API calls
- **Retry Logic**: Exponential backoff retry for all API calls
- **Job Queue**: Bull queue system for reliable background processing
- **Graceful Degradation**: Handles missing transcripts and API failures

### Security Enhancements
- **Webhook Validation**: Verifies webhook signatures and client state
- **Rate Limiting**: Protects against abuse (100 requests per 15 minutes)
- **Helmet.js**: Security headers for Express
- **Input Sanitization**: Limits transcript size and sanitizes content

### Monitoring & Debugging
- **Structured Logging**: Winston logger with correlation IDs
- **Metrics Endpoint**: `/metrics` - View processing statistics
- **Enhanced Health Check**: `/health` - Checks API connectivity and queue status
- **Error Tracking**: Sentry integration for real-time error monitoring (optional)
- **Detailed Error Logs**: Full context with correlation IDs

### Performance
- **Async Processing**: Non-blocking webhook handling
- **Configurable Timeouts**: Prevent hanging requests
- **Queue Management**: Process multiple meetings concurrently

## API Endpoints

### GET /health
Health check with system status and metrics
```json
{
  "status": "healthy",
  "timestamp": "2026-01-03T...",
  "queue": "connected",
  "metrics": {
    "totalProcessed": 42,
    "totalSuccess": 40,
    "totalFailed": 2,
    "successRate": "95.24%",
    "averageProcessingTime": "45230ms"
  }
}
```

### GET /metrics
Detailed processing and queue metrics

### POST /webhook/meeting-ended
Webhook endpoint for Microsoft Graph notifications
    ,
    ## Troubleshooting

### No transcript available
- Ensure meeting transcription is enabled
- Check logs for retry attempts (bot will retry up to 10 times)
- Transcripts may take 1-5 minutes to become available

### Permission errors
- Verify admin consent was granted for all required permissions
- Check access token is being obtained successfully in logs

### Webhook not triggered
- Verify subscription is active: Check Graph API subscriptions
- Ensure webhook URL is publicly accessible
- Check webhook validation is passing (look for correlation IDs in logs)

### AI errors
- Verify Anthropic API key is valid
- Check API quota/rate limits
- Review error logs for specific error messages

### Queue/Redis errors
- Ensure Redis server is running: `redis-cli ping`
- Check REDIS_URL environment variable
- Review queue metrics at `/metrics` endpoint

### High failure rate
- Check `/metrics` endpoint for error patterns
- Review error.log file for detailed stack traces
- Verify all environment variables are set correctly
- Check network connectivity to Microsoft Graph and Anthropic APIs
    ,
    ## Important Notes

- Meeting transcription must be enabled by organizer or tenant admin
- Transcripts may take 1-5 minutes to become available after meeting ends
- Participants must consent to recording/transcription
- Ensure compliance with local recording laws
- The bot uses a job queue system - check `/metrics` to monitor processing
- Logs are written to `error.log` and `combined.log` files
- Failed jobs are automatically retried with exponential backoff

## Configuration Options

All configuration is done via environment variables in `.env`:

- `MAX_RETRIES`: Number of retry attempts for failed operations (default: 5)
- `RETRY_DELAY`: Base delay between retries in milliseconds (default: 60000)
- `REQUEST_TIMEOUT`: Timeout for API requests in milliseconds (default: 30000)
- `LOG_LEVEL`: Logging level - debug, info, warn, error (default: info)
- `WEBHOOK_SECRET`: Secret for validating webhook requests

## Monitoring

### View Logs
```bash
# Real-time logs
tail -f combined.log

# Error logs only
tail -f error.log
```

### Check Queue Status
```bash
curl http://localhost:3000/metrics
```

### Health Check
```bash
curl http://localhost:3000/health
```
    ,
    ## Support,
    ,
    For issues, check:,
    - Application logs in Azure,
    - Graph API documentation: https://docs.microsoft.com/graph,
    - Teams app documentation: https://docs.microsoft.com/microsoftteams/platform
