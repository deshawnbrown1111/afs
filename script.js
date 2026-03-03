// ─────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────
const state = {
  display:  { results: [], filter: 'all' },
  username: { results: [], filter: 'all' },
  server:   { results: [], filter: 'all' },
};

const PANEL_TITLES = {
  display:  'Display Checker',
  username: 'Username Checker',
  server:   'Server Checker',
};

// ─────────────────────────────────────────────
//  PANEL SWITCH
// ─────────────────────────────────────────────
function switchPanel(name, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  el.classList.add('active');
  document.getElementById('topbarTitle').textContent = PANEL_TITLES[name];
  updateStats(name);
}

// ─────────────────────────────────────────────
//  TOKEN PARSING
//  Handles:
//    token
//    user:pass:token
//    email:pass:token   (email may contain @)
//    user:token         (2-part)
// ─────────────────────────────────────────────
function parseTokens(raw) {
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const seen = new Set();
  const parsed = [];

  for (const line of lines) {
    // Skip blank / comment lines
    if (!line || line.startsWith('#')) continue;

    const parts = line.split(':');
    let token, user, pass, format;

    if (parts.length === 1) {
      // Raw token only
      token  = parts[0].trim();
      user   = null;
      pass   = null;
      format = 'token';
    } else if (parts.length === 2) {
      // user:token
      user   = parts[0].trim();
      token  = parts[1].trim();
      pass   = null;
      format = 'user:token';
    } else {
      // user:pass:token  OR  email:pass:token
      // Token is always the last segment
      token  = parts[parts.length - 1].trim();
      pass   = parts[parts.length - 2].trim();
      user   = parts.slice(0, parts.length - 2).join(':').trim();
      format = 'combo';
    }

    // Basic sanity – Discord tokens are at least 50 chars
    if (!token || token.length < 50) continue;
    // Deduplicate by token
    if (seen.has(token)) continue;
    seen.add(token);

    parsed.push({ raw: line, token, user, pass, format });
  }

  return parsed;
}

// ─────────────────────────────────────────────
//  REAL DISCORD API CHECK  (via Vercel serverless proxy)
// ─────────────────────────────────────────────
async function checkToken(parsed, type) {
  try {
    const res = await fetch('/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: parsed.token, type }),
    });

    // Handle non-JSON errors (e.g. 500 from Vercel)
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return { valid: false, parsed, error: `Server error ${res.status}` };
    }

    const data = await res.json();

    if (!res.ok || data.error) {
      return { valid: false, parsed, error: data.error || `HTTP ${res.status}` };
    }

    return { valid: true, parsed, ...data };
  } catch (err) {
    return { valid: false, parsed, error: err.message };
  }
}

// ─────────────────────────────────────────────
//  TEXTAREA LIVE COUNTERS
// ─────────────────────────────────────────────
['display', 'username', 'server'].forEach(panel => {
  const ta = document.getElementById(panel + '-input');
  ta.addEventListener('input', () => {
    const tokens = parseTokens(ta.value);
    document.getElementById(panel + '-detected').textContent    = tokens.length;
    document.getElementById(panel + '-count-label').textContent = tokens.length + ' tokens';
  });

  // Drag & drop on the drop zone
  const dz = document.getElementById(panel + '-drop');
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file, panel);
  });
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
//  CLEAR
// ─────────────────────────────────────────────
function clearAll(panel) {
  document.getElementById(panel + '-input').value   = '';
  document.getElementById(panel + '-detected').textContent    = '0';
  document.getElementById(panel + '-count-label').textContent = '0 tokens';
  state[panel].results = [];
  renderResults(panel);
  updateStats(panel);
}

// ─────────────────────────────────────────────
//  RUN CHECK   (concurrency = 3)
// ─────────────────────────────────────────────
const running = {};

async function runCheck(panel) {
  if (running[panel]) return;

  const raw    = document.getElementById(panel + '-input').value;
  const tokens = parseTokens(raw);
  if (!tokens.length) { showToast('No valid tokens detected.'); return; }

  running[panel]         = true;
  state[panel].results   = [];
  state[panel].filter    = 'all';

  // Reset filter tab UI
  document.querySelectorAll(`#panel-${panel} .rtab`).forEach((b, i) => {
    b.classList.toggle('active', i === 0);
  });

  document.getElementById(panel + '-run-btn').disabled = true;
  document.body.classList.add('scanning');

  const progWrap = document.getElementById(panel + '-progress-wrap');
  const progFill = document.getElementById(panel + '-prog-fill');
  const progText = document.getElementById(panel + '-prog-text');
  progWrap.style.display = 'block';
  progFill.style.width   = '0%';

  renderResults(panel); // show empty slate immediately

  const total  = tokens.length;
  let   done   = 0;
  const queue  = [...tokens];

  const CONCURRENCY = 3;
  const workers = Array(Math.min(CONCURRENCY, total)).fill(null).map(async () => {
    while (queue.length > 0) {
      const parsed = queue.shift();
      const result = await checkToken(parsed, panel);

      state[panel].results.push(result);
      done++;

      const pct = Math.round(done / total * 100);
      progFill.style.width   = pct + '%';
      progText.textContent   = done + ' / ' + total;

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

/** Full re-render (used after filter change or clear) */
function renderResults(panel) {
  const scroll  = document.getElementById(panel + '-results-scroll');
  const filter  = state[panel].filter;
  const results = state[panel].results;

  const filtered = results.filter(r =>
    filter === 'all'     ? true :
    filter === 'valid'   ? r.valid :
    /* invalid */         !r.valid
  );

  if (filtered.length === 0) {
    scroll.innerHTML = getEmptyHTML(panel);
  } else {
    scroll.innerHTML = filtered.map(r => buildRowHTML(r, panel)).join('');
  }

  updateTabCounts(panel);
}

/** Incremental append during live checking */
function appendResultRow(panel, result) {
  const scroll = document.getElementById(panel + '-results-scroll');
  const filter = state[panel].filter;

  // Remove empty state if present
  const empty = scroll.querySelector('.empty-state');
  if (empty) empty.remove();

  // Only append if matches current filter
  const show =
    filter === 'all'   ? true :
    filter === 'valid' ? result.valid :
    /* invalid */       !result.valid;

  if (show) {
    scroll.insertAdjacentHTML('beforeend', buildRowHTML(result, panel));
  }
}

function getEmptyHTML(panel) {
  return `<div class="empty-state">
    <div class="empty-icon">🔍</div>
    <div>No results yet.<br>Paste tokens and run a check.</div>
  </div>`;
}

function buildRowHTML(r, panel) {
  const t = r.parsed.token;
  const tokenShort = t.length > 36
    ? t.slice(0, 16) + '…' + t.slice(-8)
    : t;

  const statusBadge = r.valid
    ? `<span class="status-badge valid">◆ VALID</span>`
    : `<span class="status-badge invalid">✕ INVALID</span>`;

  let infoHTML = '';

  if (r.valid) {
    if (panel === 'display') {
      infoHTML = `
        <div class="info-line"><span class="info-key">name&nbsp;</span><span class="info-val highlight">${esc(r.global_name || r.username || '—')}</span></div>
        <div class="info-line"><span class="info-key">id&nbsp;&nbsp;&nbsp;</span><span class="info-val">${esc(r.id || '—')}</span></div>
        ${r.nitro ? `<div class="info-line"><span class="nitro-badge">⚡ ${esc(r.nitro)}</span></div>` : ''}
      `;
    } else if (panel === 'username') {
      const uname = r.discriminator && r.discriminator !== '0'
        ? `${r.username}#${r.discriminator}`
        : (r.username || '—');
      infoHTML = `
        <div class="info-line"><span class="info-key">user&nbsp;</span><span class="info-val highlight">${esc(uname)}</span></div>
        <div class="info-line"><span class="info-key">id&nbsp;&nbsp;&nbsp;</span><span class="info-val">${esc(r.id || '—')}</span></div>
        ${r.nitro ? `<div class="info-line"><span class="nitro-badge">⚡ ${esc(r.nitro)}</span></div>` : ''}
      `;
    } else {
      // server — shows array of guilds
      const count = r.guild_count != null ? r.guild_count : (r.guilds ? r.guilds.length : '?');
      const first = r.guilds && r.guilds[0] ? r.guilds[0].name : '—';
      infoHTML = `
        <div class="info-line"><span class="info-key">servers&nbsp;</span><span class="info-val highlight">${count}</span></div>
        <div class="info-line"><span class="info-key">first&nbsp;&nbsp;&nbsp;</span><span class="info-val">${esc(first)}</span></div>
        ${r.nitro ? `<div class="info-line"><span class="nitro-badge">⚡ ${esc(r.nitro)}</span></div>` : ''}
      `;
    }
  } else {
    infoHTML = `<div class="info-line"><span class="info-key">reason&nbsp;</span><span class="info-val">${esc(r.error || '401 Unauthorized')}</span></div>`;
  }

  const userLine = r.parsed.user
    ? `<span class="token-user">${esc(r.parsed.user)}</span>`
    : '';

  // Escape raw for onclick attribute
  const rawEsc = r.parsed.raw.replace(/\\/g,'\\\\').replace(/'/g,"\\'");

  return `<div class="result-row">
    <div class="col-token">${userLine}${tokenShort}</div>
    <div class="col-status">${statusBadge}</div>
    <div class="col-info">${infoHTML}</div>
    <div class="col-copy"><button class="copy-btn" onclick="copyToken('${rawEsc}')">copy</button></div>
  </div>`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────
//  FILTER TABS
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
  document.getElementById(panel + '-tab-all').textContent     = results.length;
  document.getElementById(panel + '-tab-valid').textContent   = valid;
  document.getElementById(panel + '-tab-invalid').textContent = invalid;
}

// ─────────────────────────────────────────────
//  TOP BAR STATS
// ─────────────────────────────────────────────
function updateStats(panel) {
  const results = state[panel].results;
  const valid   = results.filter(r => r.valid).length;
  const invalid = results.filter(r => !r.valid).length;
  document.getElementById('statValid').textContent   = valid;
  document.getElementById('statInvalid').textContent = invalid;
  document.getElementById('statTotal').textContent   = results.length;
}

// ─────────────────────────────────────────────
//  COPY TOKEN
// ─────────────────────────────────────────────
function copyToken(raw) {
  navigator.clipboard.writeText(raw).catch(() => {
    // Fallback for older browsers
    const el = document.createElement('textarea');
    el.value = raw;
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
  });
}

// ─────────────────────────────────────────────
//  EXPORT
// ─────────────────────────────────────────────
function exportResults(panel, filter, format) {
  const results = filter === 'valid'
    ? state[panel].results.filter(r => r.valid)
    : state[panel].results;

  if (!results.length) { showToast('Nothing to export.'); return; }

  let content  = '';
  let filename = `discord_${panel}_${filter}`;

  if (format === 'token') {
    content  = results.map(r => r.parsed.token).join('\n');
    filename += '_tokens.txt';
  } else if (format === 'combo') {
    content  = results.map(r => r.parsed.raw).join('\n');
    filename += '_combos.txt';
  } else {
    // Remove circular / large fields before stringify
    const clean = results.map(r => ({
      token:  r.parsed.token,
      user:   r.parsed.user   || null,
      pass:   r.parsed.pass   || null,
      format: r.parsed.format,
      valid:  r.valid,
      ...(r.valid ? {
        id:           r.id,
        username:     r.username,
        global_name:  r.global_name,
        discriminator:r.discriminator,
        nitro:        r.nitro,
        ...(panel === 'server' ? { guild_count: r.guild_count, guilds: r.guilds } : {}),
      } : { error: r.error }),
    }));
    content  = JSON.stringify(clean, null, 2);
    filename += '.json';
  }

  const blob = new Blob([content], { type: 'text/plain' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ─────────────────────────────────────────────
//  TOAST NOTIFICATION
// ─────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  const t = document.createElement('div');
  t.className   = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), duration);
}
