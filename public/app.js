// WebSSH - PuTTY tarzı web tabanlı SSH + SFTP istemcisi

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------- State ----------
const state = {
  ws: null,
  mode: 'shell', // 'shell' | 'sftp'
  connected: false,
  hasError: false,    // Hata alındı mı? (bağlantı kapandı mesajını baskılamak için)
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
      // AI tool'ları için SSH session ID iste
      try { ws.send(JSON.stringify({ type: 'hello' })); } catch {}
      // hello-ack'i yakalayan ek listener (sonradan kurulur, burada referansını sakla)
      ws.addEventListener('message', _aiHelloListener);
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
        // Eğer bir hata mesajı zaten gösterildiyse, "bağlantı kapandı" yazma
        // (aksi halde kullanıcı gerçek hatayı göremez).
        if (state.term && !state.hasError) {
          state.term.writeln('\r\n\x1b[1;33m[bağlantı kapandı]\x1b[0m');
        }
        state.hasError = false;
      }
      break;
    case 'data':
      if (state.term) state.term.write(msg.data);
      break;
    case 'error':
      state.hasError = true;
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
  state.hasError = false;

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

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
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

// Sayfa ilk açılışta arka planda model listesini yükle (kullanıcı
// modal'ı açtığında hemen seçilebilir olsun).
if (typeof loadAiModels === 'function') loadAiModels();

// ============================================================================
// AI Asistan Chat — OpenRouter + SSH tool yönetimi
// ============================================================================
const ai = {
  open: false,
  apiKey: localStorage.getItem('openrouter-key') || '',
  model: localStorage.getItem('openrouter-model') || '',
  sessionId: null,        // AI oturumu (OpenRouter conversation)
  sshSessionId: null,     // Mevcut WebSocket/SSH bağlantısı
  messages: [],           // Görüntülenen sohbet
  pendingTool: null,      // Onay bekleyen tool çağrısı
  streaming: false,
};

// hello-ack'i yakalayan ek listener (zaten connectWs'te ws.onmessage handleMessage'i çağırıyor,
// buraya ek bir listener ekleyerek hello-ack'i de alıyoruz)
const _aiHelloListener = (ev) => {
  try {
    const data = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
    const msg = JSON.parse(data);
    if (msg.type === 'hello-ack' && msg.sshSessionId) {
      ai.sshSessionId = msg.sshSessionId;
      updateAiContextInfo();
    }
  } catch {}
};

// ---------- Chat UI ----------

function updateAiContextInfo() {
  const info = $('#aiChatContextInfo');
  if (!info) return;
  if (state.connected && ai.sshSessionId) {
    info.textContent = 'SSH bağlı — AI komut çalıştırabilir';
    info.style.color = '#2ea043';
  } else if (state.connected) {
    info.textContent = 'SSH bağlı — AI komut çalıştırabilir';
  } else {
    info.textContent = 'SSH bağlı değil — sadece sohbet';
    info.style.color = '';
  }
}

function aiToggle(force) {
  ai.open = force !== undefined ? force : !ai.open;
  $('#aiChatPanel').hidden = !ai.open;
  $('#aiChatBadge').hidden = true;
  if (ai.open) {
    if (!ai.apiKey) {
      $('#aiSettingsModal').hidden = false;
    }
    updateAiContextInfo();
    $('#aiChatInput').focus();
  }
}

$('#aiChatToggle').addEventListener('click', () => aiToggle());
$('#aiChatClose').addEventListener('click', () => aiToggle(false));
$('#aiChatClear').addEventListener('click', () => {
  ai.messages = [];
  ai.sessionId = null;
  ai.pendingTool = null;
  $('#aiChatMessages').innerHTML = `
    <div class="ai-msg ai-msg-system">
      Geçmiş temizlendi. Yeni sohbet başlatıldı.
    </div>`;
});

// ---------- Ayarlar Modalı ----------
$('#aiChatSettings').addEventListener('click', () => {
  $('#aiSettingsKey').value = ai.apiKey;
  $('#aiSettingsModal').hidden = false;
  loadAiModels(true);
});
$('#aiSettingsSave').addEventListener('click', () => {
  ai.apiKey = $('#aiSettingsKey').value.trim();
  ai.model = $('#aiSettingsModel').value;
  localStorage.setItem('openrouter-key', ai.apiKey);
  localStorage.setItem('openrouter-model', ai.model);
  $('#aiSettingsModal').hidden = true;
  updateAiModelDisplay();
  if (!ai.apiKey) {
    addAiMessage('system', 'API anahtarı kaydedilmedi. Ayarlardan girebilirsiniz.');
  } else {
    addAiMessage('system', `Ayarlar kaydedildi. Model: <code>${ai.model || '(varsayılan)'}</code>`);
  }
});
$$('[data-close-modal]').forEach(el => el.addEventListener('click', () => {
  $('#aiSettingsModal').hidden = true;
}));

// Model listesi yenile butonu — modal her açıldığında ve isteğe bağlı buradan.
$('#aiSettingsModelRefresh').addEventListener('click', () => loadAiModels(true));

async function loadAiModels(spinning = false) {
  const sel = $('#aiSettingsModel');
  const refreshBtn = $('#aiSettingsModelRefresh');
  sel.innerHTML = '<option value="">— yükleniyor —</option>';
  if (spinning && refreshBtn) {
    refreshBtn.classList.add('spinning');
    refreshBtn.disabled = true;
  }
  try {
    // Model listesini DOĞRUDAN OpenRouter'dan çekiyoruz (CORS açık).
    // Server'a /api/models isteği atmıyoruz — bu sayede reverse proxy
    // sorunlarından (Dokploy/Traefik 404) bağımsız çalışır.
    const r = await fetch('https://openrouter.ai/api/v1/models', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const free = [];
    const paid = [];
    for (const m of data.data || []) {
      const id = m.id;
      if (!id) continue;
      // Fiyatı $/M token olarak parse et (label'da gösterilecek)
      let price = '';
      try {
        const p = parseFloat(m.pricing?.prompt || '0');
        if (p > 0) price = ` · $${(p * 1_000_000).toFixed(p < 0.01 ? 3 : 2)}/M`;
      } catch { /* yoksay */ }
      const item = { id, name: m.name || id, price };
      if (id.includes(':free')) free.push(item);
      else paid.push(item);
    }

    // Ücretli modelleri sağlayıcıya göre grupla ve bilinen "en iyi" modelleri üste al.
    // OpenRouter'daki fiyat sıralaması + isim popülerliği baz alındı.
    const order = ['anthropic', 'openai', 'google', 'x-ai', 'deepseek', 'meta-llama', 'qwen', 'mistralai', 'cohere'];
    const byProvider = new Map();
    for (const m of paid) {
      const prov = m.id.split('/')[0];
      if (!byProvider.has(prov)) byProvider.set(prov, []);
      byProvider.get(prov).push(m);
    }
    // Her sağlayıcı içinde alfabetik sırala
    for (const arr of byProvider.values()) arr.sort((a, b) => a.name.localeCompare(b.name));

    // Bilinen "en iyi / önerilen" modeller — en üstte, kendi optgroup'unda
    const featured = [
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-sonnet-5',
      'openai/gpt-4.1',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
      'google/gemini-2.5-pro',
      'google/gemini-2.5-flash',
      'x-ai/grok-4.5',
      'deepseek/deepseek-chat-v3.1',
      'deepseek/deepseek-r1',
      'meta-llama/llama-4-maverick',
      'qwen/qwen3-coder-plus',
      'mistralai/mistral-large-2512',
    ];
    const featuredSet = new Set(featured);
    const featuredPaid = paid.filter(m => featuredSet.has(m.id));
    const featuredMap = new Map(featuredPaid.map(m => [m.id, m]));
    const featuredOrdered = featured.map(id => featuredMap.get(id)).filter(Boolean);

    const opt = (m) => {
      const sel2 = ai.model === m.id ? ' selected' : '';
      const safe = m.name.replace(/[<>&]/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;' }[c]));
      return `<option value="${m.id}"${sel2}>${safe}${m.price}</option>`;
    };

    const opts = [];

    // Öne çıkanlar
    if (featuredOrdered.length) {
      opts.push('<optgroup label="★ Öne Çıkanlar (önerilen)">');
      for (const m of featuredOrdered) opts.push(opt(m));
      opts.push('</optgroup>');
    }

    // Ücretsiz
    if (free.length) {
      opts.push('<optgroup label="Ücretsiz">');
      for (const m of free) opts.push(opt(m));
      opts.push('</optgroup>');
    }

    // Ücretli — sağlayıcı bazında
    opts.push('<optgroup label="Ücretli (kendi bakiyenizden)">');
    for (const prov of order) {
      const arr = byProvider.get(prov);
      if (!arr || !arr.length) continue;
      // Sağlayıcı başlığı koymadan tüm modelleri "Ücretli" altına bas (400 model tek tek yapılmaz)
      // Sağlayıcı öneki option value'da var, kullanıcı arayabilir.
    }
    // Tüm ücretli modelleri sıralı şekilde bas (öne çıkanlar çıkarılmış)
    const remainingPaid = paid.filter(m => !featuredSet.has(m.id));
    remainingPaid.sort((a, b) => a.id.localeCompare(b.id));
    for (const m of remainingPaid) opts.push(opt(m));
    opts.push('</optgroup>');

    sel.innerHTML = opts.join('');
  } catch (e) {
    sel.innerHTML = `<option value="">Model listesi yüklenemedi: ${e.message}</option>`;
  } finally {
    if (refreshBtn) {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }
  }
}

function updateAiModelDisplay() {
  $('#aiChatModel').textContent = ai.model || '(varsayılan ücretsiz model)';
}

// ---------- Mesaj gönderme ----------

function addAiMessage(role, htmlContent, opts = {}) {
  const el = document.createElement('div');
  el.className = `ai-msg ai-msg-${role}`;
  if (opts.raw) el.dataset.raw = opts.raw;
  el.innerHTML = htmlContent;
  const wrap = $('#aiChatMessages');
  wrap.appendChild(el);
  wrap.scrollTop = wrap.scrollHeight;
  return el;
}

// Basit markdown → HTML (kod blokları + inline code + satır sonu)
function mdToHtml(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\n/g, '<br>');
  return html;
}

async function aiSendMessage(text) {
  if (ai.streaming) return;
  if (!ai.apiKey) {
    $('#aiSettingsModal').hidden = false;
    return;
  }
  if (!text.trim()) return;

  // Terminal bağlamı eklensin mi?
  const includeCtx = $('#aiChatIncludeTerminal')?.checked && state.connected && state.term;
  let userContent = text;
  if (includeCtx) {
    // Terminal buffer'ın son 30 satırını al
    const buf = state.term.buffer.active;
    const lines = [];
    for (let i = Math.max(0, buf.length - 30); i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    const ctx = lines.join('\n').trim();
    if (ctx) {
      userContent = `${text}\n\n[Bağlı sunucuda son terminal çıktısı:]\n\`\`\`\n${ctx.slice(-2000)}\n\`\`\``;
    }
  }

  ai.messages.push({ role: 'user', content: text });
  addAiMessage('user', escapeHtml(text));

  // Streaming placeholder
  const typingEl = document.createElement('div');
  typingEl.className = 'ai-chat-typing';
  typingEl.textContent = 'AI düşünüyor...';
  $('#aiChatMessages').appendChild(typingEl);

  ai.streaming = true;
  $('#aiChatSend').disabled = true;

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: ai.messages.map(m => ({ role: m.role, content: m.content })),
        model: ai.model,
        apiKey: ai.apiKey,
        sessionId: ai.sessionId,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
      throw new Error(err.error || 'HTTP ' + r.status);
    }

    // SSE oku
    typingEl.remove();
    const reader = r.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let assistantContent = '';
    let assistantEl = null;
    const pendingToolCalls = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }

        if (evt.error) {
          addAiMessage('error', escapeHtml(evt.error));
          continue;
        }

        if (evt.delta) {
          assistantContent += evt.delta;
          if (!assistantEl) {
            assistantEl = document.createElement('div');
            assistantEl.className = 'ai-msg ai-msg-assistant';
            $('#aiChatMessages').appendChild(assistantEl);
          }
          assistantEl.innerHTML = mdToHtml(assistantContent);
          $('#aiChatMessages').scrollTop = $('#aiChatMessages').scrollHeight;
        }

        if (evt.type === 'tool_call') {
          pendingToolCalls.push(evt);
        }
      }
    }

    // Asistan cevabını messages'a ekle
    if (assistantContent) {
      ai.messages.push({ role: 'assistant', content: assistantContent });
    }

    // Tool çağrılarını göster — her biri için onay kartı
    for (const tc of pendingToolCalls) {
      renderToolCard(tc);
    }
  } catch (e) {
    typingEl.remove();
    addAiMessage('error', 'Hata: ' + escapeHtml(e.message));
  } finally {
    ai.streaming = false;
    $('#aiChatSend').disabled = false;
    $('#aiChatInput').focus();
  }
}

// ---------- Tool onay kartı ----------

function renderToolCard(tc) {
  const tool = tc.tool;
  const args = tc.args || {};
  const reason = args.reason || '(açıklama yok)';

  let cmdDisplay = '';
  if (tool === 'run_command') cmdDisplay = args.command;
  else if (tool === 'read_file') cmdDisplay = `cat ${args.path}`;
  else if (tool === 'list_directory') cmdDisplay = `ls -la ${args.path || '/etc/wireguard'}`;
  else if (tool === 'wg_status') cmdDisplay = 'wg show';
  else if (tool === 'wg_add_peer') cmdDisplay = `wg peer add (name=${args.name}, allowed_ip=${args.allowed_ip})`;
  else if (tool === 'wg_remove_peer') cmdDisplay = `wg peer remove (${args.name || args.public_key})`;
  else if (tool === 'service_status') cmdDisplay = `systemctl status ${args.service}`;
  else cmdDisplay = JSON.stringify(args);

  const card = document.createElement('div');
  card.className = 'ai-tool-card';
  card.dataset.toolCallId = tc.toolCallId;
  card.innerHTML = `
    <div class="ai-tool-title">🔧 ${escapeHtml(tool)}</div>
    <div class="muted small">${escapeHtml(reason)}</div>
    <div class="ai-tool-cmd">${escapeHtml(cmdDisplay)}</div>
    <div class="ai-tool-actions">
      <button class="ai-tool-approve">✓ Onayla ve Çalıştır</button>
      <button class="ai-tool-reject">✕ Reddet</button>
    </div>
  `;

  // Eğer SSH bağlı değilse uyar
  if (!state.connected || !ai.sshSessionId) {
    card.querySelector('.ai-tool-actions').innerHTML =
      '<em class="muted small">SSH bağlı değil — bu tool çalıştırılamaz. Önce SSH bağlantısı kurun.</em>';
    $('#aiChatMessages').appendChild(card);
    $('#aiChatMessages').scrollTop = $('#aiChatMessages').scrollHeight;
    return;
  }

  card.querySelector('.ai-tool-approve').addEventListener('click', () => approveTool(card, tc));
  card.querySelector('.ai-tool-reject').addEventListener('click', () => rejectTool(card, tc));
  $('#aiChatMessages').appendChild(card);
  $('#aiChatMessages').scrollTop = $('#aiChatMessages').scrollHeight;

  // Onaylanmamış tool'u AI'ın sonraki turunda context'e eklemek için sakla
  ai.pendingTool = tc;
}

async function approveTool(card, tc) {
  card.querySelectorAll('button').forEach(b => b.disabled = true);
  card.innerHTML += '<div class="muted small">⏳ Çalıştırılıyor...</div>';

  try {
    const r = await fetch('/api/tool/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: ai.sessionId,
        toolCallId: tc.toolCallId,
        tool: tc.tool,
        args: tc.args,
        approved: true,
        sshSessionId: ai.sshSessionId,
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);

    const result = data.result || {};
    const okClass = result.ok ? 'ai-msg-tool' : 'ai-msg-error';
    const out = (result.stdout || '').trim() || (result.stderr || '').trim() || '(çıktı yok)';
    const outPreview = out.length > 600 ? out.slice(0, 600) + '\n… (kırpıldı)' : out;
    card.outerHTML = `
      <div class="ai-msg ${okClass}">
        <strong>${escapeHtml(tc.tool)}</strong> — ${result.ok ? 'başarılı' : 'başarısız'} (exit ${result.code ?? '?'})
        <pre style="margin:6px 0 0; font-size:11px; background:var(--bg); padding:6px; border-radius:4px; max-height:200px; overflow:auto;">${escapeHtml(outPreview)}</pre>
      </div>`;

    // AI'a otomatik devam ettir — sonucu görsün ve yorumlasın
    setTimeout(() => aiContinueAfterTool(tc), 400);
  } catch (e) {
    card.innerHTML = `<div class="ai-msg-error">Çalıştırma hatası: ${escapeHtml(e.message)}</div>`;
  }
}

async function rejectTool(card, tc) {
  card.querySelectorAll('button').forEach(b => b.disabled = true);
  card.outerHTML = `<div class="ai-msg ai-msg-tool"><strong>${escapeHtml(tc.tool)}</strong> — kullanıcı reddetti</div>`;

  try {
    await fetch('/api/tool/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: ai.sessionId,
        toolCallId: tc.toolCallId,
        tool: tc.tool,
        approved: false,
        sshSessionId: ai.sshSessionId,
      }),
    });
  } catch {}
  setTimeout(() => aiContinueAfterTool(tc), 200);
}

async function aiContinueAfterTool(tc) {
  // Onay/red sonrası AI'ı otomatik devam ettir — boş bir user mesajıyla
  // (AI tool sonucunu zaten context'te görüyor)
  ai.streaming = true;
  $('#aiChatSend').disabled = true;

  const typingEl = document.createElement('div');
  typingEl.className = 'ai-chat-typing';
  typingEl.textContent = 'AI yanıtlıyor...';
  $('#aiChatMessages').appendChild(typingEl);

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: ai.messages,  // sessionId ile backend context'i zaten biliyor
        model: ai.model,
        apiKey: ai.apiKey,
        sessionId: ai.sessionId,
      }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || 'HTTP ' + r.status);
    }

    typingEl.remove();
    const reader = r.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let assistantContent = '';
    let assistantEl = null;
    const pendingToolCalls = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        let evt; try { evt = JSON.parse(payload); } catch { continue; }
        if (evt.delta) {
          assistantContent += evt.delta;
          if (!assistantEl) {
            assistantEl = document.createElement('div');
            assistantEl.className = 'ai-msg ai-msg-assistant';
            $('#aiChatMessages').appendChild(assistantEl);
          }
          assistantEl.innerHTML = mdToHtml(assistantContent);
          $('#aiChatMessages').scrollTop = $('#aiChatMessages').scrollHeight;
        }
        if (evt.type === 'tool_call') pendingToolCalls.push(evt);
      }
    }
    if (assistantContent) ai.messages.push({ role: 'assistant', content: assistantContent });
    for (const tc of pendingToolCalls) renderToolCard(tc);
  } catch (e) {
    typingEl.remove();
    addAiMessage('error', 'Hata: ' + escapeHtml(e.message));
  } finally {
    ai.streaming = false;
    $('#aiChatSend').disabled = false;
  }
}

// ---------- Input handler ----------

$('#aiChatSend').addEventListener('click', () => {
  const input = $('#aiChatInput');
  const text = input.value.trim();
  if (text) {
    input.value = '';
    aiSendMessage(text);
  }
});

$('#aiChatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#aiChatSend').click();
  }
});

// SSH bağlantı durumu değişince chat context bilgisini güncelle
const _origSetStatus = setStatus;
setStatus = function(s, msg) {
  _origSetStatus(s, msg);
  updateAiContextInfo();
};

// Sayfa yüklenince modeli göster
updateAiModelDisplay();
updateAiContextInfo();
