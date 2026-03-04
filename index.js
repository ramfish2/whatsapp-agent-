const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrcodeWeb = require('qrcode');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');
const express = require('express');

const app = express();
let currentQR = null;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function getSheetsClient() {
  const auth = new google.auth.JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

async function analyzeMessage(message, senderName) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: `You are an assistant monitoring a WhatsApp group for healthcare workers.
You detect two types of messages:
1. CALL REQUEST - patient or worker requesting a phone consultation
2. DOCTOR ACCEPTANCE - doctor accepting or volunteering to take a call
Respond ONLY with valid JSON - nothing else.`,
    messages: [{
      role: 'user',
      content: `Analyze this WhatsApp message.
Sender: ${senderName}
Message: "${message}"

Respond with ONLY this JSON:
{
  "messageType": "callRequest" or "doctorAcceptance" or "other",
  "requestedBy": "name or phone of requester or doctor name",
  "callDetails": "brief description or Place Call for doctor acceptance",
  "urgency": "high or medium or low",
  "confidence": "high or medium or low"
}`
    }]
  });

  let text = response.content[0].text.trim()
    .replace(/```json/g, '').replace(/```/g, '').trim();
  return JSON.parse(text);
}

async function logToSheets(entry) {
  const sheets = getSheetsClient();
  const timestamp = new Date().toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: 'Log of Call Requests!A:F',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        timestamp,
        entry.requestedBy,
        entry.phoneNumber,
        entry.callDetails,
        entry.urgency,
        entry.rawMessage
      ]]
    }
  });
  console.log('Logged to Google Sheets:', entry.requestedBy);
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  }
});

client.on('qr', async qr => {
  qrcode.generate(qr, { small: true });
  currentQR = await qrcodeWeb.toDataURL(qr);
  console.log('New QR code generated - visit /qr to scan');
});

client.on('ready', () => {
  currentQR = null;
  console.log('WhatsApp agent connected and listening');
});

client.on('disconnected', reason => {
  console.log('Disconnected:', reason);
});

client.on('message', async msg => {
  try {
    if (!msg.from.endsWith('@g.us')) return;

    const message = msg.body || '';
    if (!message.trim()) return;

    const contact = await msg.getContact();
    const senderName = contact.pushname || contact.number || msg.from;
    const phoneNumber = contact.number || msg.from;

    console.log('Group message from ' + senderName + ': ' + message);

    const analysis = await analyzeMessage(message, senderName);
    console.log('Type:', analysis.messageType, '| Confidence:', analysis.confidence);

    if (analysis.confidence === 'low' || analysis.messageType === 'other') return;

    if (analysis.messageType === 'callRequest') {
      await logToSheets({
        requestedBy: analysis.requestedBy || senderName,
        phoneNumber:  phoneNumber,
        callDetails:  analysis.callDetails || 'Not specified',
        urgency:      analysis.urgency || 'medium',
        rawMessage:   message
      });
    }

    if (analysis.messageType === 'doctorAcceptance') {
      await logToSheets({
        requestedBy: 'Dr. ' + (analysis.requestedBy || senderName),
        phoneNumber:  phoneNumber,
        callDetails:  'Place Call',
        urgency:      analysis.urgency || 'medium',
        rawMessage:   message
      });
    }

  } catch (err) {
    console.error('Error processing message:', err.message);
  }
});

app.get('/', (req, res) => {
  res.send('WhatsApp Agent is running');
});

app.get('/qr', (req, res) => {
  if (currentQR) {
    res.send(
      '<html><body style="display:flex;flex-direction:column;align-items:center;font-family:sans-serif;padding:40px">' +
      '<h2>Scan with WhatsApp</h2>' +
      '<img src="' + currentQR + '" style="width:300px;height:300px" />' +
      '<p>Open WhatsApp - Settings - Linked Devices - Link a Device</p>' +
      '<p><a href="/qr">Refresh</a></p>' +
      '</body></html>'
    );
  } else {
    res.send(
      '<html><body style="text-align:center;font-family:sans-serif;padding:40px">' +
      '<h2>WhatsApp is connected</h2>' +
      '<p>No QR scan needed</p>' +
      '</body></html>'
    );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));

client.initialize();
