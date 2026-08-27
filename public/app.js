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
    case 'sudo-ready':
      if (msg.ok) {
        setStatusBar('Sudo NOPASSWD aktif — sihirbaz komutları parola sormadan çalışacak.');
        hideFixSudoCard();
      } else {
        const hint = msg.hint || 'Sudo NOPASSWD ayarlanamadı. Root parolanı girip "Tek Tıkla Düzelt"e bas.';
        setStatusBar(hint);
        showFixSudoCard(hint);
      }
      break;
    case 'sftp-ready':
      state.sftp.cwd = '/';
      sftpPathEl.value = '/';
      sftpList(0);
      break;
    case 'exec-response':
      // Generic exec response — wgState.pending'de bekleyen resolver varsa çöz
      // (runPeerAddDirect ve diğer fallback'ler için)
      {
        const resolver = wgState.pending.get(msg.id);
        if (resolver) {
          wgState.pending.delete(msg.id);
          // exec-response formatını wg-response'a normalize et
          resolver({
            ok: msg.ok !== false,
            data: msg.stdout || '',
            stderr: msg.stderr || '',
            code: msg.code,
          });
        }
      }
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
    // Docker kurulumu gibi uzun işlemler için wgdashboard-install ve setup-wizard 5dk
    // f2ban-install: 2 dakika (apt-get update yavaş olabilir)
    // Diğer action'lar 60s
    const timeout = (action === 'wgdashboard-install' || action === 'setup-wizard') ? 300000 :
                    (action === 'f2ban-install') ? 120000 : 60000;
    setTimeout(() => {
      if (wgState.pending.has(id)) {
        wgState.pending.delete(id);
        resolve({ ok: false, error: 'Zaman aşımı (' + Math.round(timeout/1000) + 's)' });
      }
    }, timeout);
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

// ---------- WireGuard Tık-Tıkla Kurulum Sihirbazı ----------
// Terminal toolbar'ındaki "WireGuard Sihirbazı" butonuna tıklandığında modal açılır.
// Her adım (algılama, kurulum, peer, dashboard) tek tek çalıştırılır ve bir sonraki aktifleşir.

let twCurrent = 0; // kaç adım tamamlandı

$('#wgWizardOpen').addEventListener('click', async () => {
  await openWizModal();
});
const inlineBtn = $('#wgWizardOpenInline');
if (inlineBtn) inlineBtn.addEventListener('click', async () => { await openWizModal(); });

async function openWizModal() {
  // SSH bağlantısı kontrolü
  try {
    await ensureWgConnection();
  } catch (e) {
    setStatusBar('Sihirbaz için önce SSH bağlantısı gerekli: ' + e.message);
    return;
  }
  $('#wgWizardModal').hidden = false;
  // İlk adımı default enable, diğerleri disable
  twCurrent = 0;
  document.querySelectorAll('#twSteps li').forEach((li, i) => {
    li.classList.remove('wiz-running', 'wiz-ok', 'wiz-fail', 'wiz-skip');
    li.querySelector('.wiz-status').textContent = 'beklemede';
    li.querySelector('.wiz-out').textContent = '';
    const btn = li.querySelector('.wiz-run');
    btn.disabled = (i > 0);
  });
  $('#twResult').hidden = true;
  // Step 0'ı otomatik çalıştır (sudo test). Sudo hazırsa otomatik Step 1'i aktifle.
  setTimeout(() => {
    const step0 = document.querySelector('#twSteps li[data-step="0"]');
    if (step0) {
      const step0Btn = step0.querySelector('.wiz-run');
      if (step0Btn) step0Btn.click();
    }
  }, 400);
  // Buton eventleri — her seferinde yeniden kur
  document.querySelectorAll('#twSteps .wiz-run').forEach(btn => {
    btn.onclick = () => runWizStep(btn.closest('li'), btn.dataset.stepAction);
  });
  // Mevcut config butonu (step 3 için fallback)
  document.querySelectorAll('#twSteps .wiz-existing').forEach(btn => {
    btn.onclick = () => runWizStep(btn.closest('li'), btn.dataset.stepAction);
  });
  // Atla butonları (step 3 vb opsiyonel adımlar)
  document.querySelectorAll('#twSteps .wiz-skip').forEach(btn => {
    btn.onclick = () => runWizSkip(btn.closest('li'));
  });
}

// === Atla action'ı (opsiyonel adımlar için) ===
// Bu action sadece UI state'i değiştirir — server tarafına komut göndermez.
// Adım "wiz-skip" olarak işaretlenir ve sonraki adım aktifleşir.
function runWizSkip(li) {
  const btn = li.querySelector('.wiz-run');
  const out = li.querySelector('.wiz-out');
  const status = li.querySelector('.wiz-status');
  const stepNum = Number(li.dataset.step);

  // li'daki tüm butonları disable
  li.querySelectorAll('button').forEach(b => b.disabled = true);
  li.classList.remove('wiz-running', 'wiz-fail', 'wiz-ok');
  li.classList.add('wiz-skip');
  status.textContent = 'atlandı (opsiyonel)';
  out.textContent = '⏭ Bu adım atlandı. Peer\'ları WGDashboard\'tan veya manuel ekleyebilirsin. Bir sonraki adıma geçildi.';

  // twCurrent güncelle ki sonraki adım doğru takip edilsin
  if (stepNum >= twCurrent) twCurrent = stepNum + 1;

  // Sonraki adımın butonlarını aktif et
  const next = document.querySelector(`#twSteps li[data-step="${stepNum + 1}"]`);
  if (next) {
    next.querySelectorAll('.wiz-run, .wiz-existing, .wiz-skip').forEach(b => { if (b) b.disabled = false; });
  } else {
    // Son adım atlandıysa, sonuç panelini göster
    if (typeof showWizResult === 'function') {
      showWizResult('skip', '⏭ Son adım atlandı.', { ok: true });
    }
  }
  setStatusBar(`Sihirbaz adım ${stepNum} atlandı — sonraki adıma geçildi`);
  $('#twReset').onclick = () => $('#wgWizardOpen').click();
}

document.querySelectorAll('[data-close-wgwiz]').forEach(el => {
  el.addEventListener('click', () => { $('#wgWizardModal').hidden = true; });
});

// === Acil: sudo tek tıkla düzeltme — akıllı akış ===
const fixBtn = $('#fixSudoBtn');
const fixCard = $('#twFixSudoCard');
const fixStatus = $('#fixSudoStatus');
const fixOut = $('#fixSudoOut');
const fixDetails = $('#fixSudoDetails');

// sudo-ready false geldiğinde kart otomatik açılır
function showFixSudoCard(reason) {
  if (!fixCard) return;
  fixCard.hidden = false;
  if (reason && fixStatus) {
    fixStatus.textContent = reason;
    fixStatus.style.color = '#ff9b9b';
  }
  fixStatus?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function hideFixSudoCard() {
  if (!fixCard) return;
  fixCard.hidden = true;
  fixOut.hidden = true;
  fixOut.textContent = '';
  fixDetails.textContent = '';
  fixStatus.textContent = '';
}

if (fixBtn) {
  fixBtn.addEventListener('click', async () => {
    const rootUser = $('#rootUser').value || 'root';
    const rootPass = $('#rootPass').value;
    if (!rootPass) {
      fixStatus.textContent = '� Root parolası gerekli';
      fixStatus.style.color = '#ff9b9b';
      $('#rootPass').focus();
      return;
    }

    // Onay dialog'u — root parolası girildikten sonra son onay
    const confirmed = confirm(
      'Bu işlem root yetkisiyle şunları yapacak:\n\n' +
      '• /usr/bin/sudo symlink\'ini düzeltir\n' +
      '• sudo-rs çakışmasını çözer\n' +
      '• admins için NOPASSWD kuralı ekler\n\n' +
      'Devam edilsin mi?'
    );
    if (!confirmed) return;

    // Loading state
    fixBtn.disabled = true;
    const icon = fixBtn.querySelector('.fix-btn-icon');
    const text = fixBtn.querySelector('.fix-btn-text');
    const originalIcon = icon?.textContent || '🔧';
    const originalText = text?.textContent || 'Tek Tıkla Düzelt';
    if (icon) icon.textContent = '⏳';
    if (text) text.textContent = 'Düzeltiliyor...';

    fixStatus.textContent = 'Root ile bağlanılıyor ve sudo düzeltiliyor...';
    fixStatus.style.color = '#ffd54f';

    try {
      // Yeni kapsamlı ubuntu26-fixes action'ını kullan (sudo + iptables + wg caps)
      const resp = await wgRequest('ubuntu26-fixes', { rootUser, rootPass });

      // Detayları göster
      fixDetails.textContent = (resp.data || '') + (resp.stderr ? '\n' + resp.stderr : '');
      fixOut.hidden = false;
      fixOut.textContent = resp.data || '(boş çıktı)';

      // Sonuç değerlendirme
      if (resp.fixed) {
        fixStatus.innerHTML = '✅ <strong>Sudo başarıyla düzeltildi!</strong> Wizard adımlarına geçebilirsin.';
        fixStatus.style.color = '#7fd47f';
        // Step 0'ı otomatik tamamlandı olarak işaretle, Step 1'i aktifle
        const step0 = document.querySelector('#twSteps li[data-step="0"]');
        if (step0) {
          step0.classList.remove('wiz-running', 'wiz-fail');
          step0.classList.add('wiz-ok');
          const s0 = step0.querySelector('.wiz-status');
          if (s0) s0.textContent = 'tamamlandı';
          const s0Out = step0.querySelector('.wiz-out');
          if (s0Out) s0Out.textContent = '✅ Sudo NOPASSWD başarıyla ayarlandı.\nArtık sonraki adımlar sudo kullanabilir.';
          const s0Btn = step0.querySelector('.wiz-run');
          if (s0Btn) s0Btn.disabled = true;
        }
        const step1 = document.querySelector('#twSteps li[data-step="1"]');
        if (step1) {
          const s1Btn = step1.querySelector('.wiz-run');
          if (s1Btn) s1Btn.disabled = false;
        }
        // 1.5 saniye sonra kullanıcıya Step 1'i (ortam algılama) çalıştırmayı öner
        setTimeout(() => {
          if (confirm('Sudo düzeltildi! Şimdi Step 1\'i (ortam algılama) çalıştırmak ister misin?')) {
            const li = document.querySelector('#twSteps li[data-step="1"]');
            if (li) {
              const runBtn = li.querySelector('.wiz-run');
              runBtn?.click();
            }
          } else {
            setTimeout(() => hideFixSudoCard(), 3000);
          }
        }, 1500);
      } else if (resp.ok) {
        fixStatus.innerHTML = '⚠️ <strong>Script çalıştı ama sudo hâlâ bozuk.</strong> Detaylara bakın veya sağlayıcı konsolu kullanın.';
        fixStatus.style.color = '#ff9b9b';
      } else {
        fixStatus.innerHTML = '❌ <strong>Root bağlantısı başarısız.</strong> Parolayı kontrol edin veya farklı bir kullanıcı deneyin.';
        fixStatus.style.color = '#ff9b9b';
      }
    } catch (e) {
      fixStatus.innerHTML = '❌ <strong>Hata:</strong> ' + (e.message || e);
      fixStatus.style.color = '#ff9b9b';
    } finally {
      fixBtn.disabled = false;
      if (icon) icon.textContent = originalIcon;
      if (text) text.textContent = originalText;
    }
  });
}

async function runWizStep(li, action) {
  const btn = li.querySelector('.wiz-run');
  const out = li.querySelector('.wiz-out');
  const status = li.querySelector('.wiz-status');
  const stepNum = Number(li.dataset.step);

  // Önceki tamamlanmamış adım varsa, "önceki başarısız" olarak işaretleme yapma
  // Sadece butonu disable edip çalıştır.
  btn.disabled = true;
  li.classList.add('wiz-running');
  li.classList.remove('wiz-ok', 'wiz-fail', 'wiz-skip');
  status.textContent = 'çalışıyor...';
  out.textContent = 'Çalışıyor, lütfen bekleyin...';

  // === Step 0: Sudo Hazırlığı (yeni serverlar için) ===
  if (action === 'sudo-prepare') {
    status.textContent = 'sudo kontrol ediliyor...';
    const sudoTest = await new Promise((resolve) => {
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, data: '' }); return;
      }
      const id = wgState.nextId++;
      wgState.pending.set(id, resolve);
      state.ws.send(JSON.stringify({ type: 'exec', id, command: 'sudo -n id 2>&1; echo "__SUDO_TEST_DONE__"' }));
      setTimeout(() => { if (wgState.pending.has(id)) { wgState.pending.delete(id); resolve({ ok: false, data: '' }); } }, 8000);
    });
    const sudoOut = ((sudoTest.data || '') + (sudoTest.stderr || '')).trim();
    const sudoOk = sudoOut.includes('uid=0');
    if (sudoOk) {
      out.textContent = `✅ Sudo NOPASSWD zaten hazır.\n\n${sudoOut}\n\nAdım 1'e geçebilirsin.`;
      li.classList.remove('wiz-running');
      li.classList.add('wiz-ok');
      status.textContent = 'sudo hazır';
      btn.disabled = true; // zaten tamamlandı
      twCurrent = stepNum;
      const next = document.querySelector(`#twSteps li[data-step="${stepNum + 1}"]`);
      if (next) {
        next.querySelectorAll('.wiz-run, .wiz-existing, .wiz-skip').forEach(b => { if (b) b.disabled = false; });
      }
      setStatusBar('Sudo NOPASSWD hazır — diğer adımlar sudo kullanabilir.');
      hideFixSudoCard();
      return;
    }
    // sudo yok — Tek Tıkla Düzelt kartını göster
    li.classList.remove('wiz-running');
    li.classList.add('wiz-fail');
    status.textContent = 'sudo gerekli';
    out.textContent = `❌ Sudo NOPASSWD ayarlı değil.\n\nsudo -n id çıktısı:\n${sudoOut || '(boş)'}\n\nSağdaki "Tek Tıkla Düzelt" kartıyla root parolanızı girerek sudo NOPASSWD ayarlayabilirsiniz.`;
    btn.disabled = false;
    showFixSudoCard('Yeni serverda sudo NOPASSWD ayarlı değil. Root parolanızla otomatik düzeltebilirsiniz.');
    setStatusBar('Sudo gerekli — sağdaki kartla düzeltin');
    return;
  }

  // Parametreleri modal config'ten al
  const params = {
    interface: $('#twIface').value.trim() || 'wg0',
    address: $('#twAddress').value.trim() || '10.0.0.1/24',
    listenPort: Number($('#twPort').value) || 51820,
    dns: $('#twDns').value.trim() || '1.1.1.1, 8.8.8.8',
    useSudo: $('#twUseSudo').checked,
  };

  let payload = params;
  let resp = null; // f2ban ve diğer action'larda wgRequest ile doldurulacak

  // === Mevcut config'i oku (existing-peer) — eski server.js ile uyumlu ===
  if (action === 'existing-peer') {
    const peerName = $('#twPeerName').value.trim() || 'phone-1';
    setStatusBar(`Mevcut peer config okunuyor: ${peerName}`);
    try {
      const readResp = await new Promise((resolve) => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, error: 'WebSocket bağlı değil' });
          return;
        }
        const id = wgState.nextId++;
        wgState.pending.set(id, resolve);
        state.ws.send(JSON.stringify({
          type: 'exec',
          id,
          command: `bash -lc 'if [ -f /etc/wireguard/clients/${peerName}.conf ]; then echo "===CLIENT_CONF==="; sudo -n cat /etc/wireguard/clients/${peerName}.conf 2>/dev/null || cat /etc/wireguard/clients/${peerName}.conf; echo "===BITTI==="; else echo "YOK"; fi'`,
        }));
        setTimeout(() => {
          if (wgState.pending.has(id)) {
            wgState.pending.delete(id);
            resolve({ ok: false, error: 'Timeout (10s)' });
          }
        }, 10000);
      });
      // exec-response -> wgResponse normalize
      const norm = {
        ok: readResp.ok !== false && (!readResp.code || readResp.code === 0),
        data: readResp.data || '',
        stderr: readResp.stderr || '',
      };
      const rawOut = (norm.data || '') + (norm.stderr || '');
      out.textContent = rawOut.trim() || '(çıktı yok)';
      const confMatch = rawOut.match(/===CLIENT_CONF===\s*([\s\S]*?)===BITTI===/);
      const conf = confMatch ? confMatch[1].trim() : '';
      if (conf) {
        li.classList.remove('wiz-running');
        li.classList.add('wiz-ok');
        status.textContent = 'mevcut config okundu';
        twCurrent = stepNum;
        $('#twClientConf').value = conf;
        $('#twResult').hidden = false;
        if (typeof QRCode !== 'undefined') {
          $('#twQrArea').innerHTML = '';
          new QRCode($('#twQrArea'), { text: conf, width: 180, height: 180, colorDark: '#000', colorLight: '#fff' });
        }
        const host = (readForm().host || '').trim() || location.hostname;
        $('#twLinks').innerHTML = `
          <li><b>VPN tüneli:</b> ${peerName} → ${host}:${$('#twPort').value || 51820}</li>
          <li><b>Peer VPN IP:</b> ${$('#twPeerIP').value || '10.0.0.2/32'}</li>
          <li><b>Sunucu VPN IP:</b> ${$('#twAddress').value || '10.0.0.1/24'}</li>
          <li><b>WGDashboard:</b> http://${host}:${$('#twWgdPort').value || 10086} (adım 4'ü çalıştırın)</li>
        `;
        const next = document.querySelector(`#twSteps li[data-step="${stepNum + 1}"]`);
        if (next) {
          const nextBtn = next.querySelector('.wiz-run');
          if (nextBtn) nextBtn.disabled = false;
          const existingBtn = next.querySelector('.wiz-existing');
          if (existingBtn) existingBtn.disabled = false;
        }
        setStatusBar(`Mevcut peer config okundu: ${peerName}`);
        return;
      } else {
        li.classList.remove('wiz-running');
        li.classList.add('wiz-fail');
        status.textContent = 'config yok';
        btn.disabled = false;
        setStatusBar(`/etc/wireguard/clients/${peerName}.conf bulunamadı`);
        return;
      }
    } catch (e) {
      li.classList.remove('wiz-running');
      li.classList.add('wiz-fail');
      status.textContent = 'hata';
      out.textContent = 'HATA: ' + e.message;
      btn.disabled = false;
      return;
    }
  }
  try {
    if (action === 'add-peer') {
      payload = {
        ...params,
        name: $('#twPeerName').value.trim() || 'phone-1',
        allowedIP: $('#twPeerIP').value.trim() || '10.0.0.2/32',
        endpoint: $('#twPeerEndpoint').value.trim(),
      };
      // Önce eski add-peer action'ını dene
      resp = await wgRequest(action, payload);
      // Başarısız olduysa ve server.js eski (allowed-ip hatası gibi görünüyor), exec fallback çalıştır
      if (!resp.ok || (resp.code && resp.code !== 0)) {
        const stderr = (resp.stderr || '') + (resp.data || '');
        if (stderr.includes('Invalid argument: allowed-ip') || stderr.includes('fopen: Permission denied') || stderr.includes('allowed-ip')) {
          status.textContent = 'eski server.js, fallback...';
          out.textContent = '⚠️ Eski server.js tespit edildi. Exec fallback ile peer ekleniyor...\n\n';
          const listenPort = Number($('#twPort').value) || 51820;
          const endpoint = payload.endpoint || `${readForm().host || location.hostname}:${listenPort}`;
          const dns = $('#twDns').value || '1.1.1.1, 8.8.8.8';
          const fbResp = await runPeerAddDirect(payload.name, payload.allowedIP, dns, endpoint, listenPort);
          if (fbResp.ok) {
            resp = fbResp;
            resp.code = 0;
            resp.ok = true;
          }
        }
      }
    } else if (action === 'wgdashboard-install') {
      // ÖNCE sudo testi yap. WGDashboard Docker kurulumu sudo gerektirir.
      // sudo -n id başarısızsa fix kartını göster ve adımı durdur.
      status.textContent = 'sudo kontrol ediliyor...';
      const sudoTest = await new Promise((resolve) => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, data: '' }); return;
        }
        const id = wgState.nextId++;
        wgState.pending.set(id, resolve);
        state.ws.send(JSON.stringify({ type: 'exec', id, command: 'sudo -n id 2>&1; echo "__SUDO_TEST_DONE__"' }));
        setTimeout(() => { if (wgState.pending.has(id)) { wgState.pending.delete(id); resolve({ ok: false, data: '' }); } }, 8000);
      });
      const sudoOk = ((sudoTest.data || '') + (sudoTest.stderr || '')).includes('uid=0');
      if (!sudoOk) {
        // Sudo yok — fix kartını göster, adımı durdur
        li.classList.remove('wiz-running');
        li.classList.add('wiz-fail');
        status.textContent = 'sudo gerekli';
        out.textContent = '⚠️ Bu adım için sudo yetkisi gerekli (Docker kurulumu). Sağdaki "Tek Tıkla Düzelt" kartıyla root parolanızla sudo NOPASSWD ayarlayın, sonra tekrar deneyin.\n\nsudo -n id çıktısı:\n' + ((sudoTest.data || '') + (sudoTest.stderr || '')).trim();
        btn.disabled = false;
        showFixSudoCard('WGDashboard kurulumu için sudo NOPASSWD gerekli. Root parolanızla otomatik ayarlayabilirsiniz.');
        setStatusBar('Sudo gerekli — sağdaki kartla düzeltin');
        return;
      }
      payload = {
        ...params,
        wgConfDir: '/etc/wireguard',
        wgdPort: Number($('#twWgdPort').value) || 10086,
        autoInstallDocker: $('#twAutoDocker')?.checked !== false,
      };
      // Önce eski wgdashboard-install action'ını dene
      resp = await wgRequest(action, payload);
      // Eski server.js ise (action tanımıyor veya boş döndürüyor), exec fallback kullan
      const respRaw = ((resp.data || '') + (resp.stderr || '') + (resp.error || '')).trim();
      const noOutput = !respRaw || (respRaw.length < 10 && !resp.ok);
      if (!resp.ok || noOutput) {
        // Fallback: exec ile Docker + WGDashboard kur
        status.textContent = 'eski server.js, exec fallback...';
        out.textContent = '⚠️ Eski server.js tespit edildi. exec action ile Docker + WGDashboard kuruluyor...\n\n';
        const fbResp = await runWgdInstallExec(payload.wgdPort, Number($('#twPort').value) || 51820, payload.autoInstallDocker);
        if (fbResp && fbResp.ok) {
          resp = { ok: true, code: 0, data: fbResp.data || '', stderr: fbResp.stderr || '' };
        }
      }
    } else if (action === 'f2ban-install') {
      // Step 5: Fail2Ban kurulumu
      // Önce sudo kontrolü
      status.textContent = 'sudo kontrol ediliyor...';
      const sudoTest = await new Promise((resolve) => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, data: '' }); return;
        }
        const id = wgState.nextId++;
        wgState.pending.set(id, resolve);
        state.ws.send(JSON.stringify({ type: 'exec', id, command: 'sudo -n id 2>&1; echo "__SUDO_TEST_DONE__"' }));
        setTimeout(() => { if (wgState.pending.has(id)) { wgState.pending.delete(id); resolve({ ok: false, data: '' }); } }, 8000);
      });
      const sudoOk = ((sudoTest.data || '') + (sudoTest.stderr || '')).includes('uid=0');
      if (!sudoOk) {
        li.classList.remove('wiz-running');
        li.classList.add('wiz-fail');
        status.textContent = 'sudo gerekli';
        out.textContent = '⚠️ Fail2Ban kurulumu için sudo yetkisi gerekli. Önce adım 0\'daki Sudo Hazırlığı\'nı tamamlayın.\n\nsudo -n id çıktısı:\n' + ((sudoTest.data || '') + (sudoTest.stderr || '')).trim();
        btn.disabled = false;
        showFixSudoCard('Fail2Ban kurulumu için sudo NOPASSWD gerekli. Root parolanızla otomatik ayarlayabilirsiniz.');
        setStatusBar('Sudo gerekli — adım 0\'ı çalıştırın');
        return;
      }
      payload = {
        ...params,
        wgPort: Number($('#twPort').value) || 51820,
      };
    } else if (action === 'f2ban-status' || action === 'f2ban-unban') {
      // Sudo kontrolü (sadece görüntüleme/komut için sudo gerekli değil ama runWizStep sırasında)
      payload = { ...params };
    }
    setStatusBar(`Sihirbaz adım ${stepNum} (${action}) çalışıyor...`);
    // add-peer / wgdashboard-install için resp yukarıda zaten set edildi (fallback ile)
    if (action !== 'add-peer' && action !== 'wgdashboard-install' && action !== 'f2ban-install' && action !== 'f2ban-status' && action !== 'f2ban-unban') {
      resp = await wgRequest(action, payload);
    }
    // f2ban action'lar için payload varsa resp'i wgRequest ile al
    if ((action === 'f2ban-install' || action === 'f2ban-status' || action === 'f2ban-unban') && payload && !resp) {
      resp = await wgRequest(action, payload);
    }
  } catch (e) {
    li.classList.remove('wiz-running');
    li.classList.add('wiz-fail');
    status.textContent = 'hata';
    out.textContent = 'HATA: ' + e.message;
    btn.disabled = false;
    setStatusBar('Sihirbaz adım ' + stepNum + ' hatası: ' + e.message);
    return;
  }

  const raw = (resp.data || '') + (resp.stderr || '');
  const errorMsg = resp.error || '';
  let displayText = raw.trim();
  if (!displayText && errorMsg) {
    if (errorMsg.includes('Zaman aşımı')) {
      displayText = `⏱️ ${errorMsg}\n\nİşlem 60 saniyede tamamlanmadı.\n- Server.js eski olabilir (Dokploy'da yeni commit deploy edilmeli)\n- veya komut sunucuda uzun sürüyor olabilir`;
    } else {
      displayText = `HATA: ${errorMsg}`;
    }
  }
  if (!displayText) displayText = '(çıktı yok — server bu action\'ı desteklemiyor olabilir. Dokploy\'da yeni commit deploy edilmeli.)';
  out.textContent = displayText;
  const ok = resp.ok && resp.code !== 1 && resp.code !== undefined ? resp.code === 0 : !!resp.ok;

  if (ok) {
    li.classList.remove('wiz-running');
    li.classList.add('wiz-ok');
    status.textContent = 'tamamlandı';
    twCurrent = stepNum;
    setStatusBar(`Sihirbaz adım ${stepNum} tamamlandı`);

    // Sonraki adımın butonunu aktif et
    const next = document.querySelector(`#twSteps li[data-step="${stepNum + 1}"]`);
    if (next) {
      next.querySelectorAll('.wiz-run, .wiz-existing, .wiz-skip').forEach(b => { if (b) b.disabled = false; });
    } else {
      // Son adım tamam — sonuç panelini göster
      showWizResult(action, raw, resp);
    }

    // Adım 2 (install) tamam ise server pubkey'i parse etmeye çalış
    if (action === 'install') {
      // Çıktıdan yakalamaya çalış: "Sunucu pubkey: <key>" benzeri satır
      const pub = (raw.match(/Sunucu [Pp]ub(?:lic)? [Kk]ey:?\s*([A-Za-z0-9+/=]+)/) || [])[1];
      if (pub) $('#twServerPub').value = pub;
    }
    // Adım 3 (add-peer) tamam ise client config'i parse et
    if (action === 'add-peer') {
      // Sunucu ===CLIENT_CONF=== ... ===BITTI=== bloğunu gönderiyor
      const confMatch = raw.match(/===CLIENT_CONF===\s*([\s\S]*?)===BITTI===/);
      const conf = confMatch ? confMatch[1].trim() : '';
      if (conf) {
        $('#twClientConf').value = conf;
        $('#twResult').hidden = false;
        // QR
        if (typeof QRCode !== 'undefined' && conf) {
          $('#twQrArea').innerHTML = '';
          new QRCode($('#twQrArea'), { text: conf, width: 180, height: 180, colorDark: '#000', colorLight: '#fff' });
        }
        // Link listesi
        const host = (readForm().host || '').trim() || location.hostname;
        $('#twLinks').innerHTML = `
          <li><b>VPN tüneli:</b> phone-1 → ${host}:${$('#twPort').value || 51820}</li>
          <li><b>Peer VPN IP:</b> ${$('#twPeerIP').value || '10.0.0.2/32'}</li>
          <li><b>Sunucu VPN IP:</b> ${$('#twAddress').value || '10.0.0.1/24'}</li>
          <li><b>WGDashboard:</b> http://${host}:${$('#twWgdPort').value || 10086} (adım 4'ü çalıştırın)</li>
        `;
      }
    }
  } else {
    li.classList.remove('wiz-running');
    li.classList.add('wiz-fail');
    status.textContent = 'hata oluştu';
    btn.disabled = false;
    setStatusBar(`Sihirbaz adım ${stepNum} başarısız`);

    // Adım 3 (peer ekleme) başarısızsa — mevcut config'i oku ve terminal'e yönlendir
    if (action === 'add-peer') {
      const peerName = $('#twPeerName')?.value?.trim() || 'phone-1';
      out.textContent = (raw || '') + '\n\n⚠️ Peer ekleme başarısız. /etc/wireguard/clients/' + peerName + '.conf hedef server\'da mevcutsa aşağıdaki komutla okuyabilirsin.\n';
      // Mevcut config'i otomatik yüklemeyi dene
      try {
        const listResp = await wgRequest('list-clients', {});
        if (listResp && listResp.ok) {
          const clientList = listResp.data || '';
          if (clientList.includes(peerName)) {
            // Mevcut — kullanıcıya bilgi ver
            out.textContent += `\n✅ /etc/wireguard/clients/${peerName}.conf MEVCUT. QR için terminal sekmesinden şu komutu çalıştır:\n\n  cat /etc/wireguard/clients/${peerName}.conf\n\n(Veya qrencode ile QR: qrencode -t ansiutf8 < /etc/wireguard/clients/${peerName}.conf)\n`;
            // Terminal sekmesine yönlendir
            const terminalTab = document.querySelector('[data-tab="terminal"], .tab[data-tab="terminal"]');
            if (terminalTab) terminalTab.click();
            setStatusBar('Peer config hedef server\'da mevcut. Terminal\'den okuyabilirsin.');
          } else {
            out.textContent += `\n❌ /etc/wireguard/clients/${peerName}.conf henüz yok.\n`;
          }
        }
      } catch (e) {
        // sessizce geç
      }
    }
  }
}

// === ACİL: Eski server.js'te step 3 başarısız olduğunda, frontend kendi
// script'ini hedef server'a çalıştırır. exec action'ı kullanır.
// Bu sayede Dokploy deploy gerek kalmadan yeni mantık çalışır. ===
async function runPeerAddDirect(peerName, allowedIP, dns, endpoint, listenPort) {
  return new Promise((resolve) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, error: 'WebSocket bağlı değil' });
      return;
    }
    const id = wgState.nextId++;
    wgState.pending.set(id, resolve);
    // Yeni peer ekleme script'i — allowed-ips plural + wg-quick restart
    const script = `bash -lc '
set -e
# Peer key üret
CLIENT_PRIV=\\$(wg genkey)
CLIENT_PUB=\\$(echo "\$CLIENT_PRIV" | wg pubkey)
CLIENT_PSK=\\$(wg genpsk)
SERVER_PUB=\\$(cat /etc/wireguard/server_public.key 2>/dev/null || true)
if [ -z "\$SERVER_PUB" ]; then
  SP=\\$(grep "^PrivateKey" /etc/wireguard/wg0.conf | head -1 | awk "{print \\$3}")
  SERVER_PUB=\\$(echo "\$SP" | wg pubkey)
fi
echo "PUB=\$CLIENT_PUB"
# Runtime wg set (yeni sistemde calismaz ama deneyelim)
sudo -n wg set wg0 peer "\$CLIENT_PUB" preshared-key "\$CLIENT_PSK" allowed-ips ${allowedIP} persistent-keepalive 25 2>/dev/null || true
# wg0.conf a ekle
sudo -n bash -c "
CONF=/etc/wireguard/wg0.conf
if grep -q \"^\\[Peer\\]\" \"\$CONF\" 2>/dev/null; then
  cat >> \"\$CONF\" <<WGPEER

[Peer]
PublicKey = \$CLIENT_PUB
PresharedKey = \$CLIENT_PSK
AllowedIPs = ${allowedIP}
PersistentKeepalive = 25
WGPEER
else
  cat >> \"\$CONF\" <<WGPEER

[Peer]
PublicKey = \$CLIENT_PUB
PresharedKey = \$CLIENT_PSK
AllowedIPs = ${allowedIP}
PersistentKeepalive = 25
WGPEER
fi
chmod 600 \"\$CONF\"
"
# wg-quick restart — ÖNCE MASQUERADE/FORWARD yedekle, SONRA yeniden ekle
echo "===Auto-recovery: MASQUERADE/FORWARD garantile==="
# Docker MASQUERADE 0.0.0.0/0 varsa sil (10.0.0.0/24'ü kapsıyor)
sudo -n iptables -t nat -D POSTROUTING -s 0.0.0.0/0 -j MASQUERADE 2>/dev/null || true
# MASQUERADE'ı en üste ekle (Docker kurallarından önce)
sudo -n iptables -t nat -I POSTROUTING 1 -s 10.0.0.0/24 -o ens34 -j MASQUERADE
# FORWARD kuralları (zaten varsa ekleme)
sudo -n iptables -C FORWARD -i wg0 -j ACCEPT 2>/dev/null || sudo -n iptables -I FORWARD 1 -i wg0 -j ACCEPT
sudo -n iptables -C FORWARD -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || sudo -n iptables -I FORWARD 1 -o wg0 -m state --state RELATED,ESTABLISHED -j ACCEPT
echo "MASQUERADE:"
sudo -n iptables -t nat -L POSTROUTING -n -v | head -5
echo "FORWARD:"
sudo -n iptables -L FORWARD -n -v | head -5
# nftables ile de garanti
if command -v nft >/dev/null 2>&1; then
  sudo -n nft list table ip nat >/dev/null 2>&1 || sudo -n nft add table ip nat
  sudo -n nft list chain ip nat postrouting >/dev/null 2>&1 || sudo -n nft 'add chain ip nat postrouting { type nat hook postrouting priority 100; }'
  sudo -n nft add rule ip nat postrouting iifname "wg0" oifname "ens34" counter masquerade 2>/dev/null || true
  sudo -n nft add rule ip nat postrouting ip saddr 10.0.0.0/24 oifname "ens34" counter masquerade 2>/dev/null || true
fi
echo "===wg-quick restart==="
sudo -n wg-quick down wg0 2>/dev/null || true
    sleep 1
    sudo -n wg-quick up wg0
# Client config yaz
sudo -n mkdir -p /etc/wireguard/clients
sudo -n bash -c "cat > /etc/wireguard/clients/${peerName}.conf" <<CFGEOF
[Interface]
PrivateKey = \$CLIENT_PRIV
Address = ${allowedIP}
DNS = ${dns}

[Peer]
PublicKey = \$SERVER_PUB
PresharedKey = \$CLIENT_PSK
Endpoint = ${endpoint}
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
CFGEOF
sudo -n chmod 600 /etc/wireguard/clients/${peerName}.conf
sudo -n wg show wg0
echo "===CLIENT_PRIV==="; echo "\$CLIENT_PRIV"
echo "===CLIENT_PUB==="; echo "\$CLIENT_PUB"
echo "===CLIENT_PSK==="; echo "\$CLIENT_PSK"
echo "===CLIENT_CONF==="
sudo -n cat /etc/wireguard/clients/${peerName}.conf
echo "===BITTI==="
'`;
    state.ws.send(JSON.stringify({ type: 'exec', id, command: script }));
    setTimeout(() => {
      if (wgState.pending.has(id)) {
        wgState.pending.delete(id);
        resolve({ ok: false, error: 'Timeout (30s)' });
      }
    }, 30000);
  });
}

// === ACIL: WGDashboard için exec fallback (eski server.js ile uyumlu) ===
// Docker kontrol + (yoksa) otomatik kur + compose up
async function runWgdInstallExec(wgdPort, wgPort, autoInstallDocker) {
  return new Promise((resolve) => {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, error: 'WebSocket bağlı değil' });
      return;
    }
    const id = wgState.nextId++;
    wgState.pending.set(id, resolve);
    const dockerInstall = `bash -lc '
set -e
export DEBIAN_FRONTEND=noninteractive
echo "[docker/1] apt update..."
sudo -n apt-get update -y || { echo "apt update basarisiz (sudo NOPASSWD gerekli)"; exit 1; }
echo "[docker/2] onkosullar..."
sudo -n apt-get install -y ca-certificates curl gnupg lsb-release
echo "[docker/3] GPG key..."
sudo -n install -m 0755 -d /etc/apt/keyrings
sudo -n curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo -n chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
sudo -n bash -c "echo \\"deb [arch=\\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \\${VERSION_CODENAME} stable\\" > /etc/apt/sources.list.d/docker.list"
sudo -n apt-get update -y
echo "[docker/4] docker-ce kuruluyor (60-120sn)..."
sudo -n apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
echo "[docker/5] systemd..."
sudo -n systemctl enable --now docker
sleep 3
docker --version && docker compose version
echo "===DOCKER_READY==="
' 2>&1`;
    const wgdInstall = `bash -lc '
set -e
INSTALL=/opt/wgdashboard
CONF_DIR=/etc/wireguard
echo "[1/4] compose.yaml yaziliyor..."
sudo -n mkdir -p "$INSTALL"
cat > "$INSTALL/compose.yaml" <<WGDCOMPOSE
services:
  wgdashboard:
    image: ghcr.io/wgdashboard/wgdashboard:latest
    container_name: wgdashboard
    restart: unless-stopped
    hostname: wgdashboard
    ports:
      - "${wgdPort}:10086/tcp"
      - "${wgPort}:51820/udp"
    volumes:
      - $CONF_DIR:/etc/wireguard
      - wg-data:/data
    cap_add:
      - NET_ADMIN
    sysctls:
      - net.ipv4.ip_forward=1
volumes:
  wg-data:
WGDCOMPOSE
sudo -n chmod 644 "$INSTALL/compose.yaml"
echo "[2/4] WG dizini..."
sudo -n mkdir -p "$CONF_DIR"
sudo -n chmod 700 "$CONF_DIR"
echo "[3/4] compose pull + up..."
cd "$INSTALL" && sudo -n docker compose pull
cd "$INSTALL" && sudo -n docker compose up -d
sleep 5
echo "[4/4] durum..."
echo "===STATUS==="
cd "$INSTALL" && sudo -n docker compose ps
echo "===PORTS==="
(ss -tulnp 2>/dev/null | grep -E ":${wgdPort}|:${wgPort}" || netstat -tulnp 2>/dev/null | grep -E ":${wgdPort}|:${wgPort}" || echo "port-bos")
echo "===BITTI==="
' 2>&1`;
    const script = `bash -lc '
if command -v docker >/dev/null 2>&1 && command -v docker compose >/dev/null 2>&1; then
  echo "[DOCKER] Docker zaten kurulu"
  docker --version
else
  if [ "${autoInstallDocker}" = "true" ]; then
    echo "[DOCKER] Docker kurulacak (autoInstallDocker=true)..."
${dockerInstall}
  else
    echo "Docker yok ve autoInstallDocker=false — once manuel kurun"; exit 1;
  fi
fi
${wgdInstall}
' 2>&1`;
    state.ws.send(JSON.stringify({ type: 'exec', id, command: script }));
    // Docker kurulumu + wg pull yavas olabilir, 3 dk bekle
    setTimeout(() => {
      if (wgState.pending.has(id)) {
        wgState.pending.delete(id);
        resolve({ ok: false, error: 'Timeout (180s) — Docker kurulumu uzun suruyor' });
      }
    }, 180000);
  });
}

function showWizResult(action, raw, resp) {
  // Son adım tamam → result panelini göster
  $('#twResult').hidden = false;
  const peerName = $('#twPeerName').value.trim() || 'phone-1';
  const host = (readForm().host || '').trim() || location.hostname;
  const listenPort = Number($('#twPort').value) || 51820;
  const wgdPort = Number($('#twWgdPort').value) || 10086;

  // Client config yoksa sunucudan oku (peer zaten ekliyse) → QR üretebilmek için
  if (!$('#twClientConf').value) {
    // Sunucudan okumayı dene (mevcut config varsa)
    (async () => {
      const readResp = await new Promise((resolve) => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
          resolve({ ok: false, error: 'WebSocket bağlı değil' }); return;
        }
        const id = wgState.nextId++;
        wgState.pending.set(id, resolve);
        state.ws.send(JSON.stringify({
          type: 'exec',
          id,
          command: `bash -lc 'if [ -f /etc/wireguard/clients/${peerName}.conf ]; then echo "===CLIENT_CONF==="; cat /etc/wireguard/clients/${peerName}.conf; echo "===BITTI==="; else echo "YOK"; fi'`,
        }));
        setTimeout(() => { if (wgState.pending.has(id)) { wgState.pending.delete(id); resolve({ ok: false, error: 'Timeout' }); } }, 8000);
      });
      const rawOut = (readResp.data || '') + (readResp.stderr || '');
      const m = rawOut.match(/===CLIENT_CONF===\s*([\s\S]*?)===BITTI===/);
      const conf = m ? m[1].trim() : '';
      if (conf) {
        $('#twClientConf').value = conf;
        if (typeof QRCode !== 'undefined') {
          $('#twQrArea').innerHTML = '';
          new QRCode($('#twQrArea'), { text: conf, width: 200, height: 200, colorDark: '#000', colorLight: '#fff' });
        }
        setStatusBar('QR kodu üretildi (' + peerName + ')');
      } else {
        setStatusBar('Mevcut config yok, QR üretilmedi');
      }
    })();
  } else {
    // Client config zaten var — QR yeniden oluştur (emin ol)
    const conf = $('#twClientConf').value;
    if (typeof QRCode !== 'undefined' && conf) {
      $('#twQrArea').innerHTML = '';
      new QRCode($('#twQrArea'), { text: conf, width: 200, height: 200, colorDark: '#000', colorLight: '#fff' });
    }
  }

  $('#twLinks').innerHTML = `
    <li><b>WireGuard arayüzü:</b> ${$('#twIface').value || 'wg0'}</li>
    <li><b>Sunucu VPN IP:</b> ${$('#twAddress').value || '10.0.0.1/24'}</li>
    <li><b>Port:</b> ${listenPort}</li>
    <li><b>WGDashboard:</b> http://${host}:${wgdPort}</li>
    <li><b>Peer VPN IP:</b> ${$('#twPeerIP').value || '10.0.0.2/32'} (${peerName})</li>
  `;
}

// İndir / Kopyala
$('#twDownload').addEventListener('click', () => {
  const conf = $('#twClientConf').value;
  if (!conf) return;
  const name = $('#twPeerName').value.trim() || 'phone-1';
  const blob = new Blob([conf], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wg-${name}.conf`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#twCopy').addEventListener('click', async () => {
  const conf = $('#twClientConf').value;
  if (!conf) return;
  try {
    await navigator.clipboard.writeText(conf);
    setStatusBar('Panoya kopyalandı');
  } catch (e) {
    setStatusBar('Kopyalama hatası: ' + e.message);
  }
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
    if (typeof applyAiSize === 'function') applyAiSize();
  }
}

$('#aiChatToggle').addEventListener('click', () => aiToggle());
$('#aiChatClose').addEventListener('click', () => aiToggle(false));

// AI panel boyut toggle: küçük → orta → büyük → küçük
const aiSizes = [
  { cls: 'ai-size-s', icon: '⤡', label: 'küçük (320×420)' },
  { cls: 'ai-size-m', icon: '⤢', label: 'orta (420×560)' },
  { cls: 'ai-size-l', icon: '⤡', label: 'büyük (600×720)' },
];
let aiSizeIdx = 1;
function applyAiSize() {
  const panel = $('#aiChatPanel');
  if (!panel) return;
  panel.classList.remove('ai-size-s', 'ai-size-m', 'ai-size-l');
  const size = aiSizes[aiSizeIdx];
  panel.classList.add(size.cls);
  const btn = $('#aiChatSize');
  if (btn) {
    btn.textContent = size.icon;
    btn.title = `Pencere boyutu: ${size.label} (tıkla: değiştir)`;
  }
}
$('#aiChatSize')?.addEventListener('click', () => {
  aiSizeIdx = (aiSizeIdx + 1) % aiSizes.length;
  applyAiSize();
  try { localStorage.setItem('aiSizeIdx', String(aiSizeIdx)); } catch {}
});
// İlk açılışta önceki seçimi hatırla
try {
  const saved = Number(localStorage.getItem('aiSizeIdx'));
  if (Number.isInteger(saved) && saved >= 0 && saved < aiSizes.length) {
    aiSizeIdx = saved;
  }
} catch {}
// Panel açıldığında boyutu uygula (default orta)
applyAiSize();
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
