const axios = require('axios');

async function setupWebhook() {
  const tokenResponse = await axios.post(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.AZURE_CLIENT_ID,
      client_secret: process.env.AZURE_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    })
  );

  const accessToken = tokenResponse.data.access_token;

  // Create subscription
  const subscription = await axios.post(
    'https://graph.microsoft.com/v1.0/subscriptions',
    {
      changeType: 'updated',
      notificationUrl: 'https://your-app-name.azurewebsites.net/webhook/meeting-ended',
      resource: '/communications/onlineMeetings',
      expirationDateTime: new Date(Date.now() + 3600000 * 24 * 30).toISOString(), // 30 days
      clientState: 'secretClientValue123'
    },
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  console.log('Webhook created:', subscription.data);
}

setupWebhook();