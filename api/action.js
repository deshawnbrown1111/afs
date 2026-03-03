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

// ── JOIN SERVER VIA INVITE ──
async function handleJoin(res, token, { invite }) {
  if (!invite) return res.status(400).json({ ok: false, error: 'Missing invite code' });

  try {
    const r    = await fetch(`${DISCORD_API}/invites/${invite}`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/json',
        'X-Context-Properties': 'eyJsb2NhdGlvbiI6Ikpva...',  // base64 of {"location":"Join Guild"}
      },
      body: JSON.stringify({}),
    });
    const data = await r.json();
    if (!r.ok) return res.status(200).json({ ok: false, error: data?.message || `HTTP ${r.status}` });
    return res.status(200).json({ ok: true, guild_name: data?.guild?.name || invite });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}

// ── OPEN DM CHANNEL THEN SEND MESSAGE ──
async function handleDm(res, token, { targetId, message }) {
  if (!targetId)       return res.status(400).json({ ok: false, error: 'Missing targetId' });
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

    const channelId = chanData.id;

    // Send message
    const msgRes  = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
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
async function handleFriendRequest(res, token, { username, discriminator }) {
  if (!username) return res.status(400).json({ ok: false, error: 'Missing username' });

  try {
    // Discord's new username system uses discriminator "0" for pomelo users
    const body = discriminator && discriminator !== '0'
      ? { username, discriminator: parseInt(discriminator, 10) }
      : { username };

    const r    = await fetch(`${DISCORD_API}/users/@me/relationships`, {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // 204 = success (no body)
    if (r.status === 204) return res.status(200).json({ ok: true });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(200).json({ ok: false, error: data?.message || `HTTP ${r.status}` });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}
