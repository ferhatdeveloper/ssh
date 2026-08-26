import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Client } from 'ssh2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function makeSshConfig(opts) {
  const config = {
    host: opts.host,
    port: Number(opts.port) || 22,
    username: opts.username,
    readyTimeout: 20000,
  };
  if (opts.password) config.password = opts.password;
  if (opts.privateKey) {
    try {
      config.privateKey = Buffer.from(opts.privateKey);
      if (opts.passphrase) config.passphrase = opts.passphrase;
    } catch (e) {
      throw new Error('Özel anahtar okunamadı: ' + e.message);
    }
  }
  if (opts.algorithms) {
    try {
      config.algorithms = typeof opts.algorithms === 'string' ? JSON.parse(opts.algorithms) : opts.algorithms;
    } catch (e) {
      throw new Error('Algoritmalar ayrıştırılamadı: ' + e.message);
    }
  }
  return config;
}

function handleShell(ws, conn, cols, rows, termType) {
  conn.shell(
    { cols: Number(cols) || 80, rows: Number(rows) || 24, term: termType || 'xterm-256color' },
    (err, stream) => {
      if (err) {
        sendJson(ws, { type: 'error', message: 'Shell başlatılamadı: ' + err.message });
        conn.end();
        return;
      }
      sendJson(ws, { type: 'status', status: 'connected' });

      stream.on('data', (data) => sendJson(ws, { type: 'data', data: data.toString('utf8') }));
      stream.on('close', () => {
        sendJson(ws, { type: 'status', status: 'closed' });
        conn.end();
      });

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          stream.write(raw.toString('utf8'));
          return;
        }
        if (msg.type === 'data') stream.write(msg.data);
        else if (msg.type === 'resize') {
          try { stream.setWindow(msg.rows, msg.cols, 0, 0); } catch {}
        } else if (msg.type === 'signal') {
          try { stream.signal(msg.signal); } catch {}
        } else if (msg.type === 'exec') {
          runExec(conn, msg.command, (resp) => sendJson(ws, resp), msg.id);
        } else if (msg.type === 'wireguard') {
          handleWireGuard(conn, msg, (resp) => sendJson(ws, resp));
        }
      });

      ws.on('close', () => {
        try { stream.close(); } catch {}
        conn.end();
      });
    }
  );
}

function handleSftp(ws, conn) {
  conn.sftp((err, sftp) => {
    if (err) {
      sendJson(ws, { type: 'sftp-error', message: err.message });
      return;
    }
    sendJson(ws, { type: 'sftp-ready' });

    const handleRequest = (req) => {
      const respond = (payload) => sendJson(ws, { type: 'sftp-response', id: req.id, ...payload });

      switch (req.action) {
        case 'list': {
          sftp.readdir(req.path || '.', (e, list) => {
            if (e) return respond({ ok: false, error: e.message });
            const items = list.map((it) => ({
              filename: it.filename,
              longname: it.longname,
              attrs: {
                size: it.attrs.size,
                mode: it.attrs.mode,
                isDirectory: (it.attrs.mode & 0o170000) === 0o040000,
                isFile: (it.attrs.mode & 0o170000) === 0o100000,
                mtime: it.attrs.mtime * 1000,
                atime: it.attrs.atime * 1000,
              },
            }));
            respond({ ok: true, items });
          });
          break;
        }
        case 'mkdir': {
          sftp.mkdir(req.path, { mode: req.mode || 0o755 }, (e) => {
            if (e) return respond({ ok: false, error: e.message });
            respond({ ok: true });
          });
          break;
        }
        case 'rmdir': {
          sftp.rmdir(req.path, (e) => {
            if (e) return respond({ ok: false, error: e.message });
            respond({ ok: true });
          });
          break;
        }
        case 'unlink': {
          sftp.unlink(req.path, (e) => {
            if (e) return respond({ ok: false, error: e.message });
            respond({ ok: true });
          });
          break;
        }
        case 'rename': {
          sftp.rename(req.src, req.dst, (e) => {
            if (e) return respond({ ok: false, error: e.message });
            respond({ ok: true });
          });
          break;
        }
        case 'stat': {
          sftp.stat(req.path, (e, st) => {
            if (e) return respond({ ok: false, error: e.message });
            respond({
              ok: true,
              attrs: {
                size: st.size,
                mode: st.mode,
                isDirectory: (st.mode & 0o170000) === 0o040000,
                isFile: (st.mode & 0o170000) === 0o100000,
                mtime: st.mtime * 1000,
                atime: st.atime * 1000,
              },
            });
          });
          break;
        }
        case 'read': {
          const chunks = [];
          const stream = sftp.createReadStream(req.path, { start: req.start || 0, end: req.end });
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            respond({ ok: true, data: buf.toString('base64'), size: buf.length });
          });
          stream.on('error', (e) => respond({ ok: false, error: e.message }));
          break;
        }
        case 'write': {
          const buf = Buffer.from(req.data, 'base64');
          const stream = sftp.createWriteStream(req.path);
          stream.on('close', () => respond({ ok: true }));
          stream.on('error', (e) => respond({ ok: false, error: e.message }));
          stream.end(buf);
          break;
        }
        default:
          respond({ ok: false, error: 'Bilinmeyen SFTP eylemi: ' + req.action });
      }
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'sftp') handleRequest(msg);
      else if (msg.type === 'exec') runExec(conn, msg.command, (resp) => sendJson(ws, resp), msg.id);
      else if (msg.type === 'wireguard') handleWireGuard(conn, msg, (resp) => sendJson(ws, resp));
    });
  });
}

// WebSSH her bağlantıda hedef kullanıcının sudo'sunu NOPASSWD yapar.
// Böylece runExec ile gelen sudo'lu komutlar parola soramaz ve başarısız olmaz.
// root kullanıcısı için sudo gerekmez (zaten root).
// İlk çalıştırmada sudo parola isteyebilir — bu durumda hata döner ama bağlantı açık kalır.
// İkinci bağlantıdan itibaren NOPASSWD aktif olur.
function enableSudoNopasswd(conn, username, callback) {
  if (!username || username === 'root') return callback({ ok: true, method: 'root-skip' });

  const script = `bash -lc '
set -e
# 1) Zaten NOPASSWD mi kontrol et
if sudo -n true 2>/dev/null; then
  echo "ALREADY_OK"
  exit 0
fi
# 2) Mevcut sudoers.d/ dosyalarında bu kullanıcı için NOPASSWD var mı?
if grep -rq "^${username} .*NOPASSWD" /etc/sudoers.d/ 2>/dev/null; then
  echo "ALREADY_OK"
  exit 0
fi
# 3) /etc/sudoers.d/ yoksa oluştur
${"[ -d /etc/sudoers.d ] || mkdir -m 0755 /etc/sudoers.d || true"}
# 4) NOPASSWD dosyasını yaz — visudo -c ile validate et
TMPFILE=\\$(mktemp /tmp/sudoers.XXXXXX)
echo "${username} ALL=(ALL) NOPASSWD:ALL" > "\$TMPFILE"
if [ -x /usr/sbin/visudo ]; then
  if ! /usr/sbin/visudo -c -f "\$TMPFILE" >/dev/null 2>&1; then
    echo "VALIDATE_FAIL"
    rm -f "\$TMPFILE"
    exit 1
  fi
fi
# 5) Yerleştir — mv daha güvenli (atomik)
mv "\$TMPFILE" /etc/sudoers.d/${username}
chmod 0440 /etc/sudoers.d/${username}
# 6) Doğrula
if sudo -n true 2>/dev/null; then
  echo "WRITTEN_OK"
else
  echo "VERIFY_FAIL"
  exit 1
fi
' 2>&1`;

  conn.exec(script, (err, stream) => {
    if (err) return callback({ ok: false, error: err.message });
    let out = '';
    stream.on('data', (d) => { out += d.toString('utf8'); });
    stream.on('close', (code) => {
      const ok = code === 0 && (out.includes('ALREADY_OK') || out.includes('WRITTEN_OK'));
      callback({ ok, method: out.trim(), error: ok ? null : `exit=${code} out=${out.trim().slice(0, 200)}` });
    });
  });
}

// Tek seferlik komut çalıştır, stdout/stderr/exitCode topla
function runExec(conn, command, respond, id) {
  conn.exec(command, (err, stream) => {
    if (err) return respond({ type: 'exec-response', id, ok: false, error: err.message });
    let stdout = '';
    let stderr = '';
    stream.on('data', (d) => { stdout += d.toString('utf8'); });
    stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    stream.on('close', (code) => {
      respond({ type: 'exec-response', id, ok: true, stdout, stderr, code });
    });
  });
}

// WireGuard yönetimi - tüm komutlar SSH exec üzerinden uzak sunucuda çalışır
function handleWireGuard(conn, msg, respond) {
  const respondWithError = (e) => respond({ type: 'wg-response', id: msg.id, ok: false, error: e.message });

  switch (msg.action) {
    case 'detect': {
      // OS algılama + mevcut wg kurulumu
      const cmd = `bash -lc '
        set +e
        echo "===OS==="
        . /etc/os-release 2>/dev/null
        echo "\${ID:-unknown} \${VERSION_ID:-unknown}"
        echo "===ARCH==="
        uname -m
        echo "===WG==="
        which wg && wg --version || echo "wg-yok"
        which wg-quick && wg-quick --version || true
        echo "===PKG==="
        (command -v apt-get && echo apt) || (command -v yum && echo yum) || (command -v dnf && echo dnf) || (command -v apk && echo apk) || (command -v pacman && echo pacman) || echo unknown
        echo "===SUDO==="
        command -v sudo >/dev/null && echo sudo-var || echo sudo-yok
        echo "===SERVICE==="
        (command -v systemctl >/dev/null && echo systemd) || echo no-systemd
      '`;
      runExec(conn, cmd, (resp) => {
        if (!resp.ok) return respond({ type: 'wg-response', id: msg.id, ok: false, error: resp.error });
        respond({ type: 'wg-response', id: msg.id, ok: true, action: 'detect', data: resp.stdout, code: resp.code });
      });
      break;
    }

    case 'install': {
      // Tek tıkla kurulum: paket yükle + anahtar üret + wg0.conf yaz + servisi başlat
      const iface = msg.interface || 'wg0';
      const address = msg.address || '10.0.0.1/24';
      const listenPort = msg.listenPort || 51820;
      const dns = msg.dns || '1.1.1.1, 8.8.8.8';
      const useSudo = msg.useSudo !== false;
      const su = useSudo ? 'sudo ' : '';
      // Komutun tamamı bash heredoc ile tek seferde gönderiliyor
      const script = `bash -lc '
set -e
PKG=\$(command -v apt-get >/dev/null && echo apt || (command -v yum >/dev/null && echo yum || (command -v dnf >/dev/null && echo dnf || (command -v apk >/dev/null && echo apk || echo pacman))))
echo "[1/5] Paket yöneticisi: \$PKG"
case "\$PKG" in
  apt)    ${su}apt-get update -y >/dev/null && ${su}apt-get install -y wireguard qrencode iptables ;;
  yum)    ${su}yum install -y epel-release elrepo-release >/dev/null 2>&1; ${su}yum install -y wireguard-tools qrencode iptables-legacy ;;
  dnf)    ${su}dnf install -y wireguard-tools qrencode iptables ;;
  apk)    ${su}apk add --no-cache wireguard-tools qrencode iptables ;;
  pacman) ${su}pacman -Sy --noconfirm wireguard-tools qrencode iptables ;;
esac
echo "[2/5] Sunucu anahtar çifti üretiliyor..."
${su}install -d -m 0700 /etc/wireguard
if [ ! -f /etc/wireguard/server_private.key ]; then
  ${su}bash -c "wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key"
  ${su}chmod 600 /etc/wireguard/server_private.key
fi
SERVER_PRIV=\$(${su}cat /etc/wireguard/server_private.key)
SERVER_PUB=\$(${su}cat /etc/wireguard/server_public.key)
echo "Sunucu pubkey: \$SERVER_PUB"
echo "[3/5] /etc/wireguard/${iface}.conf yazılıyor..."
# Varsayılan ağ arayüzünü önceden hesapla (NESTED single quote YOK, sadece /proc/net/route + cut)
DEFAULT_IF=\$(grep "00000000" /proc/net/route 2>/dev/null | head -1 | cut -f1)
[ -z "\$DEFAULT_IF" ] && DEFAULT_IF=\$(${su}ip route show default 2>/dev/null | head -1 | grep -oE "dev [^ ]+" | grep -oE "[^ ]+\$")
DEFAULT_IF=\${DEFAULT_IF:-eth0}
echo "Arayüz: \$DEFAULT_IF"
${su}bash -lc "cat > /etc/wireguard/${iface}.conf" <<EOF
[Interface]
Address = ${address}
ListenPort = ${listenPort}
PrivateKey = \$SERVER_PRIV
PostUp = ${su}iptables -A FORWARD -i %i -j ACCEPT; ${su}iptables -t nat -A POSTROUTING -o \$DEFAULT_IF -j MASQUERADE
PostDown = ${su}iptables -D FORWARD -i %i -j ACCEPT; ${su}iptables -t nat -D POSTROUTING -o \$DEFAULT_IF -j MASQUERADE
EOF
${su}chmod 600 /etc/wireguard/${iface}.conf
echo "[4/5] IP yönlendirme etkinleştiriliyor..."
${su}bash -c "grep -q net.ipv4.ip_forward /etc/sysctl.conf || echo net.ipv4.ip_forward=1 >> /etc/sysctl.conf"
${su}sysctl -w net.ipv4.ip_forward=1 >/dev/null
echo "[5/5] Servis başlatılıyor..."
if command -v systemctl >/dev/null; then
  ${su}systemctl enable wg-quick@${iface} >/dev/null 2>&1 || true
  ${su}systemctl restart wg-quick@${iface}
else
  ${su}wg-quick up ${iface}
fi
sleep 1
echo "===DURUM==="
${su}wg show
echo "===BITTI==="
' 2>&1`;
      runExec(conn, script, (resp) => {
        respond({
          type: 'wg-response', id: msg.id, ok: resp.ok,
          action: 'install', data: resp.stdout, stderr: resp.stderr, code: resp.code,
        });
      });
      break;
    }

    case 'status': {
      const iface = msg.interface || 'wg0';
      const su = msg.useSudo !== false ? 'sudo ' : '';
      const cmd = `bash -lc '${su}wg show ${iface} 2>&1 || echo "interface-bos"; echo "===CONF==="; ${su}test -f /etc/wireguard/${iface}.conf && ${su}cat /etc/wireguard/${iface}.conf || echo "conf-yok"'`;
      runExec(conn, cmd, (resp) => {
        respond({ type: 'wg-response', id: msg.id, ok: resp.ok, action: 'status', data: resp.stdout, code: resp.code });
      });
      break;
    }

    case 'add-peer': {
      // Sunucu tarafında peer'ı oluşturup, istemci için konfig üret
      const iface = msg.interface || 'wg0';
      const peerName = msg.name || ('peer-' + Date.now());
      const su = msg.useSudo !== false ? 'sudo ' : '';
      const allowedIP = msg.allowedIP || '10.0.0.2/32';
      const dns = msg.dns || '1.1.1.1, 8.8.8.8';
      // Endpoint boşsa sunucunun public IP + listenPort'tan oluştur
      const listenPort = msg.listenPort || 51820;
      const endpoint = msg.endpoint || (msg.serverPublicIP ? `${msg.serverPublicIP}:${listenPort}` : '');
      const script = `bash -lc '
set +e
${su}install -d -m 0700 /etc/wireguard
# wg0 interface yoksa wg-quick ile başlat
${su}wg show ${iface} >/dev/null 2>&1 || ${su}wg-quick up ${iface} || true
# FULL PATH ile çalıştır - PATH sorunlarına karşı
WG_BIN=\$(command -v wg)
echo "wg binary: \$WG_BIN"
if [ ! -x "\$WG_BIN" ]; then echo "HATA: wg komutu bulunamadı"; exit 1; fi
CLIENT_PRIV="\$(\$WG_BIN genkey)"
echo "CLIENT_PRIV uzunluk: \${#CLIENT_PRIV}"
if [ -z "\$CLIENT_PRIV" ]; then echo "HATA: genkey boş"; exit 1; fi
CLIENT_PSK="\$(\$WG_BIN genpsk)"
CLIENT_PUB="\$(echo "\$CLIENT_PRIV" | \$WG_BIN pubkey)"
SERVER_PUB="\$(${su}cat /etc/wireguard/server_public.key 2>/dev/null)"
SERVER_PRIV="\$(${su}cat /etc/wireguard/server_private.key 2>/dev/null)"
echo "CLIENT_PUB u: \${#CLIENT_PUB}, SERVER_PUB u: \${#SERVER_PUB}"
# Endpoint boşsa sunucunun public IP'sini bul
ENDPOINT="${endpoint}"
if [ -z "\$ENDPOINT" ]; then
  PUB_IP=\$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -i | cut -d" " -f1)
  ENDPOINT="\${PUB_IP}:${listenPort}"
fi
echo "Endpoint: \$ENDPOINT"
# wg-quick servisi altında wg0 olmayabilir; bu yüzden sudo wg set kullan
${su}wg set ${iface} peer "\$CLIENT_PUB" preshared-key "\$CLIENT_PSK" allowed-ip ${allowedIP} persistent-keepalive 25
SET_RC=\$?
echo "wg set exit: \$SET_RC"
${su}mkdir -p /etc/wireguard/clients
# Client config'i yaz
${su}tee /etc/wireguard/clients/${peerName}.conf >/dev/null <<CFGEOF
[Interface]
PrivateKey = \$CLIENT_PRIV
Address = ${allowedIP}
DNS = ${dns}

[Peer]
PublicKey = \$SERVER_PUB
PresharedKey = \$CLIENT_PSK
Endpoint = \$ENDPOINT
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
CFGEOF
${su}chmod 600 /etc/wireguard/clients/${peerName}.conf
# wg0.conf içine kalıcı yaz
${su}wg-quick save ${iface} 2>&1 || true
echo "===CLIENT_PRIV==="; echo "\$CLIENT_PRIV"
echo "===CLIENT_PUB==="; echo "\$CLIENT_PUB"
echo "===CLIENT_PSK==="; echo "\$CLIENT_PSK"
echo "===CLIENT_CONF==="
${su}cat /etc/wireguard/clients/${peerName}.conf
echo "===BITTI==="
' 2>&1`;
      runExec(conn, script, (resp) => {
        respond({
          type: 'wg-response', id: msg.id, ok: resp.ok,
          action: 'add-peer', data: resp.stdout, stderr: resp.stderr, code: resp.code,
        });
      });
      break;
    }

    case 'remove-peer': {
      const iface = msg.interface || 'wg0';
      const su = msg.useSudo !== false ? 'sudo ' : '';
      const cmd = `bash -lc '${su}wg set ${iface} peer ${msg.publicKey} remove && ${su}rm -f /etc/wireguard/clients/${msg.name}.conf && echo OK'`;
      runExec(conn, cmd, (resp) => {
        respond({ type: 'wg-response', id: msg.id, ok: resp.ok, action: 'remove-peer', data: resp.stdout, code: resp.code });
      });
      break;
    }

    case 'list-clients': {
      const su = msg.useSudo !== false ? 'sudo ' : '';
      const cmd = `bash -lc '${su}ls -1 /etc/wireguard/clients/ 2>/dev/null || echo ""; echo "===PEERS==="; ${su}wg show ${msg.interface || "wg0"} peers 2>/dev/null || echo ""; echo "===HANDSHAKES==="; ${su}wg show ${msg.interface || "wg0"} latest-handshakes 2>/dev/null || echo ""; echo "===TRANSFER==="; ${su}wg show ${msg.interface || "wg0"} transfer 2>/dev/null || echo ""'`;
      runExec(conn, cmd, (resp) => {
        respond({ type: 'wg-response', id: msg.id, ok: resp.ok, action: 'list-clients', data: resp.stdout, code: resp.code });
      });
      break;
    }

    case 'save-config': {
      // Aktif yapılandırmayı /etc/wireguard/wg0.conf üzerine yaz
      const iface = msg.interface || 'wg0';
      const su = msg.useSudo !== false ? 'sudo ' : '';
      const cmd = `bash -lc '${su}wg-quick save ${iface} 2>&1; echo OK'`;
      runExec(conn, cmd, (resp) => {
        respond({ type: 'wg-response', id: msg.id, ok: resp.ok, action: 'save-config', data: resp.stdout, code: resp.code });
      });
      break;
    }

    case 'wgdashboard-detect': {
      // Docker ve docker compose var mı?
      const su = msg.useSudo !== false ? 'sudo ' : '';
      const cmd = `bash -lc '
        echo "===DOCKER==="
        command -v docker && docker --version || echo "docker-yok"
        echo "===COMPOSE==="
        (docker compose version 2>/dev/null && echo "docker-compose-v2") || (command -v docker-compose && docker-compose --version) || echo "compose-yok"
        echo "===WGDASHBOARD==="
        docker ps --filter name=wgdashboard --format "{{.Names}} {{.Status}}" 2>/dev/null || echo "wgd-bos"
        docker ps -a --filter name=wgdashboard --format "{{.Names}} {{.Status}}" 2>/dev/null || echo ""
        echo "===PORTS==="
        (ss -tulnp 2>/dev/null | grep -E ":10086|:51820" || netstat -tulnp 2>/dev/null | grep -E ":10086|:51820" || echo "port-bos")
        echo "===HOST_IP==="
        hostname -i 2>/dev/null | cut -d" " -f1
      '`;
      runExec(conn, cmd, (resp) => {
        respond({ type: 'wg-response', id: msg.id, ok: resp.ok, action: 'wgdashboard-detect', data: resp.stdout, code: resp.code });
      });
      break;
    }

    case 'wgdashboard-install': {
      // Tek tıkla WGDashboard kurulumu: docker compose dosyası yaz + ayağa kaldır
      const wgConfDir = msg.wgConfDir || '/etc/wireguard';
      const wgdPort = msg.wgdPort || 10086;
      const wgPort = msg.wgPort || 51820;
      const wgIface = msg.interface || 'wg0';
      const installDir = msg.installDir || '/opt/wgdashboard';
      const su = msg.useSudo !== false ? 'sudo ' : '';
      // compose.yaml içeriği
      const composeYaml = `services:
  wgdashboard:
    image: ghcr.io/wgdashboard/wgdashboard:latest
    container_name: wgdashboard
    restart: unless-stopped
    hostname: wgdashboard
    ports:
      - "${wgdPort}:10086/tcp"
      - "${wgPort}:51820/udp"
    volumes:
      - ${wgConfDir}:/etc/wireguard
      - wg-data:/data
    cap_add:
      - NET_ADMIN
    sysctls:
      - net.ipv4.ip_forward=1

volumes:
  wg-data:
`;
      // base64 ile güvenli taşıma (escape sorunu yok)
      const b64 = Buffer.from(composeYaml, 'utf8').toString('base64');
      const cmd = `bash -lc '
set -e
echo "[1/4] Docker kontrol ediliyor..."
command -v docker >/dev/null || { echo "Docker yüklü değil"; exit 1; }
docker --version
echo "[2/4] Compose dosyası yazılıyor..."
${su}mkdir -p ${installDir}
echo "${b64}" | base64 -d | ${su}tee ${installDir}/compose.yaml >/dev/null
${su}chmod 644 ${installDir}/compose.yaml
echo "[3/4] WireGuard dizini hazırlanıyor..."
${su}mkdir -p ${wgConfDir}
${su}chmod 700 ${wgConfDir}
echo "[4/4] WGDashboard ayağa kaldırılıyor..."
cd ${installDir} && ${su}docker compose pull
cd ${installDir} && ${su}docker compose up -d
sleep 3
echo "===STATUS==="
cd ${installDir} && ${su}docker compose ps
echo "===PORTS==="
(ss -tulnp 2>/dev/null | grep -E ":${wgdPort}|:${wgPort}" || netstat -tulnp 2>/dev/null | grep -E ":${wgdPort}|:${wgPort}" || echo "port-bos")
echo "===BITTI==="
' 2>&1`;
      runExec(conn, cmd, (resp) => {
        respond({ type: 'wg-response', id: msg.id, ok: resp.ok, action: 'wgdashboard-install', data: resp.stdout, stderr: resp.stderr, code: resp.code });
      });
      break;
    }

    case 'wgdashboard-uninstall': {
      const su = msg.useSudo !== false ? 'sudo ' : '';
      const cmd = `bash -lc 'cd /opt/wgdashboard 2>/dev/null && ${su}docker compose down -v 2>&1; ${su}rm -rf /opt/wgdashboard 2>&1; echo OK'`;
      runExec(conn, cmd, (resp) => {
        respond({ type: 'wg-response', id: msg.id, ok: resp.ok, action: 'wgdashboard-uninstall', data: resp.stdout, code: resp.code });
      });
      break;
    }

    case 'wgdashboard-status': {
      const su = msg.useSudo !== false ? 'sudo ' : '';
      const cmd = `bash -lc '
echo "===CONTAINER==="
${su}docker ps --filter name=wgdashboard --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}" 2>/dev/null || echo "calismadi"
echo "===LOGS==="
${su}docker logs --tail 30 wgdashboard 2>&1 || echo "log-yok"
echo "===PORTS==="
(ss -tulnp 2>/dev/null | grep -E ":10086|:51820" || echo "port-bos")
'`;
      runExec(conn, cmd, (resp) => {
        respond({ type: 'wg-response', id: msg.id, ok: resp.ok, action: 'wgdashboard-status', data: resp.stdout, code: resp.code });
      });
      break;
    }

    case 'wgdashboard-logs': {
      const tail = Number(msg.tail) || 100;
      const su = msg.useSudo !== false ? 'sudo ' : '';
      const cmd = `${su}docker logs --tail ${tail} wgdashboard 2>&1`;
      runExec(conn, cmd, (resp) => {
        respond({ type: 'wg-response', id: msg.id, ok: resp.ok, action: 'wgdashboard-logs', data: resp.stdout, code: resp.code });
      });
      break;
    }

    case 'setup-wizard': {
      // A'dan Z'ye tek tıkla kurulum sihirbazı:
      // 1) WireGuard paket kurulumu
      // 2) Sunucu anahtar çifti + /etc/wireguard/wg0.conf
      // 3) IP yönlendirme + NAT
      // 4) wg-quick servisi başlatma
      // 5) İlk peer oluşturma (opsiyonel)
      // 6) WGDashboard kurulumu (Docker Compose)
      //
      // Her adımın çıktısını JSON dizisi olarak döndürür.
      // Adımlar sırayla çalışır; biri başarısız olursa sonraki adımlar atlanır
      // (kullanıcı hata mesajını görür).
      const iface = msg.interface || 'wg0';
      const address = msg.address || '10.0.0.1/24';
      const listenPort = msg.listenPort || 51820;
      const dns = msg.dns || '1.1.1.1, 8.8.8.8';
      const peerName = msg.peerName || '';
      const peerAllowedIP = msg.peerAllowedIP || '10.0.0.2/32';
      const peerEndpoint = msg.peerEndpoint || '';
      const installWgd = msg.installWgd !== false;
      const wgdPort = msg.wgdPort || 10086;
      const su = msg.useSudo !== false ? 'sudo ' : '';

      // Büyük script: bash heredoc ile tüm adımları tek exec'te çalıştır.
      // Her adım "===STEP===" ile başlayıp "===END===" ile biter, böylece
      // istemci tarafında parse edip adım adım gösterebiliriz.
      const peerSection = peerName ? `
echo "===STEP:6:PEER==="
${su}mkdir -p /etc/wireguard/clients
${su}bash -c "cat > /etc/wireguard/clients/${peerName}.conf" <<EOF
[Interface]
PrivateKey = \$CLIENT_PRIV
Address = ${peerAllowedIP}
DNS = ${dns}

[Peer]
PublicKey = \$SERVER_PUB
PresharedKey = \$CLIENT_PSK
Endpoint = ${peerEndpoint}
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
EOF
${su}wg-quick save ${iface} 2>/dev/null || true
echo "===CLIENT_PRIV==="; echo "\$CLIENT_PRIV"
echo "===CLIENT_PUB==="; echo "\$CLIENT_PUB"
echo "===CLIENT_PSK==="; echo "\$CLIENT_PSK"
echo "===CLIENT_CONF==="
${su}cat /etc/wireguard/clients/${peerName}.conf
echo "===END:6:PEER==="
` : '';

      const wgdSection = installWgd ? `
echo "===STEP:7:WGD==="
WGDPORT=${wgdPort}
WGPORT=${listenPort}
WGDIR=/opt/wgdashboard
# Compose dosyası içeriği
${su}mkdir -p \$WGDIR
COMPOSE_CONTENT=\$(cat <<YAML
services:
  wgdashboard:
    image: ghcr.io/wgdashboard/wgdashboard:latest
    container_name: wgdashboard
    restart: unless-stopped
    hostname: wgdashboard
    ports:
      - "\\\$WGDPORT:10086/tcp"
      - "\\\$WGPORT:51820/udp"
    volumes:
      - /etc/wireguard:/etc/wireguard
      - wg-data:/data
    cap_add:
      - NET_ADMIN
    sysctls:
      - net.ipv4.ip_forward=1
volumes:
  wg-data:
YAML
)
echo "\$COMPOSE_CONTENT" | ${su}tee \$WGDIR/compose.yaml >/dev/null
${su}chmod 644 \$WGDIR/compose.yaml
cd \$WGDIR && ${su}docker compose pull
cd \$WGDIR && ${su}docker compose up -d
sleep 4
echo "===WGD_STATUS==="
cd \$WGDIR && ${su}docker compose ps
echo "===END:7:WGD==="
` : '';

      const script = `bash -lc '
set +e
${su}mkdir -p /etc/wireguard

# === ADIM 1: Ortam algılama ===
echo "===STEP:1:DETECT==="
. /etc/os-release 2>/dev/null
echo "OS: \${ID:-unknown} \${VERSION_ID:-unknown}"
echo "ARCH: \$(uname -m)"
which wg && wg --version || echo "wg-yok"
which wg-quick && wg-quick --version 2>&1 | head -1 || echo "wg-quick-yok"
(command -v apt-get && echo apt || (command -v yum && echo yum || (command -v dnf && echo dnf || (command -v apk && echo apk || (command -v pacman && echo pacman || echo unknown))))) > /tmp/_pkg.txt
echo "PKG: \$(cat /tmp/_pkg.txt)"
(command -v sudo >/dev/null && echo sudo-var || echo sudo-yok)
(command -v systemctl >/dev/null && echo systemd || echo no-systemd)
(command -v docker >/dev/null && echo "docker-var" || echo "docker-yok")
(docker compose version 2>/dev/null && echo "compose-v2-var" || echo "compose-yok")
echo "===END:1:DETECT==="

# === ADIM 2: WireGuard paket kurulumu ===
echo "===STEP:2:INSTALL_PKG==="
PKG=\$(cat /tmp/_pkg.txt)
case "\$PKG" in
  apt)    ${su}apt-get update -y >/dev/null && ${su}apt-get install -y wireguard qrencode iptables ;;
  yum)    ${su}yum install -y epel-release elrepo-release >/dev/null 2>&1; ${su}yum install -y wireguard-tools qrencode iptables-legacy ;;
  dnf)    ${su}dnf install -y wireguard-tools qrencode iptables ;;
  apk)    ${su}apk add --no-cache wireguard-tools qrencode iptables ;;
  pacman) ${su}pacman -Sy --noconfirm wireguard-tools qrencode iptables ;;
  *)      echo "Paket yöneticisi bulunamadı, sadece mevcut wg kullanılacak"; which wg || { echo "HATA: wg de yok"; exit 1; } ;;
esac
which wg && wg --version | head -1
echo "===END:2:INSTALL_PKG==="

# === ADIM 3: Sunucu anahtar çifti + wg0.conf ===
echo "===STEP:3:KEYGEN==="
${su}install -d -m 0700 /etc/wireguard
if [ ! -f /etc/wireguard/server_private.key ]; then
  ${su}bash -c "wg genkey | tee /etc/wireguard/server_private.key | wg pubkey > /etc/wireguard/server_public.key"
  ${su}chmod 600 /etc/wireguard/server_private.key
fi
SERVER_PRIV=\$(${su}cat /etc/wireguard/server_private.key)
SERVER_PUB=\$(${su}cat /etc/wireguard/server_public.key)
echo "SERVER_PUB=\$SERVER_PUB"
# Varsayılan ağ arayüzünü önceden hesapla (NESTED single quote YOK, /proc + grep)
DEFAULT_IF=\$(grep "00000000" /proc/net/route 2>/dev/null | head -1 | cut -f1)
[ -z "\$DEFAULT_IF" ] && DEFAULT_IF=\$(${su}ip route show default 2>/dev/null | head -1 | grep -oE "dev [^ ]+" | grep -oE "[^ ]+\$")
DEFAULT_IF=\${DEFAULT_IF:-eth0}
echo "Arayüz: \$DEFAULT_IF"
${su}bash -lc "cat > /etc/wireguard/${iface}.conf" <<EOF
[Interface]
Address = ${address}
ListenPort = ${listenPort}
PrivateKey = \$SERVER_PRIV
PostUp = ${su}iptables -A FORWARD -i %i -j ACCEPT; ${su}iptables -t nat -A POSTROUTING -o \$DEFAULT_IF -j MASQUERADE
PostDown = ${su}iptables -D FORWARD -i %i -j ACCEPT; ${su}iptables -t nat -D POSTROUTING -o \$DEFAULT_IF -j MASQUERADE
EOF
${su}chmod 600 /etc/wireguard/${iface}.conf
echo "===END:3:KEYGEN==="

# === ADIM 4: IP yönlendirme + NAT ===
echo "===STEP:4:IPFORWARD==="
${su}bash -c "grep -q net.ipv4.ip_forward /etc/sysctl.conf || echo net.ipv4.ip_forward=1 >> /etc/sysctl.conf"
${su}sysctl -w net.ipv4.ip_forward=1
${su}modprobe wireguard 2>/dev/null || true
echo "ip_forward=\$(${su}sysctl -n net.ipv4.ip_forward)"
echo "===END:4:IPFORWARD==="

# === ADIM 5: wg-quick servisi ===
echo "===STEP:5:SERVICE==="
if command -v systemctl >/dev/null; then
  ${su}systemctl enable wg-quick@${iface} >/dev/null 2>&1 || true
  ${su}systemctl restart wg-quick@${iface} || ${su}wg-quick up ${iface}
else
  ${su}wg-quick up ${iface}
fi
sleep 1
${su}wg show ${iface}
echo "===END:5:SERVICE==="

# Peer oluşturma bloğu (eğer peerName verildiyse)
${peerSection}

# WGDashboard bloğu (eğer installWgd true ise)
${wgdSection}

echo "===DONE==="
' 2>&1`;

      // Bu eylem uzun sürebilir; istemciye ilerleme göstergesi için
      // hemen yanıt döndürüp, çıktıyı parça parça gönderebiliriz.
      // Ancak ssh2.exec tek seferde tamamlanır; basit yaklaşım:
      // tüm çıktıyı tek yanıtta döndür, istemci parse etsin.
      conn.exec(script, (err, stream) => {
        if (err) return respond({ type: 'wg-response', id: msg.id, ok: false, action: 'setup-wizard', error: err.message });
        let stdout = '';
        let stderr = '';
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        stream.on('close', (code) => {
          respond({
            type: 'wg-response', id: msg.id, ok: code === 0,
            action: 'setup-wizard',
            data: stdout, stderr, code,
          });
        });
      });
      break;
    }

    default:
      respond({ type: 'wg-response', id: msg.id, ok: false, error: 'Bilinmeyen WireGuard eylemi: ' + msg.action });
  }
}

wss.on('connection', (ws) => {
  let conn = null;
  // AI tool'ları bu ID ile SSH conn'a erişir. WebSocket ID'si kullanılır
  // çünkü her WS bağlantısı tek bir SSH oturumuna karşılık gelir.
  const sshSessionId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      sendJson(ws, { type: 'error', message: 'Geçersiz JSON' });
      return;
    }

    // Frontend bu ID'yi AI tool onayı için kullanır
    if (msg.type === 'hello') {
      sendJson(ws, { type: 'hello-ack', sshSessionId });
      return;
    }

    if (msg.type === 'connect') {
      if (conn) {
        try { conn.end(); } catch {}
      }
      let config;
      try { config = makeSshConfig(msg); }
      catch (e) { sendJson(ws, { type: 'error', message: e.message }); return; }

      sendJson(ws, { type: 'status', status: 'connecting' });
      // Hangi sunucuya, hangi kullanıcıyla, hangi auth tipiyle bağlanmaya
      // çalıştığımızı debug için loglayalım. Parolayı ASLA loglamıyoruz.
      const authMethods = [];
      if (msg.password) authMethods.push('password');
      if (msg.privateKey) authMethods.push('privateKey');
      console.log(`[ssh-connect] host=${msg.host}:${Number(msg.port) || 22} user=${msg.username} auth=${authMethods.join('+') || 'none'} algorithms=${msg.algorithms || 'default'}`);
      conn = new Client();
      conn
        .on('ready', () => {
          console.log(`[ssh-ready] ${msg.username}@${msg.host}:${Number(msg.port) || 22}`);
          // AI tool'ları için bu conn'u kaydet
          sshConns.set(sshSessionId, conn);
          if (msg.mode === 'sftp') handleSftp(ws, conn);
          else handleShell(ws, conn, msg.cols, msg.rows, msg.term);
          // Her bağlantıda kullanıcının sudo'sunu NOPASSWD yap (WebSSH'in exec komutları
          // PTY'siz çalıştığı için sudo parola soramaz — bu yüzden otomatik ayarlıyoruz).
          // İlk seferde sudo parola isterse başarısız olur ama sonraki denemelerde çalışır.
          enableSudoNopasswd(conn, msg.username, (res) => {
            if (res.ok) {
              console.log(`[ssh-sudo] ${msg.username} sudo NOPASSWD aktifleştirildi (${res.method})`);
              sendJson(ws, { type: 'sudo-ready', ok: true, method: res.method });
            } else {
              console.log(`[ssh-sudo] ${msg.username} sudo NOPASSWD ayarlanamadı: ${res.error}`);
              // İlk bağlantıda sudo parola isteyebilir. Frontend'e bildir,
              // kullanıcı terminalde `sudo true` ile parola girip sonra sihirbaza dönsün.
              sendJson(ws, {
                type: 'sudo-ready',
                ok: false,
                error: res.error,
                hint: 'sudo NOPASSWD ayarlanamadı. Terminal sekmesinde `sudo true` yazıp parolanızı girin, sonra sihirbazı yeniden açın.',
              });
            }
          });
        })
        .on('error', (err) => {
          console.log(`[ssh-error] ${msg.username}@${msg.host}:${Number(msg.port) || 22} level=${err.level} code=${err.code || ''} message=${err.message}`);
          sendJson(ws, { type: 'error', message: `${err.message}${err.code ? ' (' + err.code + ')' : ''}` });
        })
        .on('close', () => {
          console.log(`[ssh-close] ${msg.username}@${msg.host}:${Number(msg.port) || 22}`);
          sshConns.delete(sshSessionId);
          sendJson(ws, { type: 'status', status: 'closed' });
        })
        .on('banner', (msgBanner) => {
          console.log(`[ssh-banner] ${msgBanner.trim()}`);
        })
        .on('handshake', (info) => {
          console.log(`[ssh-handshake] ${info.comment || ''} protocol=${info.protoVersion || ''}`);
        });
      try {
        conn.connect(config);
      } catch (e) {
        console.log(`[ssh-connect-throw] ${msg.username}@${msg.host}:${Number(msg.port) || 22} ${e.message}`);
        sendJson(ws, { type: 'error', message: 'SSH bağlantısı başlatılamadı: ' + e.message });
      }
    } else if (msg.type === 'disconnect') {
      if (conn) {
        try { conn.end(); } catch {}
        conn = null;
      }
      sendJson(ws, { type: 'status', status: 'disconnected' });
    }
  });

  ws.on('close', () => {
    sshConns.delete(sshSessionId);
    if (conn) {
      try { conn.end(); } catch {}
    }
  });
});

// ============================================================================
// OpenRouter AI Asistan — SSH yönetim tool'ları
// ============================================================================
// AI modeli sadece metin döndürmez, aşağıdaki tool'ları çağırabilir.
// Her tool çağrısı frontend'e SSE ile bildirilir; kullanıcı onaylayana kadar
// çalıştırılmaz. Onaylanan tool'lar SSH üzerinden uzak sunucuda çalıştırılır.
// ============================================================================

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

// Tool tanımları — OpenRouter/OpenAI tool-calling formatında
const AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Uzak SSH sunucusunda bir shell komutu çalıştırır. Sudo kullanmaz (güvenlik için). Çıktı (stdout+stderr) ve exit code döner.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Çalıştırılacak tek satır komut' },
          reason: { type: 'string', description: 'Bu komutu neden çalıştırmak istediğinin kısa açıklaması (kullanıcıya gösterilir)' },
        },
        required: ['command', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Uzak sunucuda bir dosyanın içeriğini okur (maks 64 KB).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Dosya yolu' },
          reason: { type: 'string' },
        },
        required: ['path', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'Uzak sunucuda bir dizinin içeriğini listeler.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Dizin yolu (varsayılan: /etc/wireguard)' },
          reason: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wg_status',
      description: 'WireGuard arayüzünün durumunu, peer listesini ve son handshake\'leri getirir.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wg_add_peer',
      description: 'Yeni bir WireGuard peer ekler. Sunucuya peer\'ı ekler, istemci anahtar çifti + PSK üretir, .conf dosyasını oluşturur.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Peer adı (dosya adında kullanılır)' },
          allowed_ip: { type: 'string', description: 'İstemcinin VPN IP\'si (örn: 10.0.0.2/32)' },
          reason: { type: 'string' },
        },
        required: ['name', 'allowed_ip', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wg_remove_peer',
      description: 'Var olan bir WireGuard peer\'ını kaldırır.',
      parameters: {
        type: 'object',
        properties: {
          public_key: { type: 'string', description: 'Kaldırılacak peer\'ın public key\'i' },
          name: { type: 'string', description: 'Peer adı (client .conf dosyasını da siler)' },
          reason: { type: 'string' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'service_status',
      description: 'Bir systemd servisinin durumunu kontrol eder.',
      parameters: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Servis adı (örn: ssh, wg-quick@wg0, docker)' },
          reason: { type: 'string' },
        },
        required: ['service', 'reason'],
      },
    },
  },
];

const AI_SYSTEM_PROMPT = `Sen WebSSH adlı web tabanlı SSH istemcisinde gömülü bir **SSH yönetici asistanısın**.
Kullanıcının bağlı olduğu uzak sunucuyu tool'lar aracılığıyla doğrudan yönetebilirsin.

Çalışma prensibi:
1. Kullanıcı bir istekte bulunur (örn. "WireGuard çalışıyor mu?", "Apache'yi yeniden başlat").
2. Uygun tool'u çağırırsın (run_command, wg_status, service_status, vb.).
3. Kullanıcı tool çağrısını onaylar veya reddeder.
4. Onaylanırsa sonuç sana döner; sonucu yorumla, sonraki adımı öner veya kullanıcının isteğini yerine getir.

Kurallar:
- **Tehlikeli komutları** (rm -rf /, dd if=/dev/zero of=/dev/sda, mkfs, üretim verisini yok eden komutlar, iptables -F, fork bombalar) ASLA önerme. Bunun yerine güvenli alternatifler öner ve kullanıcıya açıkla.
- **Her tool çağrısında** "reason" alanına, kullanıcının anlayacağı kısa bir açıklama yaz (Türkçe).
- Çıktıları yorumlarken kök nedeni bulmaya çalış, sadece "hata var" deme.
- Birden fazla adım gerekiyorsa, **adım adım ilerle** ve her adımı ayrı tool çağrısıyla yap.
- Kullanıcı belirsiz bir istekte bulunursa, ne yapmak istediğini sor.
- Cevap dili: kullanıcının soru dili (varsayılan Türkçe).
- Kısa ve net ol. Çok uzun açıklamalar yerine doğrudan eyleme geç.`;

// Aktif chat oturumları — her WS bağlantısı için bir tane
// Map<sessionId, { messages: [...], conn: ssh2.Client|null }>
const aiSessions = new Map();
let aiSessionCounter = 1;

function newAiSessionId() {
  return `ai-${Date.now()}-${aiSessionCounter++}`;
}

// Yardımcı: tool adını çalıştırıp sonucu döndürür (senkron, sonucu bekler)
function executeAiTool(conn, toolName, args) {
  return new Promise((resolve) => {
    // Tehlikeli komut engelleme — run_command için
    if (toolName === 'run_command') {
      const dangerous = [
        /\brm\s+-rf?\s+\/\s*$/,           // rm -rf /
        /\bdd\s+.*of=\/dev\/(sd|nvme|hd)/,
        /\bmkfs(\.\w+)?\s+\/dev\//,
        /\biptables\s+-F\b/,
        /:\(\)\s*\{.*:\|:&.*\}\s*;/,      // fork bomb
        /\bcurl\s+.*\|\s*(ba)?sh\b/,      // curl|sh
      ];
      for (const re of dangerous) {
        if (re.test(args.command)) {
          resolve({ ok: false, error: 'Güvenlik: tehlikeli komut engellendi. Farklı bir yaklaşım önerin.', blocked: true });
          return;
        }
      }
    }

    let cmd = '';
    switch (toolName) {
      case 'run_command':
        cmd = args.command;
        break;
      case 'read_file': {
        const safe = (args.path || '').replace(/'/g, "'\\''");
        cmd = `test -f '${safe}' && cat '${safe}' || echo "DOSYA_YOK: ${safe}"`;
        break;
      }
      case 'list_directory': {
        const p = (args.path || '/etc/wireguard').replace(/'/g, "'\\''");
        cmd = `ls -la '${p}' 2>&1`;
        break;
      }
      case 'wg_status':
        cmd = `sudo -n wg show 2>&1 || wg show 2>&1 || echo "WG_YOK"`;
        break;
      case 'wg_add_peer': {
        const name = (args.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const allowedIP = args.allowed_ip || '10.0.0.2/32';
        if (!name) { resolve({ ok: false, error: 'Geçerli bir peer adı gerekli' }); return; }
        cmd = `bash -lc '
set -e
sudo -n install -d -m 0700 /etc/wireguard 2>/dev/null || install -d -m 0700 /etc/wireguard
CLIENT_PRIV=\$(wg genkey)
CLIENT_PSK=\$(wg genpsk)
CLIENT_PUB=\$(echo "\$CLIENT_PRIV" | wg pubkey)
SERVER_PUB=\$(sudo -n cat /etc/wireguard/server_public.key 2>/dev/null || cat /etc/wireguard/server_public.key)
sudo -n wg set wg0 peer "\$CLIENT_PUB" allowed-ip ${allowedIP} persistent-keepalive 25 2>/dev/null || wg set wg0 peer "\$CLIENT_PUB" allowed-ip ${allowedIP} persistent-keepalive 25
sudo -n mkdir -p /etc/wireguard/clients 2>/dev/null || mkdir -p /etc/wireguard/clients
sudo -n bash -c "cat > /etc/wireguard/clients/${name}.conf" <<EOF
[Interface]
PrivateKey = \$CLIENT_PRIV
Address = ${allowedIP}
DNS = 1.1.1.1

[Peer]
PublicKey = \$SERVER_PUB
PresharedKey = \$CLIENT_PSK
Endpoint = \\$(hostname -I | awk "{print \\\$1}"):51820
AllowedIPs = 0.0.0.0/0, ::/0
PersistentKeepalive = 25
EOF
sudo -n wg-quick save wg0 2>/dev/null || wg-quick save wg0 2>/dev/null || true
echo "===CLIENT_CONF==="
cat /etc/wireguard/clients/${name}.conf
echo "===END==="
'`;
        break;
      }
      case 'wg_remove_peer': {
        const pk = (args.public_key || '').replace(/[^A-Za-z0-9+/=]/g, '');
        const name = (args.name || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!pk && !name) { resolve({ ok: false, error: 'public_key veya name gerekli' }); return; }
        if (pk) {
          cmd = `sudo -n wg set wg0 peer ${pk} remove 2>&1 || wg set wg0 peer ${pk} remove 2>&1`;
        }
        if (name) {
          cmd += `; sudo -n rm -f /etc/wireguard/clients/${name}.conf 2>/dev/null || rm -f /etc/wireguard/clients/${name}.conf`;
        }
        cmd += `; echo OK`;
        break;
      }
      case 'service_status': {
        const svc = (args.service || '').replace(/[^a-zA-Z0-9_@.-]/g, '');
        if (!svc) { resolve({ ok: false, error: 'Servis adı gerekli' }); return; }
        cmd = `(systemctl status ${svc} --no-pager -l 2>&1 || service ${svc} status 2>&1) | head -30`;
        break;
      }
      default:
        resolve({ ok: false, error: `Bilinmeyen tool: ${toolName}` });
        return;
    }

    conn.exec(cmd, (err, stream) => {
      if (err) { resolve({ ok: false, error: err.message }); return; }
      let stdout = '';
      let stderr = '';
      stream.on('data', (d) => { stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
      stream.on('close', (code) => {
        resolve({ ok: code === 0, code, stdout: stdout.slice(0, 32768), stderr: stderr.slice(0, 4096) });
      });
    });
  });
}

// Tek tool çağrısı için OpenRouter'a "tool çağrısını onayla/reddet" akışı
app.post('/api/chat', express.json({ limit: '256kb' }), async (req, res) => {
  try {
    const { messages, model, apiKey, sessionId: incomingSessionId } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages dizisi gerekli' });
    }
    if (!apiKey || typeof apiKey !== 'string' || apiKey.length < 10) {
      return res.status(401).json({ error: 'Geçerli bir OpenRouter API anahtarı gerekli (sk-or-...)' });
    }

    const useModel = (typeof model === 'string' && model.length > 0)
      ? model
      : 'meta-llama/llama-3.3-70b-instruct:free';

    const sessionId = incomingSessionId || newAiSessionId();
    const session = aiSessions.get(sessionId) || { messages: [], conn: null };

    // Yeni kullanıcı mesajlarını session'a ekle (tool sonuçları dahil)
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      // OpenAI tool formatındaki mesajları kabul et: role tool, content string, tool_call_id
      if (['user', 'assistant', 'tool', 'system'].includes(m.role) && m.content !== undefined) {
        session.messages.push(m);
      }
    }
    aiSessions.set(sessionId, session);

    // SSE başlat
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Ai-Session', sessionId);
    res.flushHeaders?.();

    // Mesaj sayısını sınırla (token patlamasını önle)
    const trimmed = session.messages.slice(-30);
    const fullMessages = [{ role: 'system', content: AI_SYSTEM_PROMPT }, ...trimmed];

    const callOpenRouter = async () => {
      const upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/ferhatdeveloper/ssh',
          'X-Title': 'WebSSH Assistant',
        },
        body: JSON.stringify({
          model: useModel,
          messages: fullMessages,
          tools: AI_TOOLS,
          tool_choice: 'auto',
          stream: true,
          temperature: 0.3,
          max_tokens: 1024,
        }),
      });
      return upstream;
    };

    let upstream;
    try {
      upstream = await callOpenRouter();
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: 'OpenRouter bağlantı hatası: ' + e.message })}\n\n`);
      res.end();
      return;
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      res.write(`data: ${JSON.stringify({ error: `OpenRouter ${upstream.status}: ${errText.slice(0, 200)}` })}\n\n`);
      res.end();
      return;
    }

    // Streaming parse — hem content delta hem tool_calls delta topla
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    // Toplanan tool çağrıları (streaming tool_calls delta'ları birikerek tam tool_call oluşturur)
    const collectedToolCalls = []; // [{ id, name, arguments }]
    let assistantContent = '';

    const emitToolCalls = () => {
      // Frontend'e SSE ile bildir — kullanıcı onaylayacak
      // Boş/sparse tool_call elemanlarını atla (streaming'de bazı delta'lar boş olabilir).
      // id yoksa geçici olarak otomatik üret (OpenAI tool_call_id zorunlu).
      let autoIdx = 0;
      for (const tc of collectedToolCalls) {
        if (!tc || !tc.name) continue;
        if (!tc.id) tc.id = `auto_${Date.now()}_${autoIdx++}`;
        let args = {};
        try { args = tc.arguments ? JSON.parse(tc.arguments) : {}; } catch { args = { _raw: tc.arguments }; }
        res.write(`data: ${JSON.stringify({
          type: 'tool_call',
          tool: tc.name,
          args,
          toolCallId: tc.id,
        })}\n\n`);
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine.startsWith('data:')) continue;
          const payload = trimmedLine.slice(5).trim();
          if (payload === '[DONE]') continue;
          let obj;
          try { obj = JSON.parse(payload); } catch { continue; }
          const choice = obj.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta || {};

          // Metin içeriği
          if (delta.content) {
            assistantContent += delta.content;
            res.write(`data: ${JSON.stringify({ delta: delta.content })}\n\n`);
          }

          // Tool call delta'ları
          if (Array.isArray(delta.tool_calls)) {
            for (const tcd of delta.tool_calls) {
              const idx = tcd.index ?? collectedToolCalls.length;
              if (!collectedToolCalls[idx]) {
                collectedToolCalls[idx] = { id: '', name: '', arguments: '' };
              }
              if (tcd.id) collectedToolCalls[idx].id = tcd.id;
              if (tcd.function?.name) collectedToolCalls[idx].name = tcd.function.name;
              if (tcd.function?.arguments) collectedToolCalls[idx].arguments += tcd.function.arguments;
            }
          }

          // Stream tamamlandı (finish_reason)
          if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
            // Tüm tool call delta'ları toplandı, frontend'e bildir
            emitToolCalls();
            // Session'a assistant mesajını ekle (OpenAI tool format)
            const assistantMsg = {
              role: 'assistant',
              content: assistantContent || null,
            };
            if (collectedToolCalls.length > 0) {
              assistantMsg.tool_calls = collectedToolCalls.map(tc => ({
                id: tc.id, type: 'function',
                function: { name: tc.name, arguments: tc.arguments || '{}' },
              }));
            }
            session.messages.push(assistantMsg);
            aiSessions.set(sessionId, session);
          }
        }
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: 'Stream parse hatası: ' + e.message })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (e) {
    try {
      res.write(`data: ${JSON.stringify({ error: e.message || 'bilinmeyen hata' })}\n\n`);
      res.end();
    } catch { /* res zaten kapalı olabilir */ }
  }
});

// Tool onay/red endpoint'i — frontend onayladıktan sonra çalıştırılır
// Body: { sessionId, toolCallId, tool, args, approved, sshSessionId }
// sshSessionId: Hangi SSH bağlantısı üzerinde çalıştırılacak (WS'ten gelen)
const sshConns = new Map(); // wsId → ssh2.Client

app.post('/api/tool/approve', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const { sessionId, toolCallId, tool, args, approved, sshSessionId } = req.body || {};
    if (!sessionId || !toolCallId || !tool) return res.status(400).json({ error: 'sessionId, toolCallId, tool gerekli' });

    const session = aiSessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'AI oturumu bulunamadı' });

    if (!approved) {
      // Reddedildi → AI'a bildirim olarak tool sonucu ekle
      session.messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: 'Kullanıcı bu işlemi reddetti. Farklı bir yaklaşım önerin veya açıklama yapın.',
      });
      aiSessions.set(sessionId, session);
      return res.json({ ok: true, rejected: true });
    }

    const conn = sshConns.get(sshSessionId);
    if (!conn) {
      return res.status(503).json({ error: 'SSH bağlantısı bulunamadı. WebSSH\'te aktif bir bağlantı olmalı.' });
    }

    const result = await executeAiTool(conn, tool, args || {});

    // Sonucu tool mesajı olarak session'a ekle
    const toolContent = result.ok
      ? (result.stdout || '(başarılı, çıktı yok)')
      : `HATA: ${result.error || 'bilinmiyor'}\n${result.stderr || ''}\n${result.stdout || ''}`;
    session.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: toolContent.slice(0, 16000),
    });
    aiSessions.set(sessionId, session);

    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// SSH bağlantısı kayıt (WebSocket açılırken çağrılır, AI tool'ları için)
app.post('/api/ssh/register', express.json(), (req, res) => {
  const { sshSessionId } = req.body || {};
  const conn = sshConns.get(sshSessionId);
  res.json({ ok: !!conn });
});

// NOT: /api/models endpoint'i kaldırıldı.
// Model listesi client tarafından (public/app.js) DOĞRUDAN OpenRouter'dan çekiliyor.
// OpenRouter CORS açık olduğu için bu yaklaşım reverse proxy
// sorunlarından bağımsız çalışır.

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WebSSH hazır: http://localhost:${PORT}`);
});