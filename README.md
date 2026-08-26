# WebSSH — PuTTY tarzı web tabanlı SSH + SFTP + WireGuard + WGDashboard terminali

Tarayıcıdan, kurulum gerektirmeden çalışan tam işlevli bir SSH istemcisi. PuTTY'nin temel özelliklerinin tamamını (terminal oturumu, özel anahtar ile kimlik doğrulama, bağlantı kaydetme), ek olarak **SFTP dosya yöneticisini**, **WireGuard yönetim panelini** ve **WGDashboard entegrasyonunu** tek bir arayüzde sunar.

![Mimari](https://img.shields.io/badge/stack-Node.js%20%2B%20ssh2%20%2B%20xterm.js%20%2B%20WGDashboard-4ea8de)

## Özellikler

- **Gerçek SSH oturumu**: `ssh2` istemcisi ile PTY shell, otomatik yeniden boyutlandırma.
- **Caddy ile otomatik HTTPS**: Let's Encrypt/ZeroSSL sertifikalarını Caddy otomatik alır/yeniler; WebSSH ve WGDashboard tek bir 443 portu üzerinden HTTPS ile yayınlanır, `/ws` ve `/socket.io` WebSocket yolları otomatik upgrade edilir.
- **xterm.js tabanlı terminal**: 256 renk, web linkleri, fare seçimi, kopyala/yapıştır.
- **Kimlik doğrulama**: Parola veya PEM/OpenSSH özel anahtar (parolalı anahtar desteği dahil).
- **SFTP dosya yöneticisi**: Dizin listeleme, klasör oluşturma/silme, dosya yükleme/önizleme/indirme, yeniden adlandırma.
- **WireGuard yönetim paneli**:
  - **Tek tıkla kurulum**: OS algılama, paket yükleme, sunucu anahtar çifti üretimi, `/etc/wireguard/wg0.conf` yazımı, systemd servisi başlatma.
  - **Peer yönetimi**: Ekle/sil, otomatik anahtar üretimi, PSK, kalıcı yapılandırma.
  - **QR kodu**: Peer eklendikten sonra istemci yapılandırması için QR kodu otomatik oluşturulur (telefondan tarama).
  - **Konfigürasyon indirme**: `.conf` dosyası olarak dışa aktarma.
  - **Durum paneli**: Aktif peer'lar, son handshake, RX/TX trafiği.
- **WGDashboard entegrasyonu** (yeni):
  - Tek tıkla Docker Compose ile kurulum (uzak sunucuda `ghcr.io/wgdashboard/wgdashboard:latest` imajı çalıştırılır).
  - **Paylaşılan yapılandırma**: WebSSH ve WGDashboard aynı `/etc/wireguard` klasörünü kullanır; peer'lar senkronize kalır.
  - **MFA/2FA**: WGDashboard'un kendi kullanıcı yönetimi ve TOTP 2FA desteği etkindir.
  - **Kapsamlı yönetim**: Çoklu kullanıcı desteği, MFA, zamanlanmış görevler, peer kısıtlama gibi WGDashboard özellikleri.
  - **Hızlı erişim**: WireGuard panelinden tek tıkla "WGDashboard'u Aç" bağlantısı.
  - **Durum ve loglar**: Container durumu, son log satırları, port bilgisi.
- **A'dan Z'ye Kurulum Sihirbazı**: WireGuard panelindeki tek tıkla kurulum sihirbazı, sıfır sunucudan (algılama → WG kurulumu → keygen → IP forward → servis → ilk peer → WGDashboard) tüm adımları orkestre eder, ilerleme UI'ı ile adım adım gösterir, sonuçta sunucu public key + ilk peer `.conf` + QR kod + erişim linklerini tek ekranda verir.
- **AI Asistan (OpenRouter)**: Sağ alttaki 💬 chat balonu, SSH oturumunuzda **doğrudan komut çalıştırabilen** bir LLM asistanı. OpenRouter üzerinden ücretsiz modellerle çalışır. Kullanıcı her tool çağrısını onaylar — AI keyfi komut çalıştırmaz.
- **Kayıtlı oturumlar**: Sık kullanılan sunucular tarayıcıda saklanır (localStorage), tek tıkla yükleme/bağlanma.
- **Gelişmiş ayarlar**: Terminal türü, algoritma geçersiz kılma (eski sunucular için).
- **Durum bildirimi**: Bağlantı durumu, hata mesajları, alt durum çubuğu.
- **Sıfır bağımlılık dışı**: Saf Node.js + tarayıcı; Alpine container'a sığar.

### AI Asistan (OpenRouter ile SSH yönetimi)

Sağ alttaki 💬 chat balonu, SSH bağlantınız üzerinden **doğrudan komut çalıştırabilen** bir LLM asistanıdır. "WireGuard peer listesi göster", "Apache'yi yeniden başlat", "loglardaki hatayı analiz et" gibi istekleri doğal dilde yazarsınız; AI uygun komutu SSH üzerinden çalıştırır, çıktıyı yorumlar ve gerektiğinde takip adımlarını önerir.

#### Kurulum

1. [openrouter.ai/keys](https://openrouter.ai/keys) adresinden **ücretsiz** bir API anahtarı alın (Google hesabıyla giriş yeterli, kredi kartı gerekmez).
2. WebSSH'e giriş yapın, sağ alttaki 💬 balonuna tıklayın.
3. ⚙ ayar düğmesinden API anahtarınızı girin ve model seçin.
4. "Ayarları Kaydet" — anahtar `sessionStorage`'da saklanır, sunucuya **hiçbir zaman** gönderilmez (sadece ilgili isteklerde backend'e iletilir, backend onu OpenRouter'a taşır).

#### Nasıl çalışır

```
┌─────────────┐     SSE      ┌──────────────┐     HTTPS    ┌──────────────┐
│ Tarayıcı    │ ────────────►│ WebSSH       │ ────────────►│ OpenRouter   │
│ (chat balonu│ ◄────────────│ backend      │ ◄────────────│ (LLM)        │
│  + onay UI) │   tool_call  │ /api/chat    │   tool_call  └──────────────┘
└─────────────┘               │ /api/tool/   │
                               │   approve    │
                               └──────┬───────┘
                                      │ SSH exec
                                      ▼
                               ┌──────────────┐
                               │ Uzak sunucu  │
                               │ (komut çalışır│
                               │  sonuç döner)│
                               └──────────────┘
```

1. Kullanıcı isteği chat'e yazar → backend `/api/chat` üzerinden OpenRouter'a iletir.
2. LLM, kullanabildiği **önceden tanımlı tool'lar** arasından uygun olanı seçer ve bir **tool_call** döner.
3. Backend, tool_call'ı SSE üzerinden frontend'e bildirir.
4. Frontend bir **onay kartı** gösterir (komut, açıklama, Onayla/Reddet düğmeleri).
5. Kullanıcı onaylarsa backend `/api/tool/approve` ile SSH bağlantısı üzerinden komutu çalıştırır.
6. Sonuç tool_result olarak AI'a geri döner; AI sonucu yorumlar ve bir sonraki adımı önerir.

#### AI'ın kullanabildiği tool'lar

| Tool | Açıklama |
|------|----------|
| `run_command` | Herhangi bir SSH komutu (tehlikeli komutlar backend tarafından engellenir: `rm -rf /`, `dd`, `mkfs`, `iptables -F`, fork bomb, `curl | sh`) |
| `read_file` | Dosya içeriği okuma (64 KB'a kadar) |
| `list_directory` | Dizin listeleme |
| `wg_status` | WireGuard arayüz durumu, peer listesi, handshakes |
| `wg_add_peer` | Yeni WireGuard peer ekleme + istemci .conf üretimi |
| `wg_remove_peer` | Peer kaldırma |
| `service_status` | systemd servisi durumu |

#### Güvenlik modeli

- **API anahtarı sadece sizin** — sunucu tarafında loglanmaz, başka kullanıcılarla paylaşılmaz.
- **Her tool çağrısı onay gerektirir** — AI asla otomatik komut çalıştırmaz.
- **Tehlikeli komutlar backend'de engellenir** (kara liste yukarıdaki tool açıklamasında).
- **SSH bağlantısı aktif olmalı** — AI, WebSSH'in o anda bağlı olduğu SSH oturumunu kullanır; ayrı bir bağlantı açmaz.
- **Oturum context'i sunucuda tutulur** — backend `Map<sessionId, messages>` ile konuşma geçmişini saklar, frontend her istekte sadece `sessionId`'yi gönderir.
- **Session 30 mesajla sınırlı** — token patlamasını önler.

#### Örnek diyalog

> **Sen**: wg durumunu göster, eğer peer yoksa bir tane ekle
>
> **AI**: WireGuard durumunu kontrol ediyorum...
> *(tool_call: wg_status)*
> **AI**: Şu anda hiç peer yok. Hangi isimle ve izinli IP ile ekleyeyim? "10.0.0.2/32" uygun mu?
>
> **Sen**: evet, telefon için
>
> **AI**: Tamam, ekliyorum...
> *(tool_call: wg_add_peer, name="telefon", allowed_ip="10.0.0.2/32")*
> **AI**: Peer eklendi. .conf dosyası:
> ```ini
> [Interface]
> PrivateKey = ...
> ...
> ```
> Telefonunuza WireGuard uygulamasını kurup bu yapılandırmayı içe aktarabilirsiniz.

#### Başlangıç önerileri

- **Ücretsiz modeller** başlangıç için yeterli (Llama 3.3 70B, Qwen 2.5 72B, vb.). Karmaşık çok adımlı görevler için ücretli bir model (Claude Sonnet, GPT-4o) daha doğru sonuç verir.
- **Bağlam ekleme**: Chat balonunun üstündeki "Son terminal çıktısını ekle" checkbox'ı işaretlenirse, AI'a terminaldeki son 30 satır otomatik olarak eklenir — hata analizi için çok faydalı.
- **SSH bağlı değilken**: AI sadece sohbet modunda çalışır (komut önerir, çalıştırmaz). Tool çağrısı gelirse UI uyarı gösterir.


## Mimari

```
┌──────────────┐    WebSocket     ┌──────────────┐     SSH/SFTP    ┌──────────────┐
│   Tarayıcı   │  ◄────────────►  │  Node.js     │  ◄────────────► │   Uzak Sun.  │
│  xterm.js +  │   /ws yolunda    │   sunucu     │   ssh2 istemci  │  OpenSSH /   │
│  SFTP paneli │   JSON mesajları │  (server.js) │   PTY + SFTP    │   herhangi   │
└──────────────┘                  └──────────────┘                  └──────────────┘
```

- `server.js`: Express + WebSocket sunucusu. Her bağlantı için bir `ssh2.Client` örneği açar.
- `public/index.html` + `app.js` + `styles.css`: Tarayıcı arayüzü (xterm.js, fit-addon, web-links-addon CDN üzerinden).

## Kurulum

İki ana yol:

**1) Ubuntu'ya tek komutla (önerilen):** aşağıdaki "Çalıştırma" bölümüne bakın — `sudo ./install.sh` her şeyi kurar.

**2) Manuel:** Node 18+ gerekir (Node 20/22/24 önerilir):

```bash
npm install
```

## Çalıştırma

Üç seçenek mevcut. Tüm seçeneklerde WireGuard yönetim paneli ve WGDashboard entegrasyonu kullanılabilir.

### Seçenek 1: Ubuntu'ya tek komutla kurulum (önerilen, Docker tabanlı)

Ubuntu 22.04+, Debian 12+, RHEL/Fedora/Rocky/Alma 9+ üzerinde tek komutla her şey kurulur (Docker, Compose, WireGuard modülü, portlar, servisler, **Caddy ile otomatik TLS**):

```bash
git clone https://github.com/ferhatdeveloper/ssh.git webssh && cd webssh

# HTTPS için: DNS'te bu sunucuya yönlendirilmiş iki alan adı hazırlayın, sonra:
cp .env.example .env
$EDITOR .env                      # WEBSSH_DOMAIN ve WGD_DOMAIN'i ayarla

sudo ./install.sh
```

**DNS hazırlığı**: `WEBSSH_DOMAIN` ve `WGD_DOMAIN` olarak ayarladığınız alan adlarının her ikisi de bu sunucunun public IPv4 adresine `A` kaydı ile yönlendirilmiş olmalıdır. Caddy başlatıldığında Let's Encrypt/ZeroSSL'den otomatik sertifika alır (genelde 30-60 saniye).

**DNS hazır değilse** (sadece test): `.env` oluşturmayın — kurulum HTTP modunda başlar, doğrudan portlardan erişilir.

Kurulum sonunda:

```
Erişim URL'leri:
  WebSSH       → http://<sunucu-ip>:3000
  WGDashboard  → http://<sunucu-ip>:10086
  WireGuard    → UDP <sunucu-ip>:51820
```

#### Açılması gereken portlar

Tüm bileşenlerin düzgün çalışabilmesi için sunucunun güvenlik duvarında aşağıdaki portlar açık olmalıdır:

| Port | Protokol | Servis | Yön | Açıklama |
|------|----------|--------|-----|----------|
| **22** | TCP | SSH | inbound | Hedef sunucuya ilk bağlantı için (WebSSH kendisi SSH üzerinden çalışır) |
| **80** | TCP | Caddy HTTP | inbound | HTTP→HTTPS yönlendirmesi + ACME sertifika doğrulaması. HTTPS modunda zorunlu. |
| **443** | TCP | Caddy HTTPS | inbound | TLS terminasyonu, reverse proxy. WebSSH + WGDashboard tek port üzerinden. |
| **3000** | TCP | WebSSH (doğrudan) | inbound | Caddy kullanılmadığında veya acil durum erişimi için. `WEBSSH_PORT` env değişkeniyle değiştirilebilir. |
| **10086** | TCP | WGDashboard (doğrudan) | inbound | Caddy kullanılmadığında. Sihirbaz/WGDashboard panelinden değiştirilebilir. |
| **51820** | UDP | WireGuard | inbound | VPN trafiği (istemciler → sunucu). Caddy UDP yönlendirmez, doğrudan host'a açıktır. Sihirbazdan değiştirilebilir. |

**`install.sh` zaten otomatik olarak `80/tcp`, `443/tcp`, `3000/tcp`, `10086/tcp` ve `51820/udp` için UFW kuralları ekler.** Manuel kurulumda (Docker Compose veya `npm start`) aşağıdaki komutlarla açabilirsiniz:

```bash
# UFW (Ubuntu/Debian) — HTTPS modu
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp   443/tcp
sudo ufw allow 3000/tcp 10086/tcp   # doğrudan erişim için (opsiyonel)
sudo ufw allow 51820/udp
sudo ufw reload

# firewalld (RHEL/Fedora/Rocky)
sudo firewall-cmd --permanent --add-port={22,80,443,3000,10086}/tcp --add-port=51820/udp
sudo firewall-cmd --reload

# iptables (jenerik)
sudo iptables -A INPUT -p tcp --dport 22    -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 80    -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 443   -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 3000  -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 10086 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 51820 -j ACCEPT
```

> 💡 **Cloud güvenlik duvarları**: AWS Security Group, GCP Firewall, Azure NSG, Hetzner Firewall gibi cloud sağlayıcılarında yukarıdaki portları **ayrıca** açmanız gerekir (sunucu içi UFW yeterli değildir). 22 numaralı portu dışarıya kapatıp yalnızca **WireGuard tüneli (51820/udp) + WebSSH (3000/tcp)** üzerinden erişim sağlamak, yüzey alanını daraltmak için önerilen bir kalıptır.

Script:
- Docker + Compose v2 yoksa otomatik kurar (apt/dnf/pacman).
- WireGuard kernel modülünü yükler (`modprobe wireguard`).
- IP yönlendirmeyi kalıcı olarak etkinleştirir (`/etc/sysctl.conf`).
- UFW varsa 3000, 10086 (TCP) ve 51820 (UDP) portlarını açar.
- `wg-conf/` ve `wg-data/` dizinlerini oluşturur, `docker compose up -d` ile servisleri başlatır.
- Son durumu ve erişim URL'lerini gösterir.

### Seçenek 2: WebSSH + WGDashboard + Caddy (mevcut Docker üzerinde)

```bash
# .env'i alan adlarınızla doldurun (HTTPS için) veya boş bırakın (HTTP için)
cp .env.example .env && $EDITOR .env

# Tüm servisler ayağa kalkar: WebSSH + WGDashboard + Caddy (otomatik TLS)
# /etc/wireguard dizini iki servis tarafından paylaşılır
docker compose up -d --build
```

**HTTPS modu** (alan adı `.env`'de ayarlıyken):
- WebSSH       → `https://ssh.example.com`  (Let's Encrypt otomatik sertifika)
- WGDashboard  → `https://wgd.example.com`
- WireGuard    → `UDP <sunucu-ip>:51820`    (Caddy UDP yönlendirmez, doğrudan host)

**HTTP modu** (alan adı ayarlanmamışken):
- WebSSH       → `http://<sunucu-ip>:3000`
- WGDashboard  → `http://<sunucu-ip>:10086`
- WireGuard    → `UDP <sunucu-ip>:51820`

WGDashboard ilk açılışta kullanıcı oluşturma sihirbazını gösterir.

**Linux'ta ek adımlar (root/sudo ile bir kez):**

```bash
# WireGuard kernel modülü (çoğu modern çekirdekte gömülü, ancak emin olalım)
modprobe wireguard
echo "wireguard" | sudo tee /etc/modules-load.d/wireguard.conf

# IP yönlendirme
echo "net.ipv4.ip_forward=1" | sudo tee -a /etc/sysctl.conf
sudo sysctl -w net.ipv4.ip_forward=1

# HTTPS modu için Caddy portları (HTTP için ek olarak):
sudo ufw allow 80/tcp 443/tcp
# WebSSH/WGDashboard'a doğrudan erişmek için (opsiyonel):
sudo ufw allow 3000/tcp 10086/tcp
# WireGuard her zaman doğrudan:
sudo ufw allow 51820/udp
```

### Caddy ile HTTPS (otomatik TLS)

`docker compose.yaml` üçüncü bir servis olarak Caddy reverse proxy içerir. Caddy:

- Let's Encrypt / ZeroSSL'den **otomatik sertifika alır** (DNS challenge ile Cloudflare arkasında da çalışır).
- 90 gün geçerlilikteki sertifikaları kendisi yeniler.
- HTTP → HTTPS yönlendirmesini kendisi yapar (Let's Encrypt zorunluluğu).
- WebSSH'in `/ws` WebSocket yolunu otomatik upgrade eder (terminal trafiği için kritik).
- WGDashboard'ın `/socket.io` yolunu da upgrade eder (canlı log/peer durumu).

#### .env dosyası

```ini
# Caddy tarafından okunur
WEBSSH_DOMAIN=ssh.example.com
WGD_DOMAIN=wgd.example.com
```

DNS'te bu iki alan adı bu sunucunun public IPv4 adresine yönlendirilmiş olmalıdır (A kaydı). IPv6 da kullanılacaksa `AAAA` kaydı gerekir. Caddy başlatıldıktan sonra 30-60 saniye içinde sertifika alınır (`docker compose logs caddy` ile takip edilebilir).

#### Sertifika yenileme sorunları

| Sorun | Çözüm |
|---|---|
| "acme: error: 400" — DNS yönlendirmesi eksik | Alan adının `dig +short ssh.example.com` komutuyla sunucu IP'sini döndürdüğünü doğrulayın. |
| "rate limit" hatası | Let's Encrypt'in haftalık limiti. Birkaç saat bekleyin veya Cloudflare arkasındaysanız DNS challenge kullanın. |
| Sertifika alındı ama tarayıcı "güvenli değil" diyor | Sistem saatini kontrol edin: `timedatectl`. 5 dakikadan fazla sapma sorun yaratır. |
| Caddy sürekli yeniden başlıyor | `docker compose logs caddy` çıktısını kontrol edin; Caddyfile sözdizimi hatası olabilir: `docker compose run --rm caddy caddy validate --config /etc/caddy/Caddyfile`. |

#### Cloudflare arkasında TLS (önerilen)

Alan adınız Cloudflare üzerinden yönetiliyorsa, en sağlam kurulum:

1. Cloudflare DNS'te `ssh.example.com` ve `wgd.example.com` için `A` kaydı (proxy **açık**, turuncu bulut).
2. Cloudflare'da bu alan adları için **SSL/TLS → Full (Strict)** modunu seçin.
3. Cloudflare API token'ı ile DNS challenge kullanmak için `Caddyfile`'a ekleyin:

```caddyfile
ssh.example.com, wgd.example.com {
    tls {
        dns cloudflare {env.CLOUDFLARE_API_TOKEN}
    }
    ...
}
```

4. `.env`'e `CLOUDFLARE_API_TOKEN=...` ekleyin ve `docker compose restart caddy` çalıştırın.

Bu sayede:
- Cloudflare → Sunucu bağlantısı Cloudflare kaynaklı sertifika (origin certificate) ile şifrelenir.
- Cloudflare → Kullanıcı bağlantısı public Let's Encrypt sertifikası ile şifrelenir.
- UDP 51820 (WireGuard) Cloudflare tünelinden geçemez; doğrudan sunucu IP'siyle kullanılır.

### Seçenek 3: Sadece WebSSH (Docker'sız)

```bash
npm install
npm start
# veya farklı port:
PORT=8080 npm start
```

`http://localhost:3000` adresinde arayüz açılır. WireGuard yönetim paneli kullanılabilir; **WGDashboard entegrasyonu** isteğe bağlı olarak SSH üzerinden uzaktan kurulabilir (aşağıya bakın).

## Kullanım

1. **Sol panelden** sunucu bilgilerini girin: Host, Port (varsayılan 22), Kullanıcı adı.
2. **Kimlik doğrulama** sekmesinden "Parola" veya "Özel Anahtar" seçin.
   - Özel anahtar için doğrudan PEM içeriğini yapıştırabilir ya da `.pem`/`.key` dosyası yükleyebilirsiniz.
   - Anahtar parolası varsa ilgili alana yazın.
3. **Bağlan**'a basın. Sağ üstteki rozet yeşile döner ve terminal etkileşime açılır.
4. Üst sekmelerden **SFTP**'ye geçerek dosya yönetimi yapın, **Oturumlar** sekmesinden kayıtlı sunuculara erişin.

### Tuş kısaltmaları (terminal içinde)

| Tuş | İşlev |
|---|---|
| `Ctrl+C` / `Ctrl+D` | Aktif uzak komutu sonlandır / oturumu kapat |
| `Ctrl+L` | Terminal ekranını temizle (ek olarak sağ üstteki "Temizle" düğmesi) |
| Fare seçimi | Standart kopyalama (tarayıcı) |
| Pencere yeniden boyutlandırma | Uzak taraftaki PTY otomatik boyutlanır |

### SFTP paneli

- **Dizin listeleme**: Çift tık → klasöre gir, `..` → üst dizin.
- **Dosya önizleme**: Tek tık → metin dosyaları sağda görüntülenir.
- **Yükle**: "Yükle" düğmesi → dosya seç → uzak sunucuya yazılır.
- **İndir**: Dosya seçili iken "İndir" (8 MB'a kadar tarayıcı içinde gösterilir; büyük dosyalar için sunucu tarafında streaming indirme genişletilebilir).
- **Klasör/sil**: "Klasör Oluştur" veya seçili öğe için "Sil".

### WireGuard paneli (tek tıkla kurulum + yönetim)

WireGuard paneli, **mevcut SSH bağlantısı** üzerinden uzak sunucuda çalışır. Soldaki SSH bağlantı ayarlarından bir sunucuya bağlandıktan sonra "WireGuard" sekmesine geçin.

#### A'dan Z'ye Kurulum Sihirbazı (önerilen başlangıç noktası)

Panelin en üstündeki yeşil çerçeveli **"A'dan Z'ye Kurulum Sihirbazı"** tüm kurulumu tek tıkla yapar:

| Adım | Ne yapar |
|---|---|
| 1 | Ortam algılama (OS, paket yöneticisi, sudo, systemd, docker) |
| 2 | WireGuard + qrencode + iptables paketlerini kurar (apt/yum/dnf/apk/pacman otomatik) |
| 3 | Sunucu anahtar çifti + `/etc/wireguard/wg0.conf` oluşturur |
| 4 | IP yönlendirme + NAT kurallarını etkinleştirir |
| 5 | `wg-quick@wg0` systemd servisini başlatır |
| 6 | İlk peer'ı oluşturur, `.conf` ve QR kod üretir |
| 7 | WGDashboard'ı Docker Compose ile kurar ve ayağa kaldırır |

Sihirbazda her adımın durumu (✓/✗/çalışıyor) canlı olarak görünür, ham çıktı detaylara tıklanarak incelenebilir. Sonuç ekranı sunucu public key, ilk peer `.conf` dosyası, QR kod ve erişim linklerini (WebSSH + WGDashboard) tek noktada gösterir.

Aşağıdaki bireysel paneller (Ortamı Algıla, Tek Tıkla Kurulum, Peer Ekle, vb.) manuel kullanım veya ince ayar için hâlâ kullanılabilir; sihirbaz bunları ardışık olarak çağırır.

#### Manuel adımlar

1. **"Ortamı Algıla"**: Hedef sunucuda OS, mimari, `wg`/`wg-quick` varlığı, paket yöneticisi, sudo ve systemd desteği algılanır. Çıktı panelde görüntülenir.
2. **"Tek Tıkla Kurulum"**: Aşağıdaki parametrelerle (varsayılanlar önerilen):
   - Arayüz: `wg0`
   - Sunucu IP: `10.0.0.1/24`
   - Port: `51820` (UDP)
   - DNS: `1.1.1.1, 8.8.8.8`

   Kurulum sihirbazı şu adımları çalıştırır:
   - Paket yöneticisini (apt/yum/dnf/apk/pacman) otomatik algıla ve `wireguard-tools` + `iptables` + `qrencode` kur.
   - `/etc/wireguard/server_private.key` ve `server_public.key` anahtarlarını üret (yoksa).
   - `/etc/wireguard/wg0.conf` dosyasını yaz (IP yönlendirme + NAT/MASQUERADE kurallarıyla).
   - `net.ipv4.ip_forward=1` parametresini etkinleştir.
   - `wg-quick@wg0` systemd servisini başlat ve etkinleştir (systemd yoksa `wg-quick up` kullanır).
   - Son durumu `wg show` ile gösterir.
3. **"Peer Ekle"**: Peer adı, izinli IP (`10.0.0.2/32` gibi), endpoint (`sunucu.example.com:51820`) girin. Sistem:
   - İstemci için `genkey` + `genpsk` üretir.
   - Sunucuya `wg set wg0 peer ... allowed-ip ... persistent-keepalive 25` ile peer ekler.
   - `/etc/wireguard/clients/<ad>.conf` dosyasını yazar.
   - İstemci konfigürasyonunu **QR kodu** olarak gösterir (telefondan WireGuard uygulamasıyla tarayabilirsiniz).
   - `.conf` olarak indirmeniz için "Konfigürasyonu İndir" düğmesi etkinleşir.
4. **Peer tablosu**: Ad, public key, izinli IP, son handshake zamanı, RX/TX miktarları. "Sil" düğmesiyle peer kaldırılır ve `wg-quick save` ile yapılandırma diske yazılır.

> ℹ️ Tüm komutlar uzak sunucuda `sudo` ile (veya sudo'suz çalışıyorsa doğrudan) çalışır. "sudo kullan" onay kutusu kapatılırsa komutlar yetkisiz çalışır.

> ⚠️ WireGuard paneli kullanmak için hedef sunucuda **root** veya sudo yetkisi olan bir kullanıcı ile giriş yapmanız gerekir. Yapılandırma `/etc/wireguard/` altında tutulur.

### WGDashboard entegrasyonu (tek tıkla kurulum)

WebSSH, [WGDashboard](https://wgdashboard.dev)'u (Python/Flask + Vue.js tabanlı, MFA/2FA destekli WireGuard yönetim paneli) doğrudan WireGuard paneli içinden kurabilir. **Amaç**: WebSSH'in hafif terminal tarzı yönetiminin yanına, WGDashboard'un kapsamlı (çoklu kullanıcı, MFA, zamanlanmış görevler, peer kısıtlama) özelliklerini eklemek.

**Akış:**

1. SSH ile hedef sunucuya bağlanın (Docker ve Docker Compose gerekli).
2. WireGuard sekmesinin en altındaki **WGDashboard** panelinde:
   - "WGDashboard Portu" (varsayılan 10086), "WireGuard Portu" (varsayılan 51820), "WG Config Dizini" (varsayılan `/etc/wireguard`) ve arayüz adını ayarlayın.
   - **"Ortamı Algıla"**: Hedef sunucuda Docker + Compose varlığını ve mevcut WGDashboard container'ını raporlar.
   - **"Tek Tıkla Kur (Docker Compose)"**: Hedef sunucuda `/opt/wgdashboard/compose.yaml` dosyasını yazar, `wgdashboard` imajını çeker ve arka planda başlatır. **WebSSH ile aynı `/etc/wireguard` dizinini paylaşır** — yani her iki panelden yapılan peer değişiklikleri anında diğerinde görünür.
   - **"Durum"**: Container durumu, port eşlemesi, son loglar.
   - **"Loglar"**: `docker logs` çıktısı.
   - **"Kaldır"**: Container'ı ve yapılandırmayı kaldırır (`/etc/wireguard` korunur).
   - **"WGDashboard'u Aç ↗"**: Sağ üstte, ana bilgisayar IP'si ve WGDashboard portuyla hedef sayfayı yeni sekmede açar.

**İlk açılışta:** WGDashboard kendi kullanıcı oluşturma sihirbazını gösterir. Bir admin hesabı oluşturun ve isteğe bağlı MFA/2FA (TOTP) etkinleştirin.

**Neden docker-compose değil, uzak SSH exec?**

WebSSH, hedef sunucuda Docker Compose'u **doğrudan SSH üzerinden** çalıştırır. Bu sayede:
- Aynı komutlarla hem bare-metal hem container ortamları yönetilebilir.
- Hedef sunucuda Docker kuruluysa, ayrı bir makine gerekmez.
- Mevcut `/etc/wireguard` yapılandırmanız varsa WGDashboard onu otomatik görür (WGDashboard'un seamless integration özelliği).

> ⚠️ WGDashboard kurulumu için hedef sunucuda **Docker** + **Docker Compose v2** (veya v1) kurulu olmalıdır. "Ortamı Algıla" düğmesi ile doğrulayabilirsiniz.

#### Hangi port neden açık?

`docker-compose.yaml`'da tanımlı port eşlemeleri ve her birinin işlevi:

| Servis | Host port | Container port | Protokol | Neden? |
|--------|-----------|----------------|----------|--------|
| `webssh` | **3000** (→ `WEBSSH_PORT`) | 3000 | TCP | Tarayıcıdan WebSSH'e HTTP erişimi |
| `wgdashboard` | **10086** (→ `WGD_PORT`) | 10086 | TCP | WGDashboard web arayüzü |
| `wgdashboard` | **51820** (→ `WGPORT`) | 51820 | **UDP** | WireGuard VPN trafiği (host kernel'ı kullanır, container sadece UDP paketlerini alır) |

**Özelleştirme:** `docker-compose.yaml` başlatılmadan önce env değişkenleriyle değiştirilebilir:

```bash
WEBSSH_PORT=8080 WGPORT=51920 WGD_PORT=9086 docker compose up -d
```

> ⚠️ WireGuard **UDP** kullanır — TCP reverse proxy (Caddy/Nginx) arkasına alınabilir ama **UDP desteği gerekir** (örn. Caddy UDP/QUIC yönlendirmesi veya `udp-replicate` Docker modu). En kolay yol: yalnızca **WebSSH (3000)** için HTTPS reverse proxy kurup, 51820/UDP'yi doğrudan host'a bırakmaktır.

### WebSSH + WGDashboard mimarisi

**HTTPS modu (alan adı ayarlı, Caddy aktif):**

```
┌──────────────────────────────────────────────────────────────────┐
│  Hedef Sunucu (Linux)                                             │
│                                                                  │
│  /etc/wireguard/   ◄─── paylaşılan klasör                       │
│   ├── wg0.conf                                                   │
│   └── clients/*.conf                                             │
│                                                                  │
│  wg-quick@wg0       ◄─── WireGuard arayüzü (kernel)             │
│                                                                  │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐   │
│  │ WebSSH       │    │ WGDashboard      │    │ Caddy        │   │
│  │ (node)       │    │ (Flask + Vue)    │    │ (alpine)     │   │
│  │ :3000        │    │ :10086           │    │ :80, :443    │   │
│  └──────┬───────┘    └────────┬─────────┘    └──────┬───────┘   │
│         └────────┬───────────┘                     │           │
│                  │  aynı /etc/wireguard             │           │
│                  └─────────────────────────────────►           │
└──────────────────────────────────────────────────────────────────┘
         ▲                                ▲                       ▲
         │ HTTPS (443)                    │ HTTPS (443)          │ UDP
         │ ssh.example.com                │ wgd.example.com      │ 51820
         │                                │                       │
   ┌─────┴──────┐                  ┌──────┴─────┐          ┌──────┴──────┐
   │ Kullanıcı  │                  │ Yönetici   │          │ Mobil       │
   │ A (SSH)    │                  │ B (admin)  │          │ istemci (WG)│
   └────────────┘                  └────────────┘          └─────────────┘
```

**HTTP modu (alan adı yok, doğrudan port erişimi):** Caddy katmanı atlanır; WebSSH `:3000`, WGDashboard `:10086` doğrudan host'a açılır.

> ⚠️ WireGuard **UDP** kullanır — TCP reverse proxy (Caddy) arkasına alınamaz. Caddy sadece **WebSSH (HTTPS) ve WGDashboard (HTTPS)** trafiğini yönlendirir; WireGuard **51820/UDP** doğrudan host'a bırakılır.

## Güvenlik notları

- Bu uygulama **kendi makinenizden veya güvenli bir LAN üzerinden** çalıştırılmak içindir. Doğrudan internete açıyorsanız:
  - **TLS/HTTPS** kullanın (Nginx/Caddy reverse proxy).
  - **Temel kimlik doğrulama** veya tek oturum açma ekleyin.
  - **Yerel ağ dinleme**: `server.listen(port, '127.0.0.1')` ile sınırlayın.
- Parolalar **yalnızca oturum belleğinde** tutulur, kaydedilmez.
- localStorage'daki oturum kayıtları yalnız **bağlantı meta verilerini** (host, kullanıcı adı, port) saklar; parola/anahtar içermez.

## Yapılandırma

### Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `3000` | HTTP/WS portu |

### Algoritma geçersiz kılma

"Gelişmiş" bölümünde `algorithms` alanına JSON geçebilirsiniz. Eski sunucular için örnek:

```json
{
  "kex": ["diffie-hellman-group14-sha1", "diffie-hellman-group1-sha1"],
  "cipher": ["aes128-cbc", "3des-cbc"],
  "hmac": ["hmac-sha1", "hmac-md5"]
}
```

## Geliştirme

```bash
# Otomatik yeniden başlatma ile geliştirme
npm run dev
```

Yapı:

- `server.js` — Express + WebSocket + ssh2 + wireguard exec
- `public/index.html` — arayüz iskeleti (4 sekme: Terminal / SFTP / WireGuard / Oturumlar)
- `public/styles.css` — koyu tema, PuTTY tarzı sekmeler ve panel
- `public/app.js` — terminal, SFTP, WireGuard yönetimi, WGDashboard kurulumu, oturum kaydetme
- `docker-compose.yaml` — WebSSH + WGDashboard tam yığın (çoklu konteyner)
- `Dockerfile` — WebSSH için Node 24 bookworm-slim imajı
- `install.sh` — Ubuntu/Debian/RHEL/Fedora/Arch için tek komutluk kurulum

## Sınırlamalar

- İndirme şu an tek seferde en fazla 8 MB (büyük dosyalar için streaming eklenebilir).
- Port yönlendirme (SSH tunnel) ileri sürümlerde eklenebilir (`forwardOut` ile).
- X11 yönlendirme desteklenmiyor.
- WireGuard yönetimi sadece uzak sunucuda `wg`/`wg-quick`/`systemd` mevcutsa çalışır. Kurulum sihirbazı apt/yum/dnf/apk/pacman paket yöneticilerini destekler; **brew veya diğer paket yöneticileri** otomatik kurulum yapmaz (ama `wg` zaten kuruluysa yönetim işlemleri çalışır).

## Test

Bu uygulama gerçek bir OpenSSH sunucusuna karşı uçtan uca doğrulanmıştır:

```bash
# Bir sshd başlatıp (ör. macOS'ta)
/usr/sbin/sshd -f /tmp/sshd.conf -D -e &

# WebSSH'i çalıştır
PORT=3000 npm start

# WebSocket üzerinden bağlantı + shell + SFTP (list/write/read) testleri yeşil.
# WireGuard paneli: detect / install / status / add-peer / list-clients / remove-peer adımları SSH üzerinden uzak sunucuda çalıştırılır ve yanıtlar JSON olarak istemciye döner.
```

### WireGuard test özeti

| Adım | Sonuç |
|---|---|
| `detect` | OS, mimari, `wg`/`wg-quick` varlığı, paket yöneticisi, sudo ve systemd bilgisi raporlandı |
| `install` | Komut dosyası çalıştırıldı, paket yöneticisi otomatik algılandı |
| `status` | `wg show` çalıştırıldı, arayüz/yapılandırma durumu döndü |
| `add-peer` | Peer anahtar çifti üretildi, sunucuya eklendi, istemci konfigürasyonu istemciye döndü |
| `list-clients` | Peer listesi, handshakes ve transfer istatistikleri alındı |
| `remove-peer` | Peer kaldırma komutu gönderildi |
| `setup-wizard` | Tek eylemde 7 adımı (algılama → WG kurulumu → keygen → IP forward → servis → peer → WGD) orkestre eder; adım markerlarını üretir, frontend bunları parse edip UI'a yansıtır. |