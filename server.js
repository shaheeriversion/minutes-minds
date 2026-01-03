// Teams Meeting Minutes Generator
// Main service file: server.js

const express = require('express');
const axios = require('axios');
const { Client } = require('@microsoft/microsoft-graph-client');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Queue = require('bull');
const NodeCache = require('node-cache');
const crypto = require('crypto');
const winston = require('winston');
require('isomorphic-fetch');
require('dotenv').config();

// Initialize Express app
const app = express();
app.use(helmet());
app.use(express.json());

// Configuration
const config = {
  clientId: process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.AZURE_CLIENT_SECRET,
  tenantId: process.env.AZURE_TENANT_ID,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  webhookSecret: process.env.WEBHOOK_SECRET || 'default-secret-change-me',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  maxRetries: parseInt(process.env.MAX_RETRIES) || 5,
  retryDelay: parseInt(process.env.RETRY_DELAY) || 60000, // 1 minute
  requestTimeout: parseInt(process.env.REQUEST_TIMEOUT) || 30000 // 30 seconds
};

// Validate configuration
function validateConfig() {
  const required = ['clientId', 'clientSecret', 'tenantId', 'anthropicApiKey'];
  const missing = required.filter(key => !config[key]);
  
  if (missing.length > 0) {
    logger.error('Missing required configuration:', { missing });
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

// Logger setup
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'meeting-minutes-bot' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Token cache (1 hour TTL)
const tokenCache = new NodeCache({ stdTTL: 3600 });

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

app.use('/webhook', limiter);

// Queue for processing meetings
const meetingQueue = new Queue('meeting-processing', config.redisUrl, {
  defaultJobOptions: {
    attempts: config.maxRetries,
    backoff: {
      type: 'exponential',
      delay: config.retryDelay
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});

// Metrics tracking
const metrics = {
  totalProcessed: 0,
  totalFailed: 0,
  totalSuccess: 0,
  averageProcessingTime: 0
};

// Get Microsoft Graph access token with caching
async function getAccessToken(correlationId) {
  const cacheKey = 'graph_token';
  const cached = tokenCache.get(cacheKey);
  
  if (cached) {
    logger.debug('Using cached access token', { correlationId });
    return cached;
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`;
  
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  try {
    logger.info('Requesting new access token', { correlationId });
    const response = await axios.post(tokenEndpoint, params, {
      timeout: config.requestTimeout
    });
    
    const token = response.data.access_token;
    const expiresIn = response.data.expires_in || 3600;
    
    // Cache with 5 minute buffer before expiry
    tokenCache.set(cacheKey, token, expiresIn - 300);
    
    logger.info('Access token obtained successfully', { correlationId, expiresIn });
    return token;
  } catch (error) {
    logger.error('Error getting access token', {
      correlationId,
      error: error.message,
      response: error.response?.data
    });
    throw new Error(`Failed to get access token: ${error.message}`);
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

// Retry wrapper with exponential backoff
async function retryWithBackoff(fn, retries = config.maxRetries, delay = 1000, correlationId) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = i === retries - 1;
      
      if (isLastAttempt) {
        logger.error('All retry attempts failed', {
          correlationId,
          attempts: retries,
          error: error.message
        });
        throw error;
      }

      // Don't retry on 4xx errors except 429 (rate limit)
      if (error.response?.status >= 400 && error.response?.status < 500 && error.response?.status !== 429) {
        logger.warn('Non-retryable error encountered', {
          correlationId,
          status: error.response.status,
          error: error.message
        });
        throw error;
      }

      const waitTime = delay * Math.pow(2, i);
      logger.warn('Retry attempt failed, waiting before retry', {
        correlationId,
        attempt: i + 1,
        maxRetries: retries,
        waitTime,
        error: error.message
      });
      
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

// Fetch meeting transcript with retry logic
async function getMeetingTranscript(userId, meetingId, transcriptId, correlationId) {
  const accessToken = await getAccessToken(correlationId);
  const client = getGraphClient(accessToken);

  return retryWithBackoff(async () => {
    try {
      logger.info('Fetching transcript content', {
        correlationId,
        userId,
        meetingId,
        transcriptId
      });

      const transcript = await client
        .api(`/users/${userId}/onlineMeetings/${meetingId}/transcripts/${transcriptId}/content?$format=text/vtt`)
        .get();

      logger.info('Transcript fetched successfully', {
        correlationId,
        transcriptLength: transcript?.length || 0
      });

      return transcript;
    } catch (error) {
      logger.error('Error fetching transcript', {
        correlationId,
        userId,
        meetingId,
        transcriptId,
        error: error.message,
        status: error.statusCode
      });
      throw error;
    }
  }, config.maxRetries, 2000, correlationId);
}

// Get all transcripts for a meeting
async function getAllMeetingTranscripts(userId, meetingId, correlationId) {
  const accessToken = await getAccessToken(correlationId);
  const client = getGraphClient(accessToken);

  return retryWithBackoff(async () => {
    try {
      logger.info('Fetching all transcripts', {
        correlationId,
        userId,
        meetingId
      });

      const transcripts = await client
        .api(`/users/${userId}/onlineMeetings/${meetingId}/transcripts`)
        .get();

      logger.info('Transcripts list fetched', {
        correlationId,
        count: transcripts.value?.length || 0
      });

      return transcripts.value || [];
    } catch (error) {
      logger.error('Error fetching transcripts list', {
        correlationId,
        userId,
        meetingId,
        error: error.message,
        status: error.statusCode
      });
      throw error;
    }
  }, config.maxRetries, 2000, correlationId);
}

// Process transcript with AI to extract meeting minutes
async function generateMeetingMinutes(transcriptText, meetingInfo, correlationId) {
  // Sanitize transcript (remove potential injection attempts)
  const sanitizedTranscript = transcriptText.substring(0, 100000); // Limit to 100k chars

  try {
    logger.info('Generating meeting minutes with AI', {
      correlationId,
      transcriptLength: sanitizedTranscript.length,
      meetingSubject: meetingInfo.subject
    });

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
${sanitizedTranscript}

Format the output as a professional meeting minutes document in JSON with these fields:
{
  "summary": "...",
  "discussionPoints": ["...", "..."],
  "decisions": ["...", "..."],
  "actionItems": [
    {"task": "...", "assignee": "...", "dueDate": "..."}
  ]
}`
        }]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: config.requestTimeout * 2 // AI requests can take longer
      }
    );

    const content = response.data.content[0].text;
    // Extract JSON from response (may be wrapped in markdown)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const minutes = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(content);

    logger.info('Meeting minutes generated successfully', {
      correlationId,
      hasActionItems: minutes.actionItems?.length > 0
    });

    return minutes;
  } catch (error) {
    logger.error('Error generating minutes', {
      correlationId,
      error: error.message,
      response: error.response?.data
    });
    throw new Error(`Failed to generate meeting minutes: ${error.message}`);
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
${minutes.discussionPoints?.map(point => `- ${point}`).join('\n') || 'None recorded'}

## Decisions Made
${minutes.decisions?.map(decision => `- ${decision}`).join('\n') || 'None recorded'}

## Action Items
${minutes.actionItems?.map(item => 
  `- **${item.task}**\n  - Assignee: ${item.assignee || 'Unassigned'}\n  - Due: ${item.dueDate || 'TBD'}`
).join('\n\n') || 'None recorded'}

---
*Generated automatically by Meeting Minutes Bot*
`;
}

// Post meeting minutes to Teams chat
async function postMinutesToTeams(chatId, minutesDocument, correlationId) {
  const accessToken = await getAccessToken(correlationId);
  const client = getGraphClient(accessToken);

  return retryWithBackoff(async () => {
    try {
      logger.info('Posting minutes to Teams', {
        correlationId,
        chatId
      });

      const message = {
        body: {
          contentType: 'html',
          content: minutesDocument
            .replace(/\n/g, '<br>')
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/^# (.*?)$/gm, '<h1>$1</h1>')
            .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
        }
      };

      await client
        .api(`/chats/${chatId}/messages`)
        .post(message);

      logger.info('Meeting minutes posted successfully', { correlationId });
    } catch (error) {
      logger.error('Error posting to Teams', {
        correlationId,
        chatId,
        error: error.message,
        status: error.statusCode
      });
      throw error;
    }
  }, config.maxRetries, 2000, correlationId);
}

// Validate webhook signature
function validateWebhookSignature(req) {
  const signature = req.headers['x-ms-signature'];
  const clientState = req.body.value?.[0]?.clientState;
  
  if (clientState !== config.webhookSecret) {
    logger.warn('Invalid webhook client state', {
      received: clientState,
      expected: config.webhookSecret
    });
    return false;
  }
  
  return true;
}

// Process meeting job
async function processMeetingJob(job) {
  const { meetingId, chatId, userId, correlationId } = job.data;
  const startTime = Date.now();

  try {
    logger.info('Processing meeting job', {
      correlationId,
      jobId: job.id,
      meetingId,
      attempt: job.attemptsMade + 1
    });

    // Get meeting details
    const accessToken = await getAccessToken(correlationId);
    const client = getGraphClient(accessToken);
    
    const meeting = await retryWithBackoff(async () => {
      return await client
        .api(`/users/${userId}/onlineMeetings/${meetingId}`)
        .get();
    }, config.maxRetries, 2000, correlationId);

    logger.info('Meeting details fetched', {
      correlationId,
      subject: meeting.subject
    });

    // Get transcripts with retry
    let transcripts = [];
    let retryCount = 0;
    const maxTranscriptRetries = 10;

    while (transcripts.length === 0 && retryCount < maxTranscriptRetries) {
      transcripts = await getAllMeetingTranscripts(userId, meetingId, correlationId);
      
      if (transcripts.length === 0) {
        retryCount++;
        const waitTime = Math.min(30000 * retryCount, 300000); // Max 5 minutes
        logger.info('No transcripts available yet, waiting', {
          correlationId,
          retryCount,
          waitTime
        });
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    if (transcripts.length === 0) {
      throw new Error('No transcripts available after maximum retries');
    }

    // Get the latest transcript content
    const transcriptContent = await getMeetingTranscript(
      userId,
      meetingId,
      transcripts[0].id,
      correlationId
    );

    // Extract meeting info
    const meetingInfo = {
      subject: meeting.subject || 'Untitled Meeting',
      startDateTime: meeting.startDateTime,
      participants: meeting.participants?.map(p => p.identity?.displayName || 'Unknown') || []
    };

    // Generate minutes using AI
    const minutes = await generateMeetingMinutes(transcriptContent, meetingInfo, correlationId);

    // Format document
    const document = formatMeetingDocument(minutes, meetingInfo);

    // Post to Teams
    await postMinutesToTeams(chatId, document, correlationId);

    const processingTime = Date.now() - startTime;
    
    // Update metrics
    metrics.totalProcessed++;
    metrics.totalSuccess++;
    metrics.averageProcessingTime = 
      (metrics.averageProcessingTime * (metrics.totalSuccess - 1) + processingTime) / metrics.totalSuccess;

    logger.info('Meeting processed successfully', {
      correlationId,
      jobId: job.id,
      processingTime
    });

    return { success: true, processingTime };
  } catch (error) {
    metrics.totalFailed++;
    
    logger.error('Failed to process meeting', {
      correlationId,
      jobId: job.id,
      meetingId,
      attempt: job.attemptsMade + 1,
      error: error.message,
      stack: error.stack
    });

    throw error;
  }
}

// Queue event handlers
meetingQueue.on('completed', (job, result) => {
  logger.info('Job completed', {
    jobId: job.id,
    result
  });
});

meetingQueue.on('failed', (job, err) => {
  logger.error('Job failed', {
    jobId: job.id,
    attempts: job.attemptsMade,
    error: err.message
  });
});

meetingQueue.on('stalled', (job) => {
  logger.warn('Job stalled', {
    jobId: job.id
  });
});

// Process jobs
meetingQueue.process(async (job) => {
  return await processMeetingJob(job);
});

// Webhook validation endpoint (for Microsoft Graph subscription)
app.get('/webhook/meeting-ended', (req, res) => {
  const validationToken = req.query.validationToken;
  
  if (validationToken) {
    logger.info('Webhook validation request received');
    return res.type('text/plain').send(validationToken);
  }
  
  res.status(400).send('Bad request');
});

// Webhook endpoint for meeting ended event
app.post('/webhook/meeting-ended', async (req, res) => {
  const correlationId = crypto.randomUUID();
  
  logger.info('Meeting ended webhook received', {
    correlationId,
    body: req.body
  });

  // Validate webhook
  // if (!validateWebhookSignature(req)) {
  //   logger.warn('Invalid webhook signature', { correlationId });
  //   return res.status(401).json({ error: 'Unauthorized' });
  // }

  try {
    const notifications = req.body.value || [];
    
    for (const notification of notifications) {
      const { resource, resourceData } = notification;
      
      // Extract meeting details from notification
      // Note: Actual structure depends on your webhook subscription
      const meetingId = resourceData?.id || notification.resourceData?.meetingId;
      const chatId = resourceData?.chatId || notification.resourceData?.chatInfo?.threadId;
      const userId = resourceData?.organizerId || notification.resourceData?.organizer?.id;

      if (!meetingId || !chatId || !userId) {
        logger.warn('Missing required fields in webhook notification', {
          correlationId,
          notification
        });
        continue;
      }

      // Add to queue for processing
      const job = await meetingQueue.add({
        meetingId,
        chatId,
        userId,
        correlationId
      });

      logger.info('Meeting job queued', {
        correlationId,
        jobId: job.id,
        meetingId
      });
    }

    res.status(202).json({ 
      success: true, 
      message: 'Webhook received and queued for processing',
      correlationId
    });
  } catch (error) {
    logger.error('Error processing webhook', {
      correlationId,
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: error.message, correlationId });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    // Check Graph API connectivity
    await getAccessToken('health-check');
    
    // Check queue health
    const queueHealth = await meetingQueue.isReady();
    
    res.json({ 
      status: 'healthy',
      timestamp: new Date().toISOString(),
      queue: queueHealth ? 'connected' : 'disconnected',
      metrics: {
        totalProcessed: metrics.totalProcessed,
        totalSuccess: metrics.totalSuccess,
        totalFailed: metrics.totalFailed,
        successRate: metrics.totalProcessed > 0 
          ? ((metrics.totalSuccess / metrics.totalProcessed) * 100).toFixed(2) + '%'
          : 'N/A',
        averageProcessingTime: Math.round(metrics.averageProcessingTime) + 'ms'
      }
    });
  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(503).json({ 
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    const queueCounts = await meetingQueue.getJobCounts();
    
    res.json({
      processing: metrics,
      queue: queueCounts,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching metrics', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  
  await meetingQueue.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  
  await meetingQueue.close();
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3000;

try {
  validateConfig();
  
  app.listen(PORT, () => {
    logger.info('Meeting Minutes Service started', {
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development'
    });
  });
} catch (error) {
  logger.error('Failed to start server', { error: error.message });
  process.exit(1);
}
