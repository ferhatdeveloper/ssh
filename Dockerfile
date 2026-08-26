# WebSSH için imaj
# node:24-bookworm-slim Debian tabanlı, küçük ve güvenilir
FROM node:24-bookworm-slim
WORKDIR /app

# Sadece bağımlılık dosyalarını kopyala (cache dostu)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Kaynak kodları kopyala
COPY server.js ./
COPY public ./public

EXPOSE 3000

# Root olmayan kullanıcı ile çalıştır (güvenlik)
RUN useradd -m -u 1001 -s /bin/bash webssh && chown -R webssh:webssh /app
USER webssh

CMD ["node", "server.js"]