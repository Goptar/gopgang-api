require('dotenv').config();

const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
app.use(express.json());

// ---- CONFIG ----
const INGAME_API_KEY = process.env.INGAME_API_KEY || 'change-this-secret';
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;

// Roblox gamepasses base URL (official source)
const ROBLOX_GAMEPASSES_BASE = 'https://apis.roblox.com/game-passes/v1';

// ---- SIMPLE DATA STORAGE (in memory) ----
const players = new Map(); // key: userId, value: { userId, username, raised, donated }

// Record donations coming from the Roblox game
function recordDonation(payload) {
  const {
    donatorUserId,
    donatorName,
    recipientUserId,
    recipientName,
    amount,
  } = payload;

  // donor
  let donor = players.get(donatorUserId);
  if (!donor) {
    donor = { userId: donatorUserId, username: donatorName, raised: 0, donated: 0 };
    players.set(donatorUserId, donor);
  }
  donor.username = donatorName || donor.username;
  donor.donated += amount;

  // recipient
  let recipient = players.get(recipientUserId);
  if (!recipient) {
    recipient = { userId: recipientUserId, username: recipientName, raised: 0, donated: 0 };
    players.set(recipientUserId, recipient);
  }
  recipient.username = recipientName || recipient.username;
  recipient.raised += amount;
}

// ---- 1) ENDPOINT CALLED FROM ROBLOX GAME FOR DONATIONS ----
app.post('/ingame/donation', (req, res) => {
  const apiKey = req.header('X-Api-Key');
  if (apiKey !== INGAME_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    donatorUserId,
    donatorName,
    recipientUserId,
    recipientName,
    amount,
    placeId,
    jobId,
    timestamp,
  } = req.body;

  if (!donatorUserId || !recipientUserId || !amount) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  recordDonation({
    donatorUserId,
    donatorName,
    recipientUserId,
    recipientName,
    amount,
  });

  console.log(
    `[DONATION] ${donatorName} (${donatorUserId}) -> ${recipientName} (${recipientUserId}) : ${amount} R$`,
    `place=${placeId} job=${jobId} ts=${timestamp}`,
  );

  res.json({ ok: true });
});

// ---- 2) PUBLIC ENDPOINTS FOR STATS (OPTIONAL) ----
app.get('/api/top-raised', (req, res) => {
  const limit = Number(req.query.limit) || 10;
  const list = [...players.values()]
    .sort((a, b) => b.raised - a.raised)
    .slice(0, limit);
  res.json(list);
});

app.get('/api/top-donated', (req, res) => {
  const limit = Number(req.query.limit) || 10;
  const list = [...players.values()]
    .sort((a, b) => b.donated - a.donated)
    .slice(0, limit);
  res.json(list);
});

// ---- 3) PLACE -> UNIVERSE ID ENDPOINT ----
// Usage: GET /universe-id?placeId=123456789
app.get('/universe-id', async (req, res) => {
  const placeId = req.query.placeId;

  if (!placeId) {
    return res.status(400).json({ error: 'placeId query parameter is required' });
  }

  try {
    const url = `https://apis.roblox.com/universes/v1/places/${placeId}/universe`;
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      console.error('Roblox API error (universe):', response.status, text);
      return res.status(response.status).json({
        error: 'Roblox API error',
        status: response.status,
        body: text,
      });
    }

    const data = await response.json();
    return res.json({
      placeId: String(placeId),
      universeId: data.universeId,
      raw: data,
    });
  } catch (err) {
    console.error('Error talking to Roblox universe API:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---- 4) NEW: GAMEPASSES BY UNIVERSE ID ----
// Usage: GET /universe-game-passes?universeId=4130052554&passView=Full&pageSize=100
app.get('/universe-game-passes', async (req, res) => {
  const universeId = req.query.universeId;

  if (!universeId) {
    return res.status(400).json({ error: 'universeId query parameter is required' });
  }

  const passView = req.query.passView || 'Full';
  const pageSize = req.query.pageSize || '100';
  const pageToken = req.query.pageToken || '';

  const params = new URLSearchParams();
  params.set('passView', passView);
  params.set('pageSize', pageSize);
  if (pageToken) {
    params.set('pageToken', pageToken);
  }

  const url = `${ROBLOX_GAMEPASSES_BASE}/universes/${universeId}/game-passes?${params.toString()}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      const text = await response.text();
      console.error('Roblox API error (gamepasses):', response.status, text);
      return res.status(response.status).json({
        error: 'Roblox API error',
        status: response.status,
        body: text,
      });
    }

    const data = await response.json();
    // Roblox already returns { gamePasses: [...], nextPageToken: "..." }
    return res.json(data);
  } catch (err) {
    console.error('Error talking to Roblox gamepasses API:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

// ---- DISCORD BOT ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// Simple text commands: !topraised and !topdonated
client.on('messageCreate', (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content.startsWith('!topraised')) {
    const list = [...players.values()]
      .sort((a, b) => b.raised - a.raised)
      .slice(0, 10);

    if (list.length === 0) {
      return message.reply("I don't have any data yet. Make a donation in-game first!");
    }

    let reply = '**Top Raised:**\n';
    list.forEach((p, i) => {
      reply += `${i + 1}. ${p.username} (${p.userId}) – ${p.raised} R$\n`;
    });

    message.reply(reply);
  }

  if (content.startsWith('!topdonated')) {
    const list = [...players.values()]
      .sort((a, b) => b.donated - a.donated)
      .slice(0, 10);

    if (list.length === 0) {
      return message.reply("I don't have any data yet. Make a donation in-game first!");
    }

    let reply = '**Top Donated:**\n';
    list.forEach((p, i) => {
      reply += `${i + 1}. ${p.username} (${p.userId}) – ${p.donated} R$\n`;
    });

    message.reply(reply);
  }
});

// ---- START EVERYTHING ----
app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

client.login(BOT_TOKEN);
