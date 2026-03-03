// api/action.js  —  Discord action proxy (join, dm, channel message, friend request)
const DISCORD_API = 'https://discord.com/api/v10';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { type, token, ...params } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ ok: false, error: 'Missing token' });

  switch (type) {
    case 'join':            return handleJoin(res, token, params);
    case 'dm':              return handleDm(res, token, params);
    case 'channel_message': return handleChannelMessage(res, token, params);
    case 'friend_request':  return handleFriendRequest(res, token, params);
    default:                return res.status(400).json({ ok: false, error: 'Unknown action type' });
  }
}

// ── JOIN SERVER VIA GUILD ID ──
// Uses the guild preview + member join endpoint.
// The token must already have an invite or the server must be public/discoverable.
// For most use cases: PUT /guilds/{guild.id}/members/@me
async function handleJoin(res, token, { invite }) {
  const guildId = (invite || '').trim();
  if (!guildId) return res.status(400).json({ ok: false, error: 'Missing guild ID' });

  try {
    // First fetch guild info so we can return the name
    const infoRes  = await fetch(`${DISCORD_API}/guilds/${guildId}/preview`, {
      headers: { Authorization: token },
    });
    const infoData = infoRes.ok ? await infoRes.json() : {};
    const guildName = infoData?.name || guildId;

    // Join the guild
    const r = await fetch(`${DISCORD_API}/guilds/${guildId}/members/@me`, {
      method: 'PUT',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    // 201 = joined, 204 = already a member (both are success)
    if (r.status === 201 || r.status === 204) {
      return res.status(200).json({ ok: true, guild_name: guildName });
    }

    let errMsg = `HTTP ${r.status}`;
    try { const d = await r.json(); errMsg = d?.message || errMsg; } catch (_) {}
    return res.status(200).json({ ok: false, error: errMsg });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── OPEN DM CHANNEL THEN SEND MESSAGE ──
async function handleDm(res, token, { targetId, message }) {
  if (!targetId)        return res.status(400).json({ ok: false, error: 'Missing targetId' });
  if (!message?.trim()) return res.status(400).json({ ok: false, error: 'Missing message' });

  try {
    // Open (or get existing) DM channel
    const chanRes  = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient_id: targetId }),
    });
    const chanData = await chanRes.json();
    if (!chanRes.ok) return res.status(200).json({ ok: false, error: chanData?.message || `DM open failed ${chanRes.status}` });

    // Send message
    const msgRes  = await fetch(`${DISCORD_API}/channels/${chanData.id}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    const msgData = await msgRes.json();
    if (!msgRes.ok) return res.status(200).json({ ok: false, error: msgData?.message || `Send failed ${msgRes.status}` });

    return res.status(200).json({ ok: true, message_id: msgData.id });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── SEND MESSAGE TO CHANNEL ──
async function handleChannelMessage(res, token, { channelId, message }) {
  if (!channelId)       return res.status(400).json({ ok: false, error: 'Missing channelId' });
  if (!message?.trim()) return res.status(400).json({ ok: false, error: 'Missing message' });

  try {
    const r    = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(200).json({ ok: false, error: data?.message || `HTTP ${r.status}` });
    return res.status(200).json({ ok: true, message_id: data.id });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── SEND FRIEND REQUEST ──
// Discord API v10 behaviour:
//   New-style usernames (pomelo, no discriminator):
//     POST /users/@me/relationships  { "username": "john" }
//   Legacy usernames (still on tag system):
//     POST /users/@me/relationships  { "username": "john", "discriminator": 1234 }
//
// Sending discriminator=0 or discriminator="0" causes HTTP 400 — omit it entirely for new accounts.
async function handleFriendRequest(res, token, { username, discriminator }) {
  if (!username) return res.status(400).json({ ok: false, error: 'Missing username' });

  // Build body — only include discriminator when it's a real legacy tag (non-zero number)
  const discNum = parseInt(discriminator, 10);
  const body    = (discNum && discNum !== 0)
    ? { username: username.trim(), discriminator: discNum }
    : { username: username.trim() };

  try {
    const r = await fetch(`${DISCORD_API}/users/@me/relationships`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        // Required by Discord — without this the endpoint returns 400 or 404
        'X-Discord-Locale': 'en-US',
      },
      body: JSON.stringify(body),
    });

    // 204 No Content = success
    if (r.status === 204) return res.status(200).json({ ok: true });

    // Some tokens return 200 with empty body on success too
    if (r.status === 200) return res.status(200).json({ ok: true });

    // Anything else = failure — try to parse error message
    let errMsg = `HTTP ${r.status}`;
    try {
      const data = await r.json();
      errMsg = data?.message || errMsg;
    } catch (_) { /* response had no body */ }

    return res.status(200).json({ ok: false, error: errMsg });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}
