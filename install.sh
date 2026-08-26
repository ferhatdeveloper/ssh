#!/usr/bin/env bash
# WebSSH + WGDashboard Ubuntu kurulum scripti
# Desteklenen dağıtımlar: Ubuntu 22.04+, Debian 12+, RHEL 9+, Fedora 39+, Arch
# Çalıştırma: sudo ./install.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Renk kodları
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { printf "${BLUE}[i]${NC} %s\n" "$*"; }
ok()   { printf "${GREEN}[✓]${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}[!]${NC} %s\n" "$*"; }
err()  { printf "${RED}[✗]${NC} %s\n" "$*" >&2; }

[[ $EUID -eq 0 ]] || { err "Lütfen root olarak çalıştırın: sudo $0"; exit 1; }

# OS algılama
. /etc/os-release 2>/dev/null || true
OS_ID="${ID:-unknown}"
OS_VER="${VERSION_ID:-unknown}"
info "Algılanan dağıtım: $OS_ID $OS_VER"

# --- 1) Docker kontrolü ---
if ! command -v docker >/dev/null 2>&1; then
  info "Docker bulunamadı, kuruluyor..."
  case "$OS_ID" in
    ubuntu|debian)
      apt-get update -y
      apt-get install -y ca-certificates curl gnupg
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/$OS_ID/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_ID $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
        > /etc/apt/sources.list.d/docker.list
      apt-get update -y
      apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    rhel|centos|rocky|almalinux|fedora)
      dnf -y install dnf-plugins-core
      dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo || true
      dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    arch|manjaro)
      pacman -Sy --noconfirm docker docker-compose
      ;;
    *)
      err "Desteklenmeyen dağıtım: $OS_ID. Lütfen Docker'ı manuel kurun: https://docs.docker.com/engine/install/"
      exit 1
      ;;
  esac
  systemctl enable --now docker
  ok "Docker kuruldu"
else
  ok "Docker zaten kurulu: $(docker --version)"
fi

# --- 2) Docker Compose v2 kontrolü ---
if docker compose version >/dev/null 2>&1; then
  ok "Docker Compose v2 hazır: $(docker compose version)"
else
  err "Docker Compose v2 bulunamadı. 'docker compose' komutunu çalıştırabilmek için docker-compose-plugin kurulu olmalı."
  exit 1
fi

# --- 3) WireGuard kernel modülü kontrolü (Linux) ---
if [[ "$OS" == "Linux" ]]; then
  if ! lsmod | grep -q wireguard; then
    info "WireGuard kernel modülü yükleniyor..."
    case "$OS_ID" in
      ubuntu|debian)
        apt-get install -y wireguard linux-headers-$(uname -r) || warn "wireguard paketi kurulamadı (kernel modu gerekli olmayabilir)"
        modprobe wireguard 2>/dev/null || warn "wireguard modprobe başarısız (kernel modu zaten gömülü olabilir)"
        ;;
      rhel|centos|rocky|almalinux|fedora)
        dnf -y install kmod-wireguard wireguard-tools || warn "wireguard-tools kurulamadı"
        modprobe wireguard 2>/dev/null || true
        ;;
    esac
    # Kalıcı yükleme için
    if ! grep -q "^wireguard" /etc/modules-load.d/*.conf 2>/dev/null; then
      echo "wireguard" > /etc/modules-load.d/wireguard.conf 2>/dev/null || true
    fi
  else
    ok "WireGuard kernel modülü zaten yüklü"
  fi

  # IP yönlendirme kalıcı
  if ! grep -q "net.ipv4.ip_forward=1" /etc/sysctl.conf 2>/dev/null; then
    echo "net.ipv4.ip_forward=1" >> /etc/sysctl.conf
  fi
  sysctl -w net.ipv4.ip_forward=1 >/dev/null
  ok "IP yönlendirme etkin"
fi

# --- 4) WireGuard config dizini ---
mkdir -p "$REPO_DIR/wg-conf"
chmod 700 "$REPO_DIR/wg-conf"
ok "WireGuard config dizini: $REPO_DIR/wg-conf"

# --- 5) Firewall (UFW) — portları aç ---
if command -v ufw >/dev/null 2>&1; then
  info "UFW bulundu, gerekli portlar açılıyor..."
  ufw allow 3000/tcp comment "WebSSH" 2>/dev/null || true
  ufw allow 10086/tcp comment "WGDashboard" 2>/dev/null || true
  ufw allow 51820/udp comment "WireGuard" 2>/dev/null || true
  ok "UFW kuralları eklendi"
fi

# --- 6) Docker compose ile başlat ---
cd "$REPO_DIR"
info "İmajlar indiriliyor ve servisler başlatılıyor..."
docker compose pull wgdashboard 2>/dev/null || true
docker compose up -d --build

# --- 7) Durum kontrolü ---
sleep 3
echo
info "Servis durumu:"
docker compose ps

echo
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[[ -z "$HOST_IP" ]] && HOST_IP="<sunucu-ip>"

ok "Kurulum tamamlandı!"
echo
printf "${GREEN}Erişim URL'leri:${NC}\n"
printf "  WebSSH       → ${BLUE}http://%s:3000${NC}\n" "$HOST_IP"
printf "  WGDashboard  → ${BLUE}http://%s:10086${NC}\n" "$HOST_IP"
printf "  WireGuard    → ${BLUE}UDP %s:51820${NC}\n" "$HOST_IP"
echo
printf "${YELLOW}İlk adımlar:${NC}\n"
printf "  1. Tarayıcıdan WebSSH'e giriş yapın (SSH ile kendi sunucunuza bağlanın).\n"
printf "  2. WireGuard sekmesi → 'Tek Tıkla Kurulum' ile sunucu tarafını kurun.\n"
printf "  3. 'WGDashboard'u Aç ↗' ile kullanıcı oluşturma sihirbazını tamamlayın.\n"
echo
printf "${YELLOW}Loglar:${NC} docker compose logs -f\n"
printf "${YELLOW}Durdur:${NC} docker compose down\n"