// Teams Meeting Minutes Generator
// Main service file: server.js

const express = require('express');
const axios = require('axios');
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

const app = express();
app.use(express.json());

// Configuration
const config = {
  clientId: process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.AZURE_CLIENT_SECRET,
  tenantId: process.env.AZURE_TENANT_ID,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY
};

// Get Microsoft Graph access token
async function getAccessToken() {
  const tokenEndpoint = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  try {
    const response = await axios.post(tokenEndpoint, params);
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting access token:', error.response?.data);
    throw error;
  }
}

// Initialize Graph Client
function getGraphClient(accessToken) {
  return Client.init({
    authProvider: (done) => {
      done(null, accessToken);
    }
  });
}

// Fetch meeting transcript
async function getMeetingTranscript(meetingId, transcriptId) {
  const accessToken = await getAccessToken();
  const client = getGraphClient(accessToken);

  try {
    // Get transcript content
    const transcript = await client
      .api(`/users/${meetingId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content`)
      .get();

    return transcript;
  } catch (error) {
    console.error('Error fetching transcript:', error);
    throw error;
  }
}

// Alternative: Get all transcripts for a meeting
async function getAllMeetingTranscripts(userId, meetingId) {
  const accessToken = await getAccessToken();
  const client = getGraphClient(accessToken);

  try {
    const transcripts = await client
      .api(`/users/${userId}/onlineMeetings/${meetingId}/transcripts`)
      .get();

    return transcripts.value;
  } catch (error) {
    console.error('Error fetching transcripts:', error);
    throw error;
  }
}

// Process transcript with AI to extract meeting minutes
async function generateMeetingMinutes(transcriptText, meetingInfo) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: `Analyze this meeting transcript and extract:

1. Meeting Summary (2-3 sentences)
2. Key Discussion Points (bullet points)
3. Decisions Made
4. Action Items (with assigned person if mentioned)

Meeting Details:
- Subject: ${meetingInfo.subject}
- Date: ${meetingInfo.startDateTime}
- Participants: ${meetingInfo.participants.join(', ')}

Transcript:
${transcriptText}

Format the output as a professional meeting minutes document in JSON with these fields:
{
  "summary": "...",
  "discussionPoints": ["...", "..."],
  "decisions": ["...", "..."],
  "actionItems": [
    {"task": "...", "assignee": "...", "dueDate": "..."},
  ]
}`
        }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const content = response.data.content[0].text;
    // Extract JSON from response (may be wrapped in markdown)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);
  } catch (error) {
    console.error('Error generating minutes:', error.response?.data || error.message);
    throw error;
  }
}

// Create and format meeting minutes document
function formatMeetingDocument(minutes, meetingInfo) {
  return `
# Meeting Minutes

**Meeting:** ${meetingInfo.subject}
**Date:** ${new Date(meetingInfo.startDateTime).toLocaleString()}
**Participants:** ${meetingInfo.participants.join(', ')}

---

## Summary
${minutes.summary}

## Key Discussion Points
${minutes.discussionPoints.map(point => `- ${point}`).join('\n')}

## Decisions Made
${minutes.decisions.map(decision => `- ${decision}`).join('\n')}

## Action Items
${minutes.actionItems.map(item => 
  `- **${item.task}**\n  - Assignee: ${item.assignee || 'Unassigned'}\n  - Due: ${item.dueDate || 'TBD'}`
).join('\n\n')}

---
*Generated automatically by Meeting Minutes Bot*
`;
}

// Post meeting minutes to Teams chat
async function postMinutesToTeams(meetingId, chatId, minutesDocument) {
  const accessToken = await getAccessToken();
  const client = getGraphClient(accessToken);

  try {
    const message = {
      body: {
        contentType: 'html',
        content: minutesDocument.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      }
    };

    await client
      .api(`/chats/${chatId}/messages`)
      .post(message);

    console.log('Meeting minutes posted successfully');
  } catch (error) {
    console.error('Error posting to Teams:', error);
    throw error;
  }
}

// Webhook endpoint for meeting ended event
app.post('/webhook/meeting-ended', async (req, res) => {
  console.log('Meeting ended webhook received:', req.body);
  
  const { meetingId, chatId, userId } = req.body;

  try {
    // Wait a bit for transcript to be available
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 seconds

    // Get meeting details
    const accessToken = await getAccessToken();
    const client = getGraphClient(accessToken);
    
    const meeting = await client
      .api(`/users/${userId}/onlineMeetings/${meetingId}`)
      .get();

    // Get transcripts
    const transcripts = await getAllMeetingTranscripts(userId, meetingId);
    
    if (transcripts.length === 0) {
      console.log('No transcripts available yet');
      return res.status(202).json({ message: 'Transcript not ready, will retry' });
    }

    // Get the latest transcript content
    const transcriptContent = await getMeetingTranscript(
      meetingId, 
      transcripts[0].id
    );

    // Extract meeting info
    const meetingInfo = {
      subject: meeting.subject,
      startDateTime: meeting.startDateTime,
      participants: meeting.participants.map(p => p.identity.displayName)
    };

    // Generate minutes using AI
    const minutes = await generateMeetingMinutes(transcriptContent, meetingInfo);

    // Format document
    const document = formatMeetingDocument(minutes, meetingInfo);

    // Post to Teams
    await postMinutesToTeams(meetingId, chatId, document);

    res.json({ success: true, message: 'Meeting minutes generated and posted' });
  } catch (error) {
    console.error('Error processing meeting:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Meeting Minutes Service running on port ${PORT}`);
});