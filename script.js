// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
const state = {
  display:   { results: [], filter: 'all' },
  username:  { results: [], filter: 'all' },
  server:    { results: [], filter: 'all' },
  joiner:    { log: [], filter: 'all' },
  dmspam:    { log: [], filter: 'all' },
  chanspam:  { log: [], filter: 'all' },
  friendreq: { log: [], filter: 'all' },
};

const PANEL_TITLES = {
  display:   'Display Checker',
  username:  'Username Checker',
  server:    'Server Checker',
  joiner:    'Server Joiner',
  dmspam:    'DM Spammer',
  chanspam:  'Channel Spammer',
  friendreq: 'Friend Requester',
};

// Stop flags for action panels
const stopFlags = { joiner: false, dmspam: false, chanspam: false, friendreq: false };

// ─────────────────────────────────────────────
//  PANEL SWITCH
// ─────────────────────────────────────────────
function switchPanel(name, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  el.classList.add('active');
  document.getElementById('topbarTitle').textContent = PANEL_TITLES[name];
  // Update topbar stats for checker panels
  if (['display','username','server'].includes(name)) updateStats(name);
}

// ─────────────────────────────────────────────
//  TOKEN PARSING
// ─────────────────────────────────────────────
function parseTokens(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const seen = new Set();
  const parsed = [];

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(':');
    let token, user, pass, format;

    if (parts.length === 1) {
      token = parts[0].trim(); user = null; pass = null; format = 'token';
    } else if (parts.length === 2) {
      user = parts[0].trim(); token = parts[1].trim(); pass = null; format = 'user:token';
    } else {
      token = parts[parts.length - 1].trim();
      pass  = parts[parts.length - 2].trim();
      user  = parts.slice(0, parts.length - 2).join(':').trim();
      format = 'combo';
    }

    if (!token || token.length < 50) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    parsed.push({ raw: line, token, user, pass, format });
  }
  return parsed;
}

// ─────────────────────────────────────────────
//  REAL API CALL  → Vercel serverless /api/check
// ─────────────────────────────────────────────
async function checkToken(parsed, type) {
  try {
    const res = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: parsed.token, type }),
    });
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { valid: false, parsed, error: `Server error ${res.status}` };
    const data = await res.json();
    if (!res.ok || data.error) return { valid: false, parsed, error: data.error || `HTTP ${res.status}` };
    return { valid: true, parsed, ...data };
  } catch (err) {
    return { valid: false, parsed, error: err.message };
  }
}

// ─────────────────────────────────────────────
//  LIVE TEXTAREA COUNTERS
// ─────────────────────────────────────────────
const allPanels = ['display','username','server','joiner','dmspam','chanspam','friendreq'];

allPanels.forEach(panel => {
  const ta = document.getElementById(panel + '-input');
  if (!ta) return;
  ta.addEventListener('input', () => {
    const tokens = parseTokens(ta.value);
    const det = document.getElementById(panel + '-detected');
    const lbl = document.getElementById(panel + '-count-label');
    if (det) det.textContent = tokens.length;
    if (lbl) lbl.textContent = tokens.length + ' tokens';
  });

  const dz = document.getElementById(panel + '-drop');
  if (dz) {
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', e => {
      e.preventDefault(); dz.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) loadFile(file, panel);
    });
  }
});

// ─────────────────────────────────────────────
//  FILE HANDLING
// ─────────────────────────────────────────────
function handleFile(evt, panel) {
  const file = evt.target.files[0];
  if (file) loadFile(file, panel);
}

function loadFile(file, panel) {
  const reader = new FileReader();
  reader.onload = e => {
    const ta = document.getElementById(panel + '-input');
    const existing = ta.value.trim();
    ta.value = existing ? existing + '\n' + e.target.result.trim() : e.target.result.trim();
    ta.dispatchEvent(new Event('input'));
  };
  reader.readAsText(file);
}

// ─────────────────────────────────────────────
//  CLEAR (checker panels)
// ─────────────────────────────────────────────
function clearAll(panel) {
  document.getElementById(panel + '-input').value = '';
  const det = document.getElementById(panel + '-detected');
  const lbl = document.getElementById(panel + '-count-label');
  if (det) det.textContent = '0';
  if (lbl) lbl.textContent = '0 tokens';
  state[panel].results = [];
  renderResults(panel);
  updateStats(panel);
}

// ─────────────────────────────────────────────
//  RUN CHECK  (checker panels — concurrency 3)
// ─────────────────────────────────────────────
const running = {};

async function runCheck(panel) {
  if (running[panel]) return;
  const raw    = document.getElementById(panel + '-input').value;
  const tokens = parseTokens(raw);
  if (!tokens.length) { showToast('No valid tokens detected.'); return; }

  running[panel]       = true;
  state[panel].results = [];
  state[panel].filter  = 'all';

  document.querySelectorAll(`#panel-${panel} .rtab`).forEach((b, i) => b.classList.toggle('active', i === 0));
  document.getElementById(panel + '-run-btn').disabled = true;
  document.body.classList.add('scanning');

  const progWrap = document.getElementById(panel + '-progress-wrap');
  const progFill = document.getElementById(panel + '-prog-fill');
  const progText = document.getElementById(panel + '-prog-text');
  progWrap.style.display = 'block';
  progFill.style.width   = '0%';

  renderResults(panel);

  const total = tokens.length;
  let   done  = 0;
  const queue = [...tokens];

  const workers = Array(Math.min(3, total)).fill(null).map(async () => {
    while (queue.length > 0) {
      const parsed = queue.shift();
      const result = await checkToken(parsed, panel);
      state[panel].results.push(result);
      done++;
      progFill.style.width = Math.round(done / total * 100) + '%';
      progText.textContent = done + ' / ' + total;
      appendResultRow(panel, result);
      updateTabCounts(panel);
      updateStats(panel);
    }
  });

  await Promise.all(workers);

  running[panel] = false;
  document.getElementById(panel + '-run-btn').disabled = false;
  document.body.classList.remove('scanning');
  setTimeout(() => { progWrap.style.display = 'none'; }, 1500);
}

// ─────────────────────────────────────────────
//  RENDER HELPERS
// ─────────────────────────────────────────────
function renderResults(panel) {
  const scroll  = document.getElementById(panel + '-results-scroll');
  const filter  = state[panel].filter;
  const results = state[panel].results;

  const filtered = results.filter(r =>
    filter === 'all' ? true : filter === 'valid' ? r.valid : !r.valid
  );

  scroll.innerHTML = filtered.length === 0
    ? getEmptyHTML(panel)
    : filtered.map(r => buildRowHTML(r, panel)).join('');

  updateTabCounts(panel);
}

function appendResultRow(panel, result) {
  const scroll = document.getElementById(panel + '-results-scroll');
  const empty  = scroll.querySelector('.empty-state');
  if (empty) empty.remove();

  const filter = state[panel].filter;
  const show   = filter === 'all' ? true : filter === 'valid' ? result.valid : !result.valid;
  if (show) scroll.insertAdjacentHTML('beforeend', buildRowHTML(result, panel));
}

function getEmptyHTML() {
  return `<div class="empty-state"><div class="empty-icon">🔍</div><div>No results yet.</div></div>`;
}

function buildRowHTML(r, panel) {
  const t = r.parsed.token;
  const tokenShort = t.length > 36 ? t.slice(0,16) + '…' + t.slice(-8) : t;
  const statusBadge = r.valid
    ? `<span class="status-badge valid">◆ VALID</span>`
    : `<span class="status-badge invalid">✕ INVALID</span>`;

  let infoHTML = '';
  if (r.valid) {
    if (panel === 'display') {
      infoHTML = `
        <div class="info-line"><span class="info-key">name&nbsp;</span><span class="info-val highlight">${esc(r.global_name || r.username || '—')}</span></div>
        <div class="info-line"><span class="info-key">id&nbsp;&nbsp;&nbsp;</span><span class="info-val">${esc(r.id || '—')}</span></div>
        ${r.nitro ? `<div class="info-line"><span class="nitro-badge">⚡ ${esc(r.nitro)}</span></div>` : ''}`;
    } else if (panel === 'username') {
      const uname = r.discriminator && r.discriminator !== '0'
        ? `${r.username}#${r.discriminator}` : (r.username || '—');
      infoHTML = `
        <div class="info-line"><span class="info-key">user&nbsp;</span><span class="info-val highlight">${esc(uname)}</span></div>
        <div class="info-line"><span class="info-key">id&nbsp;&nbsp;&nbsp;</span><span class="info-val">${esc(r.id || '—')}</span></div>
        ${r.nitro ? `<div class="info-line"><span class="nitro-badge">⚡ ${esc(r.nitro)}</span></div>` : ''}`;
    } else {
      const count = r.guild_count != null ? r.guild_count : (r.guilds ? r.guilds.length : '?');
      const first = r.guilds && r.guilds[0] ? r.guilds[0].name : '—';
      infoHTML = `
        <div class="info-line"><span class="info-key">servers&nbsp;</span><span class="info-val highlight">${count}</span></div>
        <div class="info-line"><span class="info-key">first&nbsp;&nbsp;&nbsp;</span><span class="info-val">${esc(first)}</span></div>
        ${r.nitro ? `<div class="info-line"><span class="nitro-badge">⚡ ${esc(r.nitro)}</span></div>` : ''}`;
    }
  } else {
    infoHTML = `<div class="info-line"><span class="info-key">reason&nbsp;</span><span class="info-val">${esc(r.error || '401 Unauthorized')}</span></div>`;
  }

  const userLine = r.parsed.user ? `<span class="token-user">${esc(r.parsed.user)}</span>` : '';
  const rawEsc   = r.parsed.raw.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  return `<div class="result-row">
    <div class="col-token">${userLine}${tokenShort}</div>
    <div class="col-status">${statusBadge}</div>
    <div class="col-info">${infoHTML}</div>
    <div class="col-copy"><button class="copy-btn" onclick="copyToken('${rawEsc}')">copy</button></div>
  </div>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────
//  FILTER TABS (checkers)
// ─────────────────────────────────────────────
function filterResults(panel, filter, btn) {
  state[panel].filter = filter;
  btn.closest('.results-tabs').querySelectorAll('.rtab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderResults(panel);
}

function updateTabCounts(panel) {
  const results = state[panel].results;
  const valid   = results.filter(r => r.valid).length;
  const invalid = results.filter(r => !r.valid).length;
  const tabAll  = document.getElementById(panel + '-tab-all');
  const tabV    = document.getElementById(panel + '-tab-valid');
  const tabI    = document.getElementById(panel + '-tab-invalid');
  if (tabAll) tabAll.textContent = results.length;
  if (tabV)   tabV.textContent   = valid;
  if (tabI)   tabI.textContent   = invalid;
}

function updateStats(panel) {
  const results = state[panel].results;
  const valid   = results.filter(r => r.valid).length;
  const invalid = results.filter(r => !r.valid).length;
  document.getElementById('statValid').textContent   = valid;
  document.getElementById('statInvalid').textContent = invalid;
  document.getElementById('statTotal').textContent   = results.length;
}

// ─────────────────────────────────────────────
//  EXPORT (checkers)
// ─────────────────────────────────────────────
function exportResults(panel, filter, format) {
  const results = filter === 'valid'
    ? state[panel].results.filter(r => r.valid)
    : state[panel].results;
  if (!results.length) { showToast('Nothing to export.'); return; }

  let content, filename = `discord_${panel}_${filter}`;
  if (format === 'token') {
    content = results.map(r => r.parsed.token).join('\n'); filename += '_tokens.txt';
  } else if (format === 'combo') {
    content = results.map(r => r.parsed.raw).join('\n'); filename += '_combos.txt';
  } else {
    const clean = results.map(r => ({ token: r.parsed.token, user: r.parsed.user||null, valid: r.valid, id: r.id, username: r.username, global_name: r.global_name, nitro: r.nitro, error: r.error }));
    content = JSON.stringify(clean, null, 2); filename += '.json';
  }
  downloadText(content, filename);
}

// ─────────────────────────────────────────────
//  COPY
// ─────────────────────────────────────────────
function copyToken(raw) {
  navigator.clipboard.writeText(raw).catch(() => {
    const el = document.createElement('textarea');
    el.value = raw; document.body.appendChild(el); el.select();
    document.execCommand('copy'); document.body.removeChild(el);
  });
}

// ─────────────────────────────────────────────
//  TOAST
// ─────────────────────────────────────────────
function showToast(msg, type = 'error', duration = 3000) {
  const t = document.createElement('div');
  t.className   = 'toast' + (type === 'success' ? ' success' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ─────────────────────────────────────────────
//  DOWNLOAD HELPER
// ─────────────────────────────────────────────
function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ═════════════════════════════════════════════
//  ACTION PANEL SHARED HELPERS
// ═════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Append a log row to an action panel's results scroll */
function appendActionRow(panel, tokenRaw, success, info) {
  const scroll = document.getElementById(panel + '-results-scroll');
  const empty  = scroll.querySelector('.empty-state');
  if (empty) empty.remove();

  const entry = { tokenRaw, success, info };
  state[panel].log.push(entry);

  const filter = state[panel].filter;
  const show   = filter === 'all' ? true : filter === 'success' ? success : !success;
  if (show) scroll.insertAdjacentHTML('beforeend', buildActionRowHTML(entry, tokenRaw));

  // Update tab counts
  const log     = state[panel].log;
  const succCnt = log.filter(e => e.success).length;
  const failCnt = log.filter(e => !e.success).length;
  const tabAll  = document.getElementById(panel + '-tab-all');
  const tabS    = document.getElementById(panel + '-tab-success');
  const tabF    = document.getElementById(panel + '-tab-fail');
  if (tabAll) tabAll.textContent = log.length;
  if (tabS)   tabS.textContent   = succCnt;
  if (tabF)   tabF.textContent   = failCnt;
}

function buildActionRowHTML(entry, tokenRaw) {
  const t = tokenRaw.length > 36 ? tokenRaw.slice(0,16) + '…' + tokenRaw.slice(-8) : tokenRaw;
  const badge = entry.success
    ? `<span class="status-badge valid">◆ OK</span>`
    : `<span class="status-badge invalid">✕ FAIL</span>`;
  const rawEsc = tokenRaw.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  return `<div class="result-row">
    <div class="col-token">${esc(t)}</div>
    <div class="col-status">${badge}</div>
    <div class="col-info"><div class="info-line"><span class="info-val ${entry.success ? 'highlight' : ''}">${esc(entry.info)}</span></div></div>
    <div class="col-copy"><button class="copy-btn" onclick="copyToken('${rawEsc}')">copy</button></div>
  </div>`;
}

/** Re-render an action log with current filter */
function filterAction(panel, filter, btn) {
  state[panel].filter = filter;
  btn.closest('.results-tabs').querySelectorAll('.rtab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const scroll = document.getElementById(panel + '-results-scroll');
  const log    = state[panel].log;
  const filtered = log.filter(e =>
    filter === 'all' ? true : filter === 'success' ? e.success : !e.success
  );

  if (!filtered.length) {
    scroll.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div>No entries.</div></div>`;
  } else {
    scroll.innerHTML = filtered.map(e => buildActionRowHTML(e, e.tokenRaw)).join('');
  }
}

function stopAction(panel) {
  stopFlags[panel] = true;
}

function exportActionLog(panel) {
  const log = state[panel].log;
  if (!log.length) { showToast('Nothing to export.'); return; }
  const content  = log.map(e => `${e.success ? 'OK' : 'FAIL'}\t${e.tokenRaw}\t${e.info}`).join('\n');
  downloadText(content, `${panel}_log.txt`);
}

// ─────────────────────────────────────────────
//  ACTION API CALL  → /api/action
// ─────────────────────────────────────────────
async function callAction(payload) {
  try {
    const res  = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const ct   = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return { ok: false, error: `Server error ${res.status}` };
    const data = await res.json();
    return data;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─────────────────────────────────────────────
//  SERVER JOINER
// ─────────────────────────────────────────────
async function runJoiner() {
  const inviteRaw = document.getElementById('joiner-invite').value.trim();
  const raw       = document.getElementById('joiner-input').value;
  const delay     = Math.max(500, parseInt(document.getElementById('joiner-delay').value) || 1500);
  const tokens    = parseTokens(raw);

  if (!inviteRaw) { showToast('Enter an invite code.'); return; }
  if (!tokens.length) { showToast('No valid tokens detected.'); return; }

  // It's a raw guild/server ID now
  const invite = inviteRaw;

  state.joiner.log = [];
  stopFlags.joiner = false;
  document.getElementById('joiner-results-scroll').innerHTML = '';
  document.getElementById('joiner-run-btn').disabled = true;
  document.body.classList.add('scanning');

  const progWrap  = document.getElementById('joiner-progress-wrap');
  const progFill  = document.getElementById('joiner-prog-fill');
  const progText  = document.getElementById('joiner-prog-text');
  const statusLbl = document.getElementById('joiner-status-label');
  progWrap.style.display = 'block';
  progFill.style.width   = '0%';

  const total = tokens.length;
  let   done  = 0;

  for (const parsed of tokens) {
    if (stopFlags.joiner) { statusLbl.textContent = 'Stopped.'; break; }
    statusLbl.textContent = `Joining with token ${done + 1} / ${total}...`;

    const result = await callAction({ type: 'join', token: parsed.token, invite });
    const success = result.ok === true;
    const info    = success
      ? `Joined: ${result.guild_name || invite}`
      : (result.error || 'Failed');

    appendActionRow('joiner', parsed.raw, success, info);
    done++;
    progFill.style.width = Math.round(done / total * 100) + '%';
    progText.textContent = done + ' / ' + total;

    if (done < total && !stopFlags.joiner) await sleep(delay);
  }

  document.getElementById('joiner-run-btn').disabled = false;
  document.body.classList.remove('scanning');
  setTimeout(() => { progWrap.style.display = 'none'; }, 1500);
}

// ─────────────────────────────────────────────
//  DM SPAMMER
// ─────────────────────────────────────────────
async function runDmSpam() {
  const targetId = document.getElementById('dmspam-target').value.trim();
  const message  = document.getElementById('dmspam-message').value;
  const times    = Math.max(1, Math.min(50, parseInt(document.getElementById('dmspam-count').value) || 1));
  const delay    = Math.max(500, parseInt(document.getElementById('dmspam-delay').value) || 1200);
  const raw      = document.getElementById('dmspam-input').value;
  const tokens   = parseTokens(raw);

  if (!targetId) { showToast('Enter a target user ID.'); return; }
  if (!message.trim()) { showToast('Enter a message.'); return; }
  if (!tokens.length) { showToast('No valid tokens detected.'); return; }

  state.dmspam.log = [];
  stopFlags.dmspam = false;
  document.getElementById('dmspam-results-scroll').innerHTML = '';
  document.getElementById('dmspam-run-btn').disabled = true;
  document.body.classList.add('scanning');

  const progWrap  = document.getElementById('dmspam-progress-wrap');
  const progFill  = document.getElementById('dmspam-prog-fill');
  const progText  = document.getElementById('dmspam-prog-text');
  const statusLbl = document.getElementById('dmspam-status-label');
  progWrap.style.display = 'block';
  progFill.style.width   = '0%';

  const total = tokens.length * times;
  let   done  = 0;

  for (const parsed of tokens) {
    for (let i = 0; i < times; i++) {
      if (stopFlags.dmspam) { statusLbl.textContent = 'Stopped.'; break; }
      statusLbl.textContent = `Sending message ${done + 1} / ${total}...`;

      const result  = await callAction({ type: 'dm', token: parsed.token, targetId, message });
      const success = result.ok === true;
      const info    = success
        ? `Sent to ${targetId} (msg #${i + 1})`
        : (result.error || 'Failed');

      appendActionRow('dmspam', parsed.raw, success, info);
      done++;
      progFill.style.width = Math.round(done / total * 100) + '%';
      progText.textContent = done + ' / ' + total;

      if (!stopFlags.dmspam && (done < total)) await sleep(delay);
    }
    if (stopFlags.dmspam) break;
  }

  document.getElementById('dmspam-run-btn').disabled = false;
  document.body.classList.remove('scanning');
  setTimeout(() => { progWrap.style.display = 'none'; }, 1500);
}

// ─────────────────────────────────────────────
//  CHANNEL SPAMMER
// ─────────────────────────────────────────────
async function runChanSpam() {
  const channelId = document.getElementById('chanspam-channel').value.trim();
  const message   = document.getElementById('chanspam-message').value;
  const times     = Math.max(1, Math.min(50, parseInt(document.getElementById('chanspam-count').value) || 1));
  const delay     = Math.max(300, parseInt(document.getElementById('chanspam-delay').value) || 1000);
  const raw       = document.getElementById('chanspam-input').value;
  const tokens    = parseTokens(raw);

  if (!channelId) { showToast('Enter a channel ID.'); return; }
  if (!message.trim()) { showToast('Enter a message.'); return; }
  if (!tokens.length) { showToast('No valid tokens detected.'); return; }

  state.chanspam.log = [];
  stopFlags.chanspam = false;
  document.getElementById('chanspam-results-scroll').innerHTML = '';
  document.getElementById('chanspam-run-btn').disabled = true;
  document.body.classList.add('scanning');

  const progWrap  = document.getElementById('chanspam-progress-wrap');
  const progFill  = document.getElementById('chanspam-prog-fill');
  const progText  = document.getElementById('chanspam-prog-text');
  const statusLbl = document.getElementById('chanspam-status-label');
  progWrap.style.display = 'block';
  progFill.style.width   = '0%';

  const total = tokens.length * times;
  let   done  = 0;

  for (const parsed of tokens) {
    for (let i = 0; i < times; i++) {
      if (stopFlags.chanspam) { statusLbl.textContent = 'Stopped.'; break; }
      statusLbl.textContent = `Sending message ${done + 1} / ${total}...`;

      const result  = await callAction({ type: 'channel_message', token: parsed.token, channelId, message });
      const success = result.ok === true;
      const info    = success
        ? `Sent to #${channelId} (msg #${i + 1})`
        : (result.error || 'Failed');

      appendActionRow('chanspam', parsed.raw, success, info);
      done++;
      progFill.style.width = Math.round(done / total * 100) + '%';
      progText.textContent = done + ' / ' + total;

      if (!stopFlags.chanspam && done < total) await sleep(delay);
    }
    if (stopFlags.chanspam) break;
  }

  document.getElementById('chanspam-run-btn').disabled = false;
  document.body.classList.remove('scanning');
  setTimeout(() => { progWrap.style.display = 'none'; }, 1500);
}

// ─────────────────────────────────────────────
//  FRIEND REQUESTER
// ─────────────────────────────────────────────
async function runFriendReq() {
  const targetUsername = document.getElementById('friendreq-target').value.trim();
  const delay          = Math.max(500, parseInt(document.getElementById('friendreq-delay').value) || 1500);
  const raw            = document.getElementById('friendreq-input').value;
  const tokens         = parseTokens(raw);

  if (!targetUsername) { showToast('Enter a target username.'); return; }
  if (!tokens.length)  { showToast('No valid tokens detected.'); return; }

  // Parse username + optional discriminator
  let username = targetUsername, discriminator = '0';
  if (targetUsername.includes('#')) {
    [username, discriminator] = targetUsername.split('#');
  }

  state.friendreq.log = [];
  stopFlags.friendreq = false;
  document.getElementById('friendreq-results-scroll').innerHTML = '';
  document.getElementById('friendreq-run-btn').disabled = true;
  document.body.classList.add('scanning');

  const progWrap  = document.getElementById('friendreq-progress-wrap');
  const progFill  = document.getElementById('friendreq-prog-fill');
  const progText  = document.getElementById('friendreq-prog-text');
  const statusLbl = document.getElementById('friendreq-status-label');
  progWrap.style.display = 'block';
  progFill.style.width   = '0%';

  const total = tokens.length;
  let   done  = 0;

  for (const parsed of tokens) {
    if (stopFlags.friendreq) { statusLbl.textContent = 'Stopped.'; break; }
    statusLbl.textContent = `Sending request ${done + 1} / ${total}...`;

    const result  = await callAction({ type: 'friend_request', token: parsed.token, username, discriminator });
    const success = result.ok === true;
    const info    = success
      ? `Request sent to ${targetUsername}`
      : (result.error || 'Failed');

    appendActionRow('friendreq', parsed.raw, success, info);
    done++;
    progFill.style.width = Math.round(done / total * 100) + '%';
    progText.textContent = done + ' / ' + total;

    if (done < total && !stopFlags.friendreq) await sleep(delay);
  }

  document.getElementById('friendreq-run-btn').disabled = false;
  document.body.classList.remove('scanning');
  setTimeout(() => { progWrap.style.display = 'none'; }, 1500);
}
