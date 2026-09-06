require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl = process.env.APP_URL || `http://localhost:${port}`;
const allowedOrigin = new URL(appUrl).origin;
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origin === allowedOrigin) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  }
}));
app.use(express.json({
  limit: '100kb',
  verify: (request, _response, buffer) => { request.rawBody = buffer; }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireDatabase(_request, response, next) {
  if (!supabase) return response.status(503).json({ error: 'Database is not configured. Add Supabase environment variables.' });
  return next();
}

function verifyWhatsAppSignature(request) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const signature = request.get('x-hub-signature-256');
  if (!appSecret || !signature || !request.rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(request.rawBody).digest('hex')}`;
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

async function sendWhatsAppMessage(to, body) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) throw new Error('WhatsApp Cloud API is not configured');
  const result = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body } })
  });
  if (!result.ok) throw new Error(`WhatsApp API returned ${result.status}: ${await result.text()}`);
  return result.json();
}

async function askAi(customerMessage) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const result = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 250,
      messages: [
        {
          role: 'system',
          content: 'You are the polite WhatsApp assistant for Gangotri Medical Agencies in Balaghat, India. Answer briefly and clearly. Never diagnose, prescribe, or claim a medicine is safe for a person. For medical advice, direct the customer to a doctor or pharmacist. You can answer store questions, ordering guidance, and general greetings.'
        },
        { role: 'user', content: customerMessage }
      ]
    })
  });
  if (!result.ok) throw new Error(`AI API returned ${result.status}: ${await result.text()}`);
  const data = await result.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function buildCustomerReply(text) {
  const normalized = text.toLowerCase();
  const greetings = ['hi', 'hello', 'hey', 'namaste', 'good morning', 'good evening', 'help'];
  if (greetings.some((greeting) => normalized === greeting || normalized.startsWith(`${greeting} `))) {
    return 'Hello! 👋 Welcome to *Gangotri Medical Agencies*.\n\nYou can ask me about medicine stock, prices, store information, or how to place an order.';
  }
  if (/(address|location|where|shop|store|open|timing|time)/.test(normalized)) {
    return '📍 *Gangotri Medical Agencies*\nBalaghat (M.P.)\n\nPlease call the store for today’s opening hours and delivery availability.';
  }
  if (/(price|cost|rate|available|stock|medicine|tablet|capsule|syrup)/.test(normalized)) {
    return formatStockReply(text, await findStock(text));
  }
  return (await askAi(text)) || 'Thanks for your message! I can help with medicine stock, prices, store information, and orders. Please tell me the medicine name or your question.';
}

async function findStock(searchTerm) {
  if (!supabase) throw new Error('Database is not configured');
  const { data, error } = await supabase.from('stock').select('name, quantity, price').ilike('name', `%${searchTerm}%`).order('name').limit(5);
  if (error) throw error;
  return data || [];
}

function formatStockReply(searchTerm, rows) {
  if (!rows.length) return `Hello! Thanks for contacting *Gangotri Medical Agencies*.\n\n❌ Sorry, *"${searchTerm}"* was not found in today's stock record.\n\nPlease double-check the spelling or visit our store counter.`;
  const lines = rows.map((medicine) => medicine.quantity > 0
    ? `✅ *${medicine.name}*\n• Status: IN STOCK (${medicine.quantity} available)`
    : `❌ *${medicine.name}*\n• Status: OUT OF STOCK`);
  return `Hello! Thanks for contacting *Gangotri Medical Agencies*.\n\n📋 *Stock Status for "${searchTerm}":*\n\n${lines.join('\n\n')}\n\n📍 *Gangotri Medical Agencies*\nBalaghat (M.P.)`;
}

app.get('/api/health', (_request, response) => response.json({
  ok: true,
  databaseConfigured: Boolean(supabase),
  whatsappConfigured: Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
}));

app.get('/api/stock', requireDatabase, async (_request, response, next) => {
  try {
    const { data, error } = await supabase.from('stock').select('name, quantity, price').order('name');
    if (error) throw error;
    response.json(data || []);
  } catch (error) { next(error); }
});

app.post('/api/stock', requireDatabase, async (request, response, next) => {
  try {
    const { name, quantity, price } = request.body;
    if (!name || !Number.isInteger(Number(quantity)) || Number(quantity) < 0 || Number(price) < 0) {
      return response.status(400).json({ error: 'Name, non-negative quantity, and non-negative price are required.' });
    }
    const { data, error } = await supabase.from('stock')
      .upsert({ name: String(name).trim(), quantity: Number(quantity), price: Number(price) }, { onConflict: 'name' }).select().single();
    if (error) throw error;
    return response.status(201).json(data);
  } catch (error) { return next(error); }
});

app.delete('/api/stock/:name', requireDatabase, async (request, response, next) => {
  try {
    const { error } = await supabase.from('stock').delete().eq('name', request.params.name);
    if (error) throw error;
    response.status(204).end();
  } catch (error) { next(error); }
});

app.post('/api/messages', async (request, response, next) => {
  try {
    const { to, message } = request.body;
    if (!/^\d{8,15}$/.test(String(to || '')) || !message || String(message).length > 4096) {
      return response.status(400).json({ error: 'Use a phone number with country code and a message up to 4096 characters.' });
    }
    const result = await sendWhatsAppMessage(String(to), String(message));
    return response.status(201).json({ id: result.messages?.[0]?.id || null });
  } catch (error) { return next(error); }
});

app.get('/webhook/whatsapp', (request, response) => {
  if (request.query['hub.verify_token'] !== process.env.WHATSAPP_VERIFY_TOKEN) return response.sendStatus(403);
  return response.status(200).send(request.query['hub.challenge']);
});

app.post('/webhook/whatsapp', async (request, response) => {
  if (!verifyWhatsAppSignature(request)) return response.sendStatus(403);
  response.sendStatus(200);
  const messages = request.body.entry?.flatMap((entry) => entry.changes || [])
    .flatMap((change) => change.value?.messages || []) || [];
  for (const message of messages) {
    if (message.type !== 'text' || !message.from) continue;
    try {
      const text = message.text.body.trim();
      await sendWhatsAppMessage(message.from, await buildCustomerReply(text));
    } catch (error) { console.error('Webhook message handling failed:', error.message); }
  }
});

app.get('/{*splat}', (_request, response) => response.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: 'The server could not complete that request.' });
});
app.listen(port, () => console.log(`Gangotri dashboard listening on port ${port}`));
