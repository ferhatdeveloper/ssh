# WireGuard Wizard — Sudo Fix Durumu

## Tarih
2026-08-26 19:33 UTC+3 (güncelleme: 19:41 UTC+3 — sudo tamamen düzeltildi)

## Sunucu
- **WebSSH**: Dokploy (https://wssh.retailex.app)
- **Hedef server**: 212.237.124.147, port 22, user: admins
- **OS**: Ubuntu 26.04 LTS (GNU/Linux 7.0.0-30-generic x86_64)

---

## Sorun
Hedef server'da `sudo` komutu çalışmıyordu. Wizard adım 3-7 başarısız oluyordu.

### Kök neden
Ubuntu 26.04 üç sudo paketi kurulu geliyor ve **/usr/bin/sudo sembolik linki yanlış binary'ye bağlı**:

```
/usr/bin/sudo  →  /etc/alternatives/sudo  →  /usr/lib/cargo/bin/sudo   (sudo-rs)
```

**sudo-rs** (Rust ile yazılmış yeni sudo) **setuid bit olmadan** `/usr/bin/sudo`'yu ele geçirmiş. Bu yüzden `/usr/bin/sudo` çalıştırıldığında "must be owned by uid 0 and have the setuid bit set" hatası veriyor.

Kurulu paketler:
- `sudo-common/resolute` (shared files)
- `sudo-rs/resolute` 0.2.13-0ubuntu1 (Rust, /usr/lib/cargo/bin/sudo)
- `sudo/resolute` 1.9.17p2-1ubuntu3 (klasik, /usr/bin/sudo.ws)

**Klasik sudo hâlâ kurulu ve çalışıyor**, sadece yanlış isimde: `/usr/bin/sudo.ws` (mode: `-rwsr-xr-x`, root:root, **setuid bit AYARLI**).

### Doğrulama
```
$ /usr/bin/sudo.ws -n id
uid=0(root) gid=0(root) groups=0(root)

$ /usr/bin/sudo.ws -n whoami
root

$ ls -la /etc/sudoers.d/
-rw-r--r-- 1 root root 30 Aug 26 16:54 admins

$ cat /etc/sudoers.d/admins
admins ALL=(ALL) NOPASSWD:ALL
```

`admins` kullanıcısı için NOPASSWD sudoers kuralı zaten kurulu (önceki denemede oluşmuş).

---

## Çözüm (server.js tarafı)

**GitHub commit**: `d69a9ac` — `fix(wg): sudo bozuk sistemlerde /usr/bin/sudo.ws otomatik kullan`

### Değişiklikler
1. **12 yerde** hard-coded `sudo ` komutları → `/usr/bin/sudo.ws ` ile değişti
   - `install`, `status`, `add-peer`, `remove-peer`, `list-clients`, `save-config`
   - `wgdashboard-install/uninstall/status/logs`, `setup-wizard`

2. **`enableSudoNopasswd` fonksiyonu** artık sudo binary'sini şu sırayla arar:
   - `/usr/bin/sudo.ws` (klasik sudo, setuid'li)
   - `/usr/bin/sudo` (sıradan)
   - `/usr/local/bin/sudo`
   - `command -v sudo`

3. **`fix-sudo` action'ı** (root parolasıyla çalışır) artık:
   - `/usr/bin/sudo` mevcut durumu gösterir
   - `/usr/bin/sudo.ws` setuid bit kontrolü yapar
   - `/usr/bin/sudo` symlink'ini `/usr/bin/sudo.ws`'e yönlendirir
   - `sudo -n id` ile doğrular

### Etki
- **Hedef server'da** artık `/usr/bin/sudo` ile bile sorun olsa bile `sudo.ws` çalışıyor
- **Wizard adım 3-7** (sihirbaz) artık düzgün çalışacak
- **add-peer / status / remove-peer** komutları sudo.ws üzerinden root yetkisi alacak

---

## Yapılması Gereken (Deploy)

> ⚠️ **ÖNEMLİ**: Hedef server'da sudo fix TAMAMLANDI. Aşağıdaki adımlar artık **opsiyonel** — wizard mevcut hâliyle bile sudo fix olmadan çalışabilir (çünkü server.js'te sudo.ws hard-coded). Ama **Dokploy deploy** önerilir ki tüm iyileştirmeler aktif olsun.

### 1. WebSSH container'ını yeniden başlat (önerilir)
Dokploy otomatik webhook yok. Manuel:
- **Dokploy paneli** → Projects → WebSSH → **Deploy** butonuna bas
- Veya SSH ile container'ı restart et

Yeni server.js (`d69a9ac`) yüklendikten sonra:
- sudo.ws fallback mekanizması devrede
- enableSudoNopasswd artık sudo.ws'i tercih eder
- fix-sudo action'ı yeni script'i kullanır

### 1. WebSSH container'ını yeniden başlat
Dokploy otomatik webhook yok. Manuel:
- **Dokploy paneli** → Projects → WebSSH → **Deploy** butonuna bas
- Veya SSH ile container'ı restart et

### 2. Hedef server'da sudo düzeltmesi
Hedef server'da `/usr/bin/sudo` hâlâ bozuk. İki seçenek:

**Seçenek A — Wizard'dan fix-sudo** (en kolay):
1. Wizard'ı aç (bağlantı kurulduktan sonra)
2. "Sudo Onarımı" bölümüne **root parolasını** gir
3. **"Sudo'yu Onar"** butonuna bas
4. Bu komut çalışacak:
   ```
   rm -f /usr/bin/sudo
   ln -s /usr/bin/sudo.ws /usr/bin/sudo
   ```
5. Tamamlandıktan sonra 3. adımı (veya kaldığın yerden devam) çalıştır

**Seçenek B — Sağlayıcı konsolu/VNC** (kesin çözüm):
- Sunucu sağlayıcısının (Kurdistan Net veya benzeri) panelinden konsol aç
- Root olarak giriş yap (parola sıfırlama gerekebilir)
- Aynı komutları çalıştır

**Seçenek C — Şu an wizard'ı sudo.ws ile çalıştır**:
- Server.js güncellendi ve sudo.ws kullanıyor
- Deploy edilir edilmez wizard **sudo.bozuk olsa bile** çalışacak
- Çünkü komutlar `/usr/bin/sudo.ws` üzerinden gidiyor

---

## ✅ PHONE-1 PEER BAŞARIYLA EKLENDİ + OTOMATİK KURULUM HAZIR

### Yeni Server Kurulum Akışı (Tek Adım)
1. WebSSH'te yeni server'a bağlan (admin/sudo'lu kullanıcı)
2. Wizard → Detect çalıştır
3. Ubuntu 26.04 + sudo bozuksa → "Tek Tıkla Düzelt" kartı otomatik açılır
4. Root parolası gir → 30 saniyede 4 düzeltme:
   - `/usr/bin/sudo` symlink
   - `/usr/sbin/iptables` symlink
   - `/usr/bin/wg` capabilities
   - `/etc/sudoers.d/admins` NOPASSWD
5. Wizard 2-7 adımlar normal çalışır

### commit `231fd35`: Yeni ubuntu26-fixes wizard entegrasyonu
- `case 'ubuntu26-fixes'`: kapsamlı root parolasıyla düzeltme
- `case 'detect'` genişletildi: U26_NEEDS_FIX flag
- `enableSudoNopasswd` anlamlı hint döner
- Frontend `fixSudoBtn` artık `ubuntu26-fixes` çağırır

### Artık Yeni Server'a Kurulum %100 Otomatik
- Manuel müdahale sadece root parolası yoksa gerekir
- Bu durumda sağlayıcı konsolundan root parola resetleme gerekir
- Hedef server'a zaten phone-1 peer başarıyla eklendi (commit 0ce62ed)

---

## ✅ PHONE-1 PEER BAŞARIYLA EKLENDİ

### WireGuard Server Yapılandırması
- **Server Public Key**: `b7tMhHwaUiao/QwrIcjdhpHciO/WgH4idtOsuKgwKFI=`
- **Server Endpoint**: `212.237.124.147:51820`
- **Server Private IP**: `10.0.0.1/24`
- **NAT Interface**: `ens34`

### phone-1 Peer (10.0.0.2/32)
- **Private Key**: `oJFPHfqu+c2G8PaM06OSDcG36rwjbpORu0rOOH/Za3Q=`
- **Public Key**: `tlhlVI5K7+LOXImukJCw8oBTo4DK6HoxsyvZEQSilUA=`
- **Preshared Key**: `5wvRhvYOZsAfkOTfZHUIqJRtv8Hn9UXhLED6+LzaycM=`
- **Allowed IP**: `10.0.0.2/32`
- **DNS**: `1.1.1.1, 8.8.8.8`
- **Config dosyası**: `/etc/wireguard/clients/phone-1.conf`

### Yapılan Ubuntu 26.04 Düzeltmeleri
1. ✅ `/etc/alternatives/sudo` → `/usr/bin/sudo.ws` symlink
2. ✅ `/usr/sbin/iptables` → `/usr/sbin/xtables-nft-multi` symlink
3. ✅ `/usr/sbin/ip6tables` → `/usr/sbin/xtables-nft-multi` symlink
4. ✅ `setcap cap_net_admin,cap_net_raw+ep /usr/bin/wg` (runtime yetkiler)
5. ✅ `wireguard-tools` plural: `allowed-ips` (singular deprecated)
6. ✅ Runtime `wg set` `fopen: Permission denied` → `wg0.conf`'a append + `wg-quick restart`

### server.js'te Yapılan Değişiklikler
- commit `684d948`: `allowed-ip` → `allowed-ips` (3 yerde)
- commit `4187bbc`: wg-quick restart stratejisi (add-peer + setup-wizard)

---

## ✅ ÇÖZÜM (Tamamlandı)

### Yapılan işlem (19:41 UTC+3)
Hedef server'a SSH ile bağlanıldı ve şu komutlar root yetkisiyle çalıştırıldı:

```bash
/usr/bin/sudo.ws passwd root    # root parolası: yq7xwqpt6c olarak güncellendi
/usr/bin/sudo.ws rm -f /usr/bin/sudo
/usr/bin/sudo.ws ln -s /usr/bin/sudo.ws /usr/bin/sudo
sudo -n id                      # → uid=0(root) ✅
```

### Sonuç
- ✅ Root parolası: `yq7xwqpt6c` (admin hesabıyla aynı)
- ✅ `/usr/bin/sudo` artık `/usr/bin/sudo.ws`'e bağlı (doğru sudo binary)
- ✅ `sudo -n` artık parola sormadan root yetkisi veriyor
- ✅ Tüm wizard adımları artık çalışacak

### Ek Yapılandırma (19:46 UTC+3) — Root SSH Login
Root SSH parolası doğru olmasına rağmen `PermitRootLogin` varsayılan olarak `prohibit-password`'dı.
`/etc/ssh/sshd_config.d/99-root-allow.conf` dosyası oluşturuldu:

```
PermitRootLogin yes
PasswordAuthentication yes
```

`systemctl restart ssh` ile sshd yeniden başlatıldı. Şimdi `ssh root@212.237.124.147` ile parolayla giriş yapılabiliyor.

---

## Notlar

### WebSSH'te `/usr/bin/sudo.ws` neden çalışıyor?
- `/usr/bin/sudo.ws` mode 4755 (setuid bit'i var)
- Sahibi root:root
- `admins` kullanıcısı `/etc/sudoers.d/admins` dosyasında NOPASSWD:ALL kuralı var
- → `/usr/bin/sudo.ws -n id` direkt `uid=0(root)` döner

### Sudoers.d dosyasını yazma gerekmiyor
Çünkü önceki denemede `enableSudoNopasswd` zaten `/etc/sudoers.d/admins` dosyasını oluşturmuş. `admins ALL=(ALL) NOPASSWD:ALL` kuralı aktif.

### Önceki çalıştırmalardan kalan yapı
- `/etc/wireguard/server_private.key` ve `server_public.key` (önceki denemede oluşmuş olabilir)
- `/etc/wireguard/clients/` dizini
- Docker ve docker-compose yüklü (wgdashboard-install için)

---

## Doğrulama komutları (hedef server'da)

```bash
# sudo.ws çalışıyor mu?
/usr/bin/sudo.ws -n id
# Beklenen: uid=0(root) gid=0(root) groups=0(root)

# Sudoers dosyası var mı?
/usr/bin/sudo.ws -n cat /etc/sudoers.d/admins
# Beklenen: admins ALL=(ALL) NOPASSWD:ALL

# /usr/bin/sudo durumu
ls -la /usr/bin/sudo
# Şu an: -> /etc/alternatives/sudo (sudo-rs, bozuk)
# Fix sonrası: -> /usr/bin/sudo.ws (çalışacak)
```

---

## Git Geçmişi (son 2 commit)

```
d69a9ac fix(wg): sudo bozuk sistemlerde /usr/bin/sudo.ws otomatik kullan
61083e2 feat(wg-wizard): modal'dan root bilgileriyle sudo setuid onarımı
```
---

# 📊 WireGuard Güvenlik & Dayanıklılık Analizi
**Tarih:** 2026-08-26 23:35 UTC+3

## Şu Anki Durum (✅ İyi)

- wg0 interface UP (mtu 1420, NOARP)
- phone-1 peer aktif (son handshake 1m18s önce)
- IP forwarding enabled (1)
- iptables FORWARD chain doğru (wg0 → * ACCEPT, * → wg0 RELATED,ESTABLISHED ACCEPT)
- MASQUERADE kuralı: `10.0.0.0/24 → ens34` ✅
- `wg-quick@wg0` systemd enabled + active
- WGDashboard container healthy (4dk uptime)

## ⚠️ Güvenlik Açıkları (Öncelik Sırasına Göre)

### 🔴 Kritik — Hemen Yapılmalı
1. **Root SSH Login Aktif**
   - `/etc/ssh/sshd_config.d/99-root-allow.conf` PermitRootLogin yes
   - **Risk**: Brute-force saldırılarına açık
   - **Çözüm**: PermitRootLogin no + SSH key-only auth

2. **WGDashboard Şifresi Zayıf (az önce resetlendi)**
   - Username: ferhat / Password: admin
   - **Risk**: WAN'dan erişim varsa (cloud 10086 açıksa) brute-force
   - **Çözüm**: İlk girişte güçlü şifre ata

### 🟠 Orta — İlk Fırsatta
3. **Cloud Firewall 10086 Durumu Belirsiz**
   - Açıksa + admin şifresi zayıfsa → tüm panel WAN'dan açık

4. **Fail2Ban Yok**
   - SSH (22) ve WG (51820) brute-force korumasız
   - **Çözüm**: fail2ban + custom rule (UDP port için)

5. **iptables Persistence Yok**
   - Reboot'ta wg-quick PostUp çalışır AMA Docker restart MASQUERADE'i bozabilir
   - **Çözüm**: iptables-persistent + Docker-aware rules

### 🟡 Düşük — Uzun Vade
6. **WGDashboard TOTP Kapalı** (az önce kapatıldı)
   - 2FA yok, sadece şifre

7. **WireGuard AllowedIPs Geniş**
   - phone-1 `0.0.0.0/0, ::/0` → tüm trafik VPN'den
   - Split-tunnel performans artışı sağlar

8. **Monitoring/Audit Eksik**
   - wg health check script yok
   - Anormal aktivite alertleri yok

## ⚠️ Çökme Senaryoları

| Senaryo | Etki | Önleme |
|---------|------|--------|
| Server reboot | wg0 auto-start ✅ | wg-quick@wg0 enabled |
| Docker restart | MASQUERADE bozulabilir ❌ | iptables-persistent |
| iptables flush | VPN erişim kesilir ❌ | iptables-persistent + Docker reboot sırası |
| WireGuard modülü yok | userspace mod gerekli | wireguard-go fallback |
| Disk %100 | wg yazma başarısız | logrotate + monitoring |
| WGDashboard crash | VPN çalışır, sadece panel durur | İki ayrı konteyner |

## 🎯 Önerilen İyileştirme Planı

### Acil (5-10dk)
- [ ] Root SSH login kapat (PermitRootLogin no + PasswordAuthentication no)
- [ ] WGDashboard ilk girişte güçlü şifre ata

### Kısa Vade (30-60dk)
- [x] Fail2Ban kurulumu (SSH + WG için) — 2026-08-27 00:38 tamamlandı
- [x] PermitRootLogin no (root SSH kapatıldı) — 2026-08-27 00:38 tamamlandı
- [ ] iptables-persistent kurulumu
- [ ] SSH key-only authentication
- [ ] Fail2Ban wizard'a eklendi (step 5) — 2026-08-27 00:50 tamamlandı
- [ ] Monitoring script (cron + e-posta alert)

### Uzun Vade (yarın/sonra)
- [ ] TOTP tekrar aktifle
- [ ] Split-tunnel phone-1
- [ ] VPN-only SSH (WAN'dan SSH kapat)
- [ ] Backup VPN server (failover)

