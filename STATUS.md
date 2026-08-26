# WireGuard Wizard — Sudo Fix Durumu

## Tarih
2026-08-26 19:33 UTC+3

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