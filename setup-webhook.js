const axios = require('axios');
require('dotenv').config();

// Configuration
const config = {
  tenantId: process.env.AZURE_TENANT_ID,
  clientId: process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.AZURE_CLIENT_SECRET,
  webhookUrl: process.env.WEBHOOK_URL || 'https://your-app-name.azurewebsites.net/webhook/meeting-ended',
  webhookSecret: process.env.WEBHOOK_SECRET,
  subscriptionDays: parseInt(process.env.SUBSCRIPTION_DAYS) || 3 // Max 3 days for most subscriptions
};

// Validate configuration
function validateConfig() {
  const required = ['tenantId', 'clientId', 'clientSecret', 'webhookSecret'];
  const missing = required.filter(key => !config[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:', missing.join(', '));
    process.exit(1);
  }

  if (config.webhookUrl.includes('your-app-name')) {
    console.error('❌ Please update WEBHOOK_URL in your .env file');
    process.exit(1);
  }
}

// Get access token
async function getAccessToken() {
  try {
    console.log('🔑 Getting access token...');
    
    const response = await axios.post(
      `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      })
    );

    console.log('✅ Access token obtained');
    return response.data.access_token;
  } catch (error) {
    console.error('❌ Failed to get access token:', error.response?.data || error.message);
    throw error;
  }
}

// List existing subscriptions
async function listSubscriptions(accessToken) {
  try {
    console.log('\n📋 Fetching existing subscriptions...');
    
    const response = await axios.get(
      'https://graph.microsoft.com/v1.0/subscriptions',
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const subscriptions = response.data.value || [];
    
    if (subscriptions.length === 0) {
      console.log('   No existing subscriptions found');
    } else {
      console.log(`   Found ${subscriptions.length} subscription(s):`);
      subscriptions.forEach((sub, index) => {
        console.log(`   ${index + 1}. ID: ${sub.id}`);
        console.log(`      Resource: ${sub.resource}`);
        console.log(`      Notification URL: ${sub.notificationUrl}`);
        console.log(`      Expires: ${sub.expirationDateTime}`);
        console.log(`      Status: ${new Date(sub.expirationDateTime) > new Date() ? '✅ Active' : '⚠️ Expired'}`);
      });
    }

    return subscriptions;
  } catch (error) {
    console.error('❌ Failed to list subscriptions:', error.response?.data || error.message);
    return [];
  }
}

// Delete a subscription
async function deleteSubscription(accessToken, subscriptionId) {
  try {
    await axios.delete(
      `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    console.log(`   ✅ Deleted subscription: ${subscriptionId}`);
    return true;
  } catch (error) {
    console.error(`   ❌ Failed to delete subscription ${subscriptionId}:`, error.response?.data || error.message);
    return false;
  }
}

// Create new subscription
async function createSubscription(accessToken) {
  try {
    console.log('\n🔔 Creating new webhook subscription...');
    console.log(`   Notification URL: ${config.webhookUrl}`);
    console.log(`   Resource: /communications/onlineMeetings`);
    
    const expirationDate = new Date(Date.now() + config.subscriptionDays * 24 * 60 * 60 * 1000);
    
    const subscriptionData = {
      changeType: 'created,updated',
      notificationUrl: config.webhookUrl,
      resource: '/communications/onlineMeetings',
      expirationDateTime: expirationDate.toISOString(),
      clientState: config.webhookSecret
    };

    const response = await axios.post(
      'https://graph.microsoft.com/v1.0/subscriptions',
      subscriptionData,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Webhook subscription created successfully!');
    console.log('\n📝 Subscription Details:');
    console.log(`   ID: ${response.data.id}`);
    console.log(`   Resource: ${response.data.resource}`);
    console.log(`   Change Types: ${response.data.changeType}`);
    console.log(`   Notification URL: ${response.data.notificationUrl}`);
    console.log(`   Expires: ${response.data.expirationDateTime}`);
    console.log(`   Created: ${response.data.createdDateTime}`);
    
    console.log('\n⚠️  Important Notes:');
    console.log('   - Subscription expires in', config.subscriptionDays, 'days');
    console.log('   - You need to renew it before expiration');
    console.log('   - Your webhook endpoint must be publicly accessible');
    console.log('   - Ensure your server is running and can handle validation requests');

    return response.data;
  } catch (error) {
    console.error('❌ Failed to create subscription');
    
    if (error.response?.data) {
      console.error('   Error details:', JSON.stringify(error.response.data, null, 2));
      
      // Common error explanations
      if (error.response.data.error?.message?.includes('validation')) {
        console.error('\n💡 Tip: Make sure your webhook endpoint is publicly accessible and responds to validation requests');
      }
      if (error.response.data.error?.message?.includes('permission')) {
        console.error('\n💡 Tip: Ensure your app has the required permissions and admin consent has been granted');
      }
    } else {
      console.error('   Error:', error.message);
    }
    
    throw error;
  }
}

// Renew an existing subscription
async function renewSubscription(accessToken, subscriptionId) {
  try {
    console.log(`\n🔄 Renewing subscription ${subscriptionId}...`);
    
    const expirationDate = new Date(Date.now() + config.subscriptionDays * 24 * 60 * 60 * 1000);
    
    const response = await axios.patch(
      `https://graph.microsoft.com/v1.0/subscriptions/${subscriptionId}`,
      {
        expirationDateTime: expirationDate.toISOString()
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('✅ Subscription renewed successfully!');
    console.log(`   New expiration: ${response.data.expirationDateTime}`);
    
    return response.data;
  } catch (error) {
    console.error('❌ Failed to renew subscription:', error.response?.data || error.message);
    throw error;
  }
}

// Main function
async function main() {
  console.log('🚀 Microsoft Graph Webhook Setup Tool\n');
  
  validateConfig();

  try {
    const accessToken = await getAccessToken();
    
    // List existing subscriptions
    const existingSubscriptions = await listSubscriptions(accessToken);
    
    // Check for existing subscriptions with same URL
    const matchingSubscriptions = existingSubscriptions.filter(
      sub => sub.notificationUrl === config.webhookUrl
    );

    if (matchingSubscriptions.length > 0) {
      console.log('\n⚠️  Found existing subscription(s) with the same webhook URL');
      console.log('   Options:');
      console.log('   1. Delete old and create new (recommended)');
      console.log('   2. Keep existing and create another');
      console.log('   3. Renew existing subscription');
      
      // For automation, we'll delete old and create new
      console.log('\n🗑️  Deleting old subscriptions...');
      for (const sub of matchingSubscriptions) {
        await deleteSubscription(accessToken, sub.id);
      }
    }

    // Create new subscription
    await createSubscription(accessToken);
    
    console.log('\n✅ Setup completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { 
  getAccessToken, 
  createSubscription, 
  listSubscriptions, 
  deleteSubscription,
  renewSubscription 
};