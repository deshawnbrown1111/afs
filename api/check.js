// api/check.js  —  Discord token checker proxy
const DISCORD_API = 'https://discord.com/api/v10';

const NITRO_TYPES = { 0: null, 1: 'Nitro Classic', 2: 'Nitro', 3: 'Nitro Basic' };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, type } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Missing token' });
  if (!['display','username','server'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  let userRes, userData;
  try {
    userRes  = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: token } });
    userData = await userRes.json();
  } catch {
    return res.status(502).json({ error: 'Failed to reach Discord API' });
  }

  if (!userRes.ok) return res.status(200).json({ valid: false, error: userData?.message || `HTTP ${userRes.status}` });

  const nitro = NITRO_TYPES[userData.premium_type] ?? null;

  if (type === 'display') {
    return res.status(200).json({ valid: true, id: userData.id, username: userData.username, global_name: userData.global_name || null, discriminator: userData.discriminator, avatar: userData.avatar, nitro });
  }

  if (type === 'username') {
    return res.status(200).json({ valid: true, id: userData.id, username: userData.username, global_name: userData.global_name || null, discriminator: userData.discriminator, nitro });
  }

  // server
  let guildsRes, guildsData;
  try {
    guildsRes  = await fetch(`${DISCORD_API}/users/@me/guilds`, { headers: { Authorization: token } });
    guildsData = await guildsRes.json();
  } catch {
    return res.status(200).json({ valid: true, id: userData.id, username: userData.username, nitro, guild_count: 0, guilds: [], error: 'Could not fetch guilds' });
  }

  const guilds = guildsRes.ok && Array.isArray(guildsData)
    ? guildsData.map(g => ({ id: g.id, name: g.name, owner: g.owner, permissions: g.permissions }))
    : [];

  return res.status(200).json({ valid: true, id: userData.id, username: userData.username, global_name: userData.global_name || null, nitro, guild_count: guilds.length, guilds });
}
