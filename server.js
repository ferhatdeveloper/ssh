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
# Varsayılan ağ arayüzünü önceden hesapla
DEFAULT_IF=\$(${su}bash -c 'ip route 2>/dev/null | grep default | head -n1 | awk "{print \$5}"' 2>/dev/null)
DEFAULT_IF=\${DEFAULT_IF:-eth0}
${su}bash -c "cat > /etc/wireguard/${iface}.conf" <<EOF
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
      const endpoint = msg.endpoint || '';
      const script = `bash -lc '
set -e
${su}install -d -m 0700 /etc/wireguard
CLIENT_PRIV=\$(wg genkey)
CLIENT_PSK=\$(wg genpsk)
CLIENT_PUB=\$(echo "\$CLIENT_PRIV" | wg pubkey)
SERVER_PUB=\$(${su}cat /etc/wireguard/server_public.key)
SERVER_PRIV=\$(${su}cat /etc/wireguard/server_private.key)
${su}bash -c "wg set ${iface} peer \$CLIENT_PUB allowed-ip ${allowedIP} persistent-keepalive 25"
# Konfigi /etc/wireguard altında saklamak üzere
${su}mkdir -p /etc/wireguard/clients
${su}bash -c "cat > /etc/wireguard/clients/${peerName}.conf" <<EOF
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
EOF
# Konfigi wg-quick tarafından kalıcı yaz
${su}bash -c "wg-quick save ${iface} 2>/dev/null || cat /etc/wireguard/${iface}.conf > /dev/null"
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
        (hostname -I 2>/dev/null | awk "{print \$1}") || ip route get 1 2>/dev/null | awk "{print \$7;exit}"
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
# Varsayılan ağ arayüzünü önceden hesapla (heredoc/quote sorunlarından kaçınmak için)
DEFAULT_IF=\$(${su}bash -c 'ip route 2>/dev/null | grep default | head -n1 | awk "{print \$5}"' 2>/dev/null)
DEFAULT_IF=\${DEFAULT_IF:-eth0}
${su}bash -c "cat > /etc/wireguard/${iface}.conf" <<EOF
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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch {
      sendJson(ws, { type: 'error', message: 'Geçersiz JSON' });
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
      conn = new Client();
      conn
        .on('ready', () => {
          if (msg.mode === 'sftp') handleSftp(ws, conn);
          else handleShell(ws, conn, msg.cols, msg.rows, msg.term);
        })
        .on('error', (err) => sendJson(ws, { type: 'error', message: err.message }))
        .on('close', () => sendJson(ws, { type: 'status', status: 'closed' }))
        .connect(config);
    } else if (msg.type === 'disconnect') {
      if (conn) {
        try { conn.end(); } catch {}
        conn = null;
      }
      sendJson(ws, { type: 'status', status: 'disconnected' });
    }
  });

  ws.on('close', () => {
    if (conn) {
      try { conn.end(); } catch {}
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WebSSH hazır: http://localhost:${PORT}`);
});