// WebSSH - PuTTY tarzı web tabanlı SSH + SFTP istemcisi

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- State ----------
const state = {
  ws: null,
  mode: 'shell', // 'shell' | 'sftp'
  connected: false,
  term: null,
  fit: null,
  termInfo: '—',
  sftp: {
    cwd: '/',
    selected: null,
    pendingRequests: new Map(),
    nextId: 1,
  },
};

// ---------- DOM refs ----------
const connForm = $('#connForm');
const statusEl = $('#connStatus');
const statusTextEl = $('#statusText');
const wsStateEl = $('#wsState');
const termInfoEl = $('#termInfo');
const terminalHost = $('#terminal');
const sftpListEl = $('#sftpList');
const sftpPathEl = $('#sftpPath');
const sftpPreviewEl = $('#sftpPreview');
const sftpInfoEl = $('#sftpInfo');
const sessionsListEl = $('#sessionsList');
const sessionFilterEl = $('#sessionFilter');

// ---------- Utils ----------
function setStatus(stateName, text) {
  statusEl.classList.remove('connected', 'connecting', 'error');
  if (stateName === 'connected') statusEl.classList.add('connected');
  else if (stateName === 'connecting') statusEl.classList.add('connecting');
  else if (stateName === 'error') statusEl.classList.add('error');
  statusEl.querySelector('.text').textContent = text;
}

function setStatusBar(text) { statusTextEl.textContent = text; }
function fmtSize(bytes) {
  if (bytes == null) return '';
  const u = ['B','K','M','G','T']; let i = 0; let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('tr-TR');
}

// ---------- xterm init ----------
function initTerminal() {
  if (state.term) return;
  state.term = new window.Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 14,
    scrollback: 5000,
    convertEol: false,
    theme: { background: '#000000', foreground: '#e6edf3' },
  });
  state.fit = new window.FitAddon.FitAddon();
  state.term.loadAddon(state.fit);
  state.term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  state.term.open(terminalHost);
  setTimeout(() => state.fit && state.fit.fit(), 50);
  window.addEventListener('resize', () => {
    if (state.fit) {
      state.fit.fit();
      if (state.connected && state.mode === 'shell' && state.ws) {
        state.ws.send(JSON.stringify({
          type: 'resize',
          cols: state.term.cols,
          rows: state.term.rows,
        }));
      }
    }
  });

  state.term.onData((d) => {
    if (state.connected && state.mode === 'shell' && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'data', data: d }));
    }
  });

  state.term.writeln('\x1b[1;36mWebSSH\x1b[0m — PuTTY tarzı web tabanlı SSH terminali.');
  state.term.writeln('Sol panelden bir sunucu ayarlayıp \x1b[1;32mBağlan\x1b[0m düğmesine basın.');
}

// ---------- Tab switching ----------
$$('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === tab));
    if (tab === 'terminal') {
      initTerminal();
      setTimeout(() => state.fit && state.fit.fit(), 30);
    }
    if (tab === 'sessions') renderSessions();
  });
});

// ---------- Auth tabs ----------
$$('.auth-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    $$('.auth-tab').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const auth = btn.dataset.auth;
    $$('.auth-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== auth));
  });
});

// ---------- Key file load ----------
$('#keyFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  $('textarea[name="privateKey"]').value = text;
});

// ---------- Form handling ----------
function readForm() {
  const fd = new FormData(connForm);
  const out = Object.fromEntries(fd.entries());
  if (!out.port) out.port = 22;
  return out;
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws = ws;
    ws.binaryType = 'arraybuffer';
    let opened = false;
    ws.onopen = () => {
      opened = true;
      wsStateEl.textContent = 'WebSocket: açık';
      resolve(ws);
    };
    ws.onclose = () => {
      wsStateEl.textContent = 'WebSocket: kapalı';
      state.connected = false;
      setStatus('disconnected', 'Bağlı değil');
      setStatusBar('Bağlantı kapatıldı');
    };
    ws.onerror = () => {
      wsStateEl.textContent = 'WebSocket: hata';
      if (!opened) reject(new Error('WebSocket bağlantısı başarısız'));
    };
    ws.onmessage = (ev) => handleMessage(ev.data);
  });
}

async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.type) {
    case 'status':
      if (msg.status === 'connecting') { setStatus('connecting', 'Bağlanıyor...'); setStatusBar('Sunucuya bağlanılıyor'); }
      else if (msg.status === 'connected') {
        state.connected = true;
        setStatus('connected', 'Bağlı');
        setStatusBar('Bağlantı kuruldu');
        if (state.mode === 'shell') {
          $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'terminal'));
          $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'terminal'));
          initTerminal();
          setTimeout(() => {
            state.fit.fit();
            state.ws.send(JSON.stringify({
              type: 'resize',
              cols: state.term.cols,
              rows: state.term.rows,
            }));
          }, 80);
        }
      } else if (msg.status === 'closed' || msg.status === 'disconnected') {
        state.connected = false;
        setStatus('disconnected', 'Bağlı değil');
        if (state.term) state.term.writeln('\r\n\x1b[1;33m[bağlantı kapandı]\x1b[0m');
      }
      break;
    case 'data':
      if (state.term) state.term.write(msg.data);
      break;
    case 'error':
      setStatus('error', 'Hata');
      setStatusBar('Hata: ' + msg.message);
      if (state.term) state.term.writeln(`\r\n\x1b[1;31m[HATA] ${msg.message}\x1b[0m`);
      break;
    case 'sftp-ready':
      state.sftp.cwd = '/';
      sftpPathEl.value = '/';
      sftpList(0);
      break;
    case 'exec-response':
      // generic exec responses handled by direct callbacks; nothing global
      break;
    case 'wg-response':
      handleWgResponse(msg);
      break;
    case 'sftp-response':
      handleSftpResponse(msg);
      break;
    case 'sftp-error':
      setStatusBar('SFTP hatası: ' + msg.message);
      break;
  }
}

connForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = readForm();
  if (!data.host || !data.username) return;

  if (!data.password && !data.privateKey) {
    const ok = confirm('Parola veya özel anahtar girilmedi. Yine de bağlanılsın mı? (Anahtar tabanlı kimlik doğrulama denenebilir.)');
    if (!ok) return;
  }

  $('#connectBtn').disabled = true;
  $('#disconnectBtn').disabled = false;
  setStatus('connecting', 'Bağlanıyor...');
  setStatusBar('WebSocket açılıyor');

  try {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) await connectWs();
    state.mode = 'shell';
    state.sftp.selected = null;
    state.ws.send(JSON.stringify({
      type: 'connect',
      mode: 'shell',
      host: data.host,
      port: Number(data.port),
      username: data.username,
      password: data.password || undefined,
      privateKey: data.privateKey || undefined,
      passphrase: data.passphrase || undefined,
      term: data.term || 'xterm-256color',
      cols: state.term ? state.term.cols : 80,
      rows: state.term ? state.term.rows : 24,
      algorithms: data.algorithms || undefined,
    }));
    state.termInfo = `${data.username}@${data.host}:${data.port}`;
    termInfoEl.textContent = state.termInfo;
  } catch (err) {
    setStatus('error', 'Hata');
    setStatusBar('Bağlantı başarısız: ' + err.message);
    $('#connectBtn').disabled = false;
    $('#disconnectBtn').disabled = true;
  }
});

$('#disconnectBtn').addEventListener('click', () => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'disconnect' }));
  }
  state.connected = false;
  setStatus('disconnected', 'Bağlı değil');
  setStatusBar('Bağlantı kapatıldı');
  $('#connectBtn').disabled = false;
  $('#disconnectBtn').disabled = true;
});

$('#clearTerm').addEventListener('click', () => state.term && state.term.clear());

// ---------- Sessions (saved) ----------
const STORAGE_KEY = 'webssh.sessions.v1';
function loadSessions() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}
function saveSessions(arr) { localStorage.setItem(STORAGE_KEY, JSON.stringify(arr)); }

$('#saveBtn').addEventListener('click', () => {
  const data = readForm();
  if (!data.host || !data.username) { alert('En az host ve kullanıcı adı gerekli.'); return; }
  const label = data.label?.trim() || `${data.username}@${data.host}`;
  const sessions = loadSessions();
  const idx = sessions.findIndex((s) => s.label === label);
  const entry = {
    label,
    host: data.host,
    port: Number(data.port) || 22,
    username: data.username,
    auth: data.privateKey ? 'key' : 'password',
    term: data.term || 'xterm-256color',
    savedAt: Date.now(),
  };
  if (idx >= 0) sessions[idx] = entry; else sessions.push(entry);
  saveSessions(sessions);
  setStatusBar(`Oturum kaydedildi: ${label}`);
  renderSessions();
});

function renderSessions() {
  const filter = sessionFilterEl.value.trim().toLowerCase();
  const sessions = loadSessions().filter((s) =>
    !filter || s.label.toLowerCase().includes(filter) || s.host.toLowerCase().includes(filter)
  );
  sessionsListEl.innerHTML = '';
  if (sessions.length === 0) {
    sessionsListEl.innerHTML = '<div class="muted" style="padding:20px;">Henüz kaydedilmiş oturum yok.</div>';
    return;
  }
  for (const s of sessions) {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.innerHTML = `
      <div class="meta">
        <div class="name"></div>
        <div class="sub"></div>
      </div>
      <div class="actions">
        <button class="btn primary" data-act="load">Yükle</button>
        <button class="btn" data-act="connect">Bağlan</button>
        <button class="btn danger" data-act="del">Sil</button>
      </div>
    `;
    card.querySelector('.name').textContent = s.label;
    card.querySelector('.sub').textContent = `${s.username}@${s.host}:${s.port} • ${s.auth === 'key' ? 'Anahtar' : 'Parola'} • ${fmtTime(s.savedAt)}`;
    card.querySelector('[data-act="load"]').addEventListener('click', () => {
      $('input[name="label"]').value = s.label;
      $('input[name="host"]').value = s.host;
      $('input[name="port"]').value = s.port;
      $('input[name="username"]').value = s.username;
      $('select[name="term"]').value = s.term || 'xterm-256color';
      if (s.auth === 'key') {
        $$('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.auth === 'key'));
        $$('.auth-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== 'key'));
      } else {
        $$('.auth-tab').forEach((b) => b.classList.toggle('active', b.dataset.auth === 'password'));
        $$('.auth-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== 'password'));
      }
      setStatusBar(`Oturum yüklendi: ${s.label}`);
    });
    card.querySelector('[data-act="connect"]').addEventListener('click', () => {
      $('input[name="label"]').value = s.label;
      $('input[name="host"]').value = s.host;
      $('input[name="port"]').value = s.port;
      $('input[name="username"]').value = s.username;
      $('select[name="term"]').value = s.term || 'xterm-256color';
      $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'terminal'));
      $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === 'terminal'));
      $('#connForm').dispatchEvent(new Event('submit', { cancelable: true }));
    });
    card.querySelector('[data-act="del"]').addEventListener('click', () => {
      if (!confirm(`"${s.label}" oturumu silinsin mi?`)) return;
      saveSessions(loadSessions().filter((x) => x.label !== s.label));
      renderSessions();
    });
    sessionsListEl.appendChild(card);
  }
}

sessionFilterEl.addEventListener('input', renderSessions);
$('#clearSessions').addEventListener('click', () => {
  if (!confirm('Tüm kayıtlı oturumlar silinsin mi?')) return;
  saveSessions([]);
  renderSessions();
});

// ---------- SFTP ----------
async function ensureSftpConnection() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) await connectWs();
  if (!state.connected) {
    const data = readForm();
    if (!data.host || !data.username) { alert('Önce bağlantı ayarlarını doldurun.'); throw new Error('eksik'); }
    state.mode = 'sftp';
    state.ws.send(JSON.stringify({
      type: 'connect',
      mode: 'sftp',
      host: data.host, port: Number(data.port) || 22, username: data.username,
      password: data.password || undefined, privateKey: data.privateKey || undefined,
      passphrase: data.passphrase || undefined,
    }));
    setStatus('connecting', 'SFTP bağlanıyor...');
    setStatusBar('SFTP bağlantısı kuruluyor');
  }
}

function sftpRequest(action, payload = {}) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) { setStatusBar('WebSocket kapalı'); return; }
  const id = state.sftp.nextId++;
  state.ws.send(JSON.stringify({ type: 'sftp', id, action, ...payload }));
}

function handleSftpResponse(msg) {
  const { id, ok, error } = msg;
  if (ok === false) { setStatusBar('SFTP hatası: ' + (error || 'bilinmiyor')); return; }
  switch (msg.action) {
    case 'list':
      renderSftpList(msg.items || []);
      break;
    case 'read':
      sftpPreviewEl.textContent = msg.data ? atob(msg.data) : '(boş)';
      break;
    case 'write':
      setStatusBar('Yazıldı: ' + (msg.path || ''));
      sftpList();
      break;
    case 'stat':
      sftpPreviewEl.textContent = JSON.stringify(msg.attrs, null, 2);
      break;
    case 'mkdir':
    case 'rmdir':
    case 'unlink':
    case 'rename':
      sftpList();
      break;
  }
}

function sftpList(offset = 0) {
  const path = sftpPathEl.value || '/';
  state.sftp.cwd = path;
  sftpInfoEl.textContent = `Yükleniyor: ${path}`;
  sftpRequest('list', { path });
}

function renderSftpList(items) {
  const rows = [];
  rows.push(`<div class="sftp-row sftp-header"><div class="icon"></div><div>Ad</div><div>Boyut</div><div>Değişiklik</div><div>İzin</div></div>`);
  if (state.sftp.cwd !== '/') {
    rows.push(`<div class="sftp-row dir" data-path=".."><div class="icon">↩</div><div class="name">..</div><div></div><div></div><div></div></div>`);
  }
  for (const it of items) {
    const icon = it.attrs.isDirectory ? '📁' : '📄';
    rows.push(`
      <div class="sftp-row ${it.attrs.isDirectory ? 'dir' : 'file'}" data-path="${escapeAttr(it.filename)}" data-is-dir="${it.attrs.isDirectory}">
        <div class="icon">${icon}</div>
        <div class="name">${escapeHtml(it.filename)}</div>
        <div>${it.attrs.isDirectory ? '' : fmtSize(it.attrs.size)}</div>
        <div>${fmtTime(it.attrs.mtime)}</div>
        <div>${(it.longname || '').split(' ').slice(0, 1)[0]}</div>
      </div>
    `);
  }
  sftpListEl.innerHTML = rows.join('');
  sftpInfoEl.textContent = `${state.sftp.cwd} — ${items.length} öğe`;

  $$('.sftp-row', sftpListEl).forEach((row) => {
    row.addEventListener('click', () => {
      $$('.sftp-row', sftpListEl).forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
      const isDir = row.dataset.isDir === 'true';
      const name = row.dataset.path;
      state.sftp.selected = { name, isDir, row };
      $('#sftpDownload').disabled = isDir;
      $('#sftpDelete').disabled = false;
      if (!isDir && name) {
        sftpRequest('read', { path: joinPath(state.sftp.cwd, name) });
      }
    });
    row.addEventListener('dblclick', () => {
      const isDir = row.dataset.isDir === 'true';
      const name = row.dataset.path;
      if (isDir) {
        const next = name === '..' ? parentPath(state.sftp.cwd) : joinPath(state.sftp.cwd, name);
        sftpPathEl.value = next;
        sftpList();
      } else {
        // open preview
        sftpRequest('read', { path: joinPath(state.sftp.cwd, name) });
      }
    });
  });
}

function joinPath(base, name) {
  if (name === '..') return parentPath(base);
  if (base.endsWith('/')) return base + name;
  return base + '/' + name;
}
function parentPath(p) {
  if (!p || p === '/') return '/';
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;'); }

// SFTP toolbar
$('#sftpRefresh').addEventListener('click', sftpList);
$('#sftpUp').addEventListener('click', () => { sftpPathEl.value = parentPath(sftpPathEl.value || '/'); sftpList(); });
sftpPathEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') sftpList(); });

$('#sftpMkdir').addEventListener('click', async () => {
  const name = prompt('Yeni klasör adı:');
  if (!name) return;
  await ensureSftpConnection();
  sftpRequest('mkdir', { path: joinPath(state.sftp.cwd, name) });
});

$('#sftpDelete').addEventListener('click', async () => {
  if (!state.sftp.selected) return;
  const { name, isDir } = state.sftp.selected;
  if (!confirm(`${name} silinsin mi?`)) return;
  await ensureSftpConnection();
  sftpRequest(isDir ? 'rmdir' : 'unlink', { path: joinPath(state.sftp.cwd, name) });
});

$('#sftpDownload').addEventListener('click', async () => {
  if (!state.sftp.selected || state.sftp.selected.isDir) return;
  await ensureSftpConnection();
  const path = joinPath(state.sftp.cwd, state.sftp.selected.name);
  // Read full file (chunked read can be added later); for now read up to 8 MB
  sftpRequest('read', { path, start: 0, end: (8 * 1024 * 1024) - 1 });
  setStatusBar(`İndiriliyor: ${path}`);
});

$('#sftpUpload').addEventListener('click', () => $('#sftpFileInput').click());
$('#sftpFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await ensureSftpConnection();
  const reader = new FileReader();
  reader.onload = () => {
    const data = reader.result.split(',')[1]; // base64
    sftpRequest('write', { path: joinPath(state.sftp.cwd, file.name), data });
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// When SFTP tab opens, ensure connection
$$('.tab').forEach((btn) => {
  if (btn.dataset.tab !== 'sftp') return;
  btn.addEventListener('click', async () => {
    try { await ensureSftpConnection(); } catch {}
  });
});

// ---------- WireGuard Dashboard ----------
const wgState = {
  iface: 'wg0',
  useSudo: true,
  peers: [],
  lastClientConf: '',
  pending: new Map(), // id -> resolver
  nextId: 1,
};

function wgRequest(action, payload = {}) {
  return new Promise((resolve) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, error: 'WebSocket bağlı değil' });
      return;
    }
    const id = wgState.nextId++;
    wgState.pending.set(id, resolve);
    state.ws.send(JSON.stringify({ type: 'wireguard', id, action, ...payload }));
    setTimeout(() => {
      if (wgState.pending.has(id)) {
        wgState.pending.delete(id);
        resolve({ ok: false, error: 'Zaman aşımı' });
      }
    }, 60000);
  });
}

function handleWgResponse(msg) {
  const resolver = wgState.pending.get(msg.id);
  if (resolver) {
    wgState.pending.delete(msg.id);
    resolver(msg);
  }
}

function wgRawAppend(text) {
  const out = $('#wgRawOut');
  if (!out) return;
  if (out.classList.contains('muted')) { out.classList.remove('muted'); out.textContent = ''; }
  out.textContent += text + '\n';
  out.scrollTop = out.scrollHeight;
}

async function ensureWgConnection() {
  // Shell bağlantısı WireGuard için yeterli (exec aynı kanal üzerinden)
  if (state.connected && state.ws && state.ws.readyState === WebSocket.OPEN) return;
  // Eğer SSH shell bağlantısı yoksa yeni bağlantı aç
  const data = readForm();
  if (!data.host || !data.username) { alert('Önce SSH bağlantı ayarlarını doldurun.'); throw new Error('eksik'); }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) await connectWs();
  state.mode = 'shell';
  state.ws.send(JSON.stringify({
    type: 'connect', mode: 'shell',
    host: data.host, port: Number(data.port) || 22, username: data.username,
    password: data.password || undefined, privateKey: data.privateKey || undefined,
    passphrase: data.passphrase || undefined,
    term: data.term || 'xterm-256color', cols: 80, rows: 24,
  }));
  // bağlantı hazır olana kadar bekle (status:connected)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Bağlantı zaman aşımı')), 15000);
    const handler = (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'status' && m.status === 'connected') { clearTimeout(t); state.ws.removeEventListener('message', handler); resolve(); }
        if (m.type === 'error') { clearTimeout(t); state.ws.removeEventListener('message', handler); reject(new Error(m.message)); }
      } catch {}
    };
    state.ws.addEventListener('message', handler);
  });
}

// Ortam algılama
$('#wgDetect').addEventListener('click', async () => {
  try {
    await ensureWgConnection();
    setStatusBar('Ortam algılanıyor...');
    const r = await wgRequest('detect', { useSudo: wgState.useSudo });
    $('#wgDetectOut').textContent = r.data || (r.error || 'Çıktı yok');
    wgRawAppend('--- detect ---\n' + (r.data || r.error || ''));
    setStatusBar(r.ok ? 'Algılama tamamlandı' : 'Hata');
  } catch (e) { setStatusBar('Hata: ' + e.message); }
});

// Tek tıkla kurulum
$('#wgInstallBtn').addEventListener('click', async () => {
  if (!confirm('Bu işlem uzak sunucuda wireguard-tools kuracak ve wg-quick yapılandırması oluşturacak. Devam edilsin mi?')) return;
  try {
    await ensureWgConnection();
    const r = await wgRequest('install', {
      useSudo: wgState.useSudo,
      interface: $('#wgIface').value || 'wg0',
      address: $('#wgAddress').value || '10.0.0.1/24',
      listenPort: Number($('#wgPort').value) || 51820,
      dns: $('#wgDns').value || '1.1.1.1, 8.8.8.8',
    });
    $('#wgInstallOut').textContent = (r.data || '') + (r.stderr || '');
    wgRawAppend('--- install ---\n' + (r.data || '') + (r.stderr || ''));
    setStatusBar(r.ok && r.code === 0 ? 'Kurulum tamamlandı' : 'Kurulum hata verdi');
    if (r.ok) {
      await loadWgStatus();
      await loadWgPeers();
    }
  } catch (e) { setStatusBar('Hata: ' + e.message); }
});

// Durum
async function loadWgStatus() {
  $('#wgInterface').value = $('#wgInterface').value || 'wg0';
  const r = await wgRequest('status', { interface: $('#wgInterface').value, useSudo: wgState.useSudo });
  wgRawAppend('--- status ---\n' + (r.data || r.error || ''));
  if (r.ok) {
    const m = (r.data || '').match(/public key:\s*(\S+)/);
    wgState.serverPub = m ? m[1] : null;
  }
  return r;
}
$('#wgStatus').addEventListener('click', async () => {
  try { await ensureWgConnection(); await loadWgStatus(); setStatusBar('Durum alındı'); }
  catch (e) { setStatusBar('Hata: ' + e.message); }
});

// Yapılandırmayı kaydet (wg-quick save)
$('#wgSaveCfg').addEventListener('click', async () => {
  try {
    await ensureWgConnection();
    const r = await wgRequest('save-config', { interface: $('#wgInterface').value, useSudo: wgState.useSudo });
    wgRawAppend('--- save-config ---\n' + (r.data || r.error || ''));
    setStatusBar(r.ok ? 'Yapılandırma kaydedildi' : 'Hata');
  } catch (e) { setStatusBar('Hata: ' + e.message); }
});

// Peer listesi
async function loadWgPeers() {
  const r = await wgRequest('list-clients', { interface: $('#wgInterface').value, useSudo: wgState.useSudo });
  wgRawAppend('--- list-clients ---\n' + (r.data || r.error || ''));
  if (!r.ok) return;

  const out = r.data || '';
  // İstemci adları (dosyalar)
  const files = out.split('===PEERS===')[0].trim().split('\n').filter(Boolean);
  // Aktif peer'lar (wg show peers)
  const peersSection = (out.split('===PEERS===')[1] || '').split('===HANDSHAKES===')[0].trim();
  const handshakesSection = (out.split('===HANDSHAKES===')[1] || '').split('===TRANSFER===')[0].trim();
  const transferSection = (out.split('===TRANSFER===')[1] || '').trim();

  const peers = peersSection.split('\n').filter(Boolean);
  const handshakes = {};
  handshakesSection.split('\n').filter(Boolean).forEach((line) => {
    const [pub, ts] = line.split(/\s+/);
    if (pub && ts) handshakes[pub] = Number(ts);
  });
  const transfers = {};
  transferSection.split('\n').filter(Boolean).forEach((line) => {
    const [pub, rx, tx] = line.split(/\s+/);
    if (pub) transfers[pub] = { rx: Number(rx), tx: Number(tx) };
  });

  wgState.peers = peers.map((pub) => {
    const name = (files.find((f) => f.startsWith(pub.slice(0, 8))) || ('peer-' + pub.slice(0, 6)));
    return {
      name: name.replace(/\.conf$/, ''),
      publicKey: pub,
      handshake: handshakes[pub] || 0,
      rx: transfers[pub]?.rx || 0,
      tx: transfers[pub]?.tx || 0,
    };
  });

  renderWgPeers();
}

function renderWgPeers() {
  const tbody = $('#wgPeerList');
  if (!wgState.peers.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Henüz peer yok.</td></tr>';
    return;
  }
  tbody.innerHTML = wgState.peers.map((p) => {
    const hs = p.handshake ? new Date(p.handshake * 1000).toLocaleString('tr-TR') : '—';
    const transfer = (p.rx + p.tx) ? `${fmtSize(p.rx)} / ${fmtSize(p.tx)}` : '—';
    return `
      <tr data-pub="${escapeHtml(p.publicKey)}" data-name="${escapeHtml(p.name)}">
        <td>${escapeHtml(p.name)}</td>
        <td class="pubkey">${escapeHtml(p.publicKey)}</td>
        <td>10.0.0.${wgState.peers.indexOf(p) + 2}/32</td>
        <td>${hs}</td>
        <td>${transfer}</td>
        <td><button class="btn danger small" data-act="remove">Sil</button></td>
      </tr>
    `;
  }).join('');
  $$('#wgPeerList button[data-act="remove"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tr = btn.closest('tr');
      const pub = tr.dataset.pub;
      const name = tr.dataset.name;
      if (!confirm(`"${name}" peer'ı silinsin mi?`)) return;
      const r = await wgRequest('remove-peer', {
        publicKey: pub, name, interface: $('#wgInterface').value, useSudo: wgState.useSudo,
      });
      wgRawAppend('--- remove-peer ---\n' + (r.data || r.error || ''));
      await loadWgPeers();
      await wgRequest('save-config', { interface: $('#wgInterface').value, useSudo: wgState.useSudo });
    });
  });
}

$('#wgRefreshPeers').addEventListener('click', async () => {
  try { await ensureWgConnection(); await loadWgPeers(); setStatusBar('Peer listesi alındı'); }
  catch (e) { setStatusBar('Hata: ' + e.message); }
});

// Peer ekleme
$('#wgAddPeer').addEventListener('click', async () => {
  try {
    await ensureWgConnection();
    const name = $('#wgPeerName').value.trim() || ('peer-' + Date.now());
    const allowedIP = $('#wgPeerIp').value.trim() || '10.0.0.2/32';
    const endpoint = $('#wgPeerEndpoint').value.trim();
    const serverEndpoint = endpoint || prompt('Sunucu endpoint adresi (örn. sunucu.example.com:51820):');
    if (!serverEndpoint) return;
    setStatusBar('Peer oluşturuluyor...');
    const r = await wgRequest('add-peer', {
      name, allowedIP, endpoint: serverEndpoint, interface: $('#wgInterface').value, useSudo: wgState.useSudo,
    });
    wgRawAppend('--- add-peer ---\n' + (r.data || '') + (r.stderr || ''));
    if (!r.ok || (r.data && r.data.includes('hata:'))) {
      $('#wgInstallOut').textContent = (r.data || '') + (r.stderr || '');
      return;
    }
    // Sunucudan gelen ===CLIENT_CONF=== ile biten bloğu çıkar
    const confMatch = (r.data || '').match(/===CLIENT_CONF===([\s\S]*?)===BITTI===/);
    if (confMatch) {
      const conf = confMatch[1].trim();
      wgState.lastClientConf = conf;
      $('#wgClientConf').textContent = conf;
      $('#wgDownload').disabled = false;
      $('#wgCopy').disabled = false;
      // QR kod
      const qrCanvas = $('#wgQrCanvas');
      qrCanvas.classList.remove('empty');
      qrCanvas.innerHTML = '';
      window.QRCode.toCanvas(conf, { width: 180, margin: 1 }, (err, canvas) => {
        if (err) { qrCanvas.textContent = 'QR üretilemedi'; return; }
        qrCanvas.appendChild(canvas);
      });
    }
    await loadWgPeers();
    setStatusBar('Peer eklendi');
  } catch (e) { setStatusBar('Hata: ' + e.message); }
});

$('#wgDownload').addEventListener('click', () => {
  if (!wgState.lastClientConf) return;
  const name = $('#wgPeerName').value.trim() || 'wireguard-client';
  const blob = new Blob([wgState.lastClientConf], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name + '.conf'; a.click();
  URL.revokeObjectURL(url);
});

$('#wgCopy').addEventListener('click', async () => {
  if (!wgState.lastClientConf) return;
  try {
    await navigator.clipboard.writeText(wgState.lastClientConf);
    setStatusBar('Konfigürasyon panoya kopyalandı');
  } catch { setStatusBar('Kopyalama başarısız'); }
});

// ---------- A'dan Z'ye Kurulum Sihirbazı ----------
// Backend'in tek exec'inde ürettiği çıktıyı adım adım parse eder.
// Her adım "===STEP:N:NAME===" ... "===END:N:NAME===" formatında.
function parseWizardOutput(raw) {
  const steps = [];
  // REGEX: STEP bloğu (END opsiyonel — bazıları erken kesilebilir)
  const stepRe = /===STEP:(\d+):([A-Z_]+)===\n([\s\S]*?)(?:===END:\1:\2===|===STEP:|$)/g;
  let m;
  while ((m = stepRe.exec(raw)) !== null) {
    steps.push({
      n: Number(m[1]),
      key: m[2],
      body: m[3].trimEnd(),
    });
  }
  return steps;
}

function setWizardStep(n, status, msg = '') {
  const li = $(`#wizSteps li[data-step="${n}"]`);
  if (!li) return;
  li.classList.remove('wiz-running', 'wiz-ok', 'wiz-fail', 'wiz-skip');
  if (status === 'running') li.classList.add('wiz-running');
  else if (status === 'ok') li.classList.add('wiz-ok');
  else if (status === 'fail') li.classList.add('wiz-fail');
  else if (status === 'skip') li.classList.add('wiz-skip');
  const dot = li.querySelector('.wg-step-dot');
  if (status === 'ok') dot.textContent = '✓';
  else if (status === 'fail') dot.textContent = '✗';
  else if (status === 'running') dot.textContent = '⋯';
  else if (status === 'skip') dot.textContent = '–';
  else dot.textContent = '•';
  const st = li.querySelector('.wg-step-status');
  st.textContent = msg || (status === 'ok' ? 'tamamlandı'
                          : status === 'fail' ? 'hata'
                          : status === 'running' ? 'çalışıyor...'
                          : status === 'skip' ? 'atlandı'
                          : 'beklemede');
}

function resetWizard() {
  for (let i = 1; i <= 7; i++) setWizardStep(i, 'pending', 'beklemede');
  $('#wizStatus').textContent = '—';
  $('#wizLog').textContent = '';
  $('#wizLogDetails').hidden = true;
  $('#wizResult').hidden = true;
  $('#wizLinks').innerHTML = '';
  $('#wizClientConf').value = '';
  $('#wizServerPub').value = '';
  $('#wizQrArea').innerHTML = '';
}

$('#wizResetBtn').addEventListener('click', resetWizard);

$('#wizRunBtn').addEventListener('click', async () => {
  try {
    await ensureWgConnection();
  } catch (e) {
    setStatusBar('Sihirbaz için önce SSH bağlantısı gerekli: ' + e.message);
    return;
  }

  const btn = $('#wizRunBtn');
  btn.disabled = true;
  resetWizard();
  $('#wizStatus').textContent = 'Başlatılıyor...';
  $('#wizLogDetails').hidden = false;

  const installWgd = $('#wizInstallWgd').checked;
  // Eğer WGDashboard kurulmayacaksa, adım 7'yi atlanmış olarak işaretle
  if (!installWgd) {
    setWizardStep(7, 'skip', 'WGDashboard devre dışı');
  }

  let resp;
  try {
    resp = await wgRequest('setup-wizard', {
      interface: $('#wizIface').value.trim() || 'wg0',
      address: $('#wizAddress').value.trim() || '10.0.0.1/24',
      listenPort: Number($('#wizPort').value) || 51820,
      dns: $('#wizDns').value.trim() || '1.1.1.1, 8.8.8.8',
      peerName: $('#wizPeerName').value.trim(),
      peerAllowedIP: $('#wizPeerIP').value.trim() || '10.0.0.2/32',
      peerEndpoint: $('#wizPeerEndpoint').value.trim(),
      installWgd,
      wgdPort: Number($('#wizWgdPort').value) || 10086,
      useSudo: $('#wizUseSudo').checked,
    });
  } catch (e) {
    btn.disabled = false;
    $('#wizStatus').textContent = 'Hata: ' + (e.message || 'bilinmiyor');
    setStatusBar('Sihirbaz hatası: ' + e.message);
    return;
  }

  const raw = (resp.data || '') + (resp.stderr || '');
  $('#wizLog').textContent = raw;

  // Adımları parse et ve UI'a yansıt
  const steps = parseWizardOutput(raw);
  const stepIndex = {};
  for (const s of steps) stepIndex[s.n] = s;

  const maxStep = installWgd ? 7 : 6;
  let anyFail = false;
  for (let n = 1; n <= maxStep; n++) {
    const s = stepIndex[n];
    if (!s) {
      setWizardStep(n, 'fail', 'adım çıktısı alınamadı');
      anyFail = true;
      continue;
    }
    // ===STEP bloklarında ilk satır "===STEP:N:KEY===" sonrası içerik
    // Kaba hata kontrolü: "HATA:" anahtar kelimesi ya da exit 1
    const lower = s.body.toLowerCase();
    const failed = lower.includes('hata:') || lower.includes('error:') ||
                   lower.includes('not found') || lower.includes('failed');
    if (failed && n !== 1) {
      setWizardStep(n, 'fail', 'hata oluştu — ham çıktıya bakın');
      anyFail = true;
      // sonraki adımları atla
      for (let k = n + 1; k <= maxStep; k++) setWizardStep(k, 'skip', 'önceki adım başarısız');
      break;
    } else {
      setWizardStep(n, 'ok', 'tamamlandı');
    }
  }

  // Sunucu public key'i ayıkla
  const pubMatch = raw.match(/SERVER_PUB=([A-Za-z0-9+/=]+)/);
  if (pubMatch) $('#wizServerPub').value = pubMatch[1];

  // Client config'i ayıkla (===CLIENT_CONF=== ... ===END:6:PEER=== bloğu)
  const confMatch = raw.match(/===CLIENT_CONF===\n([\s\S]*?)(?:===|$)/);
  if (confMatch) {
    const conf = confMatch[1].trim();
    $('#wizClientConf').value = conf;
    wgState.lastClientConf = conf;
    // QR kod
    if (typeof QRCode !== 'undefined') {
      $('#wizQrArea').innerHTML = '';
      new QRCode($('#wizQrArea'), {
        text: conf, width: 180, height: 180,
        colorDark: '#000', colorLight: '#fff',
      });
    }
  }

  // Erişim linkleri
  const host = $('input[name="host"]').value.trim();
  const links = [];
  if (host) {
    const proto = location.protocol === 'https:' ? 'https' : 'http';
    const sshPort = location.port || '3000';
    links.push(`<a href="${proto}://${host}${location.host.includes(':') ? '' : ':' + sshPort}" target="_blank">WebSSH</a>`);
    if (installWgd) {
      const wgdP = $('#wizWgdPort').value || 10086;
      links.push(`<a href="http://${host}:${wgdP}" target="_blank">WGDashboard (${host}:${wgdP})</a>`);
    }
  }
  if (installWgd) {
    links.push('WGDashboard varsayılan giriş: <code>admin</code> / <code>admin</code> (ilk açılışta değiştirilir)');
  }
  $('#wizLinks').innerHTML = links.map(l => `<li>${l}</li>`).join('');

  $('#wizResult').hidden = false;
  btn.disabled = false;
  $('#wizStatus').textContent = anyFail ? 'Bazı adımlar başarısız' : 'Tamamlandı';
  setStatusBar(anyFail ? 'Sihirbaz kısmen başarısız' : 'Sihirbaz tamamlandı');
});

// Sihirbaz sonuç indirme / kopyalama
$('#wizDownloadConf').addEventListener('click', () => {
  const conf = $('#wizClientConf').value;
  if (!conf) return;
  const name = $('#wizPeerName').value.trim() || 'client';
  const blob = new Blob([conf], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${name}.conf`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
});

$('#wizCopyConf').addEventListener('click', async () => {
  const conf = $('#wizClientConf').value;
  if (!conf) return;
  try {
    await navigator.clipboard.writeText(conf);
    setStatusBar('Konfigürasyon panoya kopyalandı');
  } catch { setStatusBar('Kopyalama başarısız'); }
});

// ---------- WGDashboard ----------
function updateWgdOpenLink() {
  // Bağlı sunucunun IP'sini tahmin et (formdan veya genel IP servisinden)
  const data = readForm();
  const host = (data.host || '').trim();
  const port = $('#wgdPort').value || 10086;
  // host zaten IP/domain olabilir
  let base = host || location.hostname;
  // Localhost ise 127.0.0.1 öner
  if (base === 'localhost' || base === '0.0.0.0') base = '127.0.0.1';
  $('#wgdOpenLink').href = `http://${base}:${port}`;
}

$('#wgdPort').addEventListener('input', updateWgdOpenLink);
$('input[name="host"]').addEventListener('input', updateWgdOpenLink);
updateWgdOpenLink();

async function runWgd(action, payload = {}) {
  await ensureWgConnection();
  setStatusBar('WGDashboard ' + action + ' çalışıyor...');
  const r = await wgRequest(action, Object.assign({ useSudo: wgState.useSudo }, payload));
  const out = (r.data || '') + (r.stderr || '');
  $('#wgdOut').textContent = out || (r.error || '—');
  wgRawAppend(`--- wgdashboard ${action} ---\n` + out + (r.error ? '\nERROR: ' + r.error : ''));
  setStatusBar(r.ok ? `WGDashboard ${action}: tamamlandı` : `WGDashboard ${action}: hata`);
  return r;
}

$('#wgdDetect').addEventListener('click', async () => {
  try { await runWgd('wgdashboard-detect'); }
  catch (e) { setStatusBar('Hata: ' + e.message); }
});

$('#wgdInstall').addEventListener('click', async () => {
  if (!confirm('Bu işlem uzak sunucuda Docker Compose ile WGDashboard kuracak ve /etc/wireguard klasörünü paylaşacak. Devam edilsin mi?')) return;
  try {
    await runWgd('wgdashboard-install', {
      wgdPort: Number($('#wgdPort').value) || 10086,
      wgPort: Number($('#wgdWgPort').value) || 51820,
      wgConfDir: $('#wgdConfDir').value || '/etc/wireguard',
      interface: $('#wgdIface').value || 'wg0',
    });
    setTimeout(() => updateWgdOpenLink(), 500);
  } catch (e) { setStatusBar('Hata: ' + e.message); }
});

$('#wgdStatus').addEventListener('click', async () => {
  try { await runWgd('wgdashboard-status'); }
  catch (e) { setStatusBar('Hata: ' + e.message); }
});

$('#wgdLogs').addEventListener('click', async () => {
  try { await runWgd('wgdashboard-logs', { tail: 80 }); }
  catch (e) { setStatusBar('Hata: ' + e.message); }
});

$('#wgdUninstall').addEventListener('click', async () => {
  if (!confirm('WGDashboard konteyneri ve yapılandırması kaldırılacak. /etc/wireguard korunur. Devam edilsin mi?')) return;
  try { await runWgd('wgdashboard-uninstall'); }
  catch (e) { setStatusBar('Hata: ' + e.message); }
});

// ---------- Init ----------
initTerminal();
renderSessions();
setStatusBar('Hazır');