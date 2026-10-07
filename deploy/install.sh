#!/usr/bin/env bash
# Install the gpupool broker on a Debian/Ubuntu server.
#
#   sudo bash install.sh
#
# Idempotent: safe to re-run to upgrade. Generates credentials on first run
# only, so re-running never invalidates machines that already joined.
set -euo pipefail

REPO="https://github.com/wshuv-o/gpupool.git"
PREFIX=/opt/gpupool
STATE=/var/lib/gpupool
CONF=/etc/gpupool
SERVICE_USER=gpupool

die() { echo "error: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root (sudo bash install.sh)"

echo "==> checking prerequisites"
command -v git >/dev/null || die "git not installed: apt install git"
# NODE_BIN lets you point at a newer node without touching system packages:
#   sudo NODE_BIN=/opt/node22/bin/node bash install.sh
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[[ -n "$NODE_BIN" ]] || die "node not found. Node 20+ is required:
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
or install it anywhere and re-run with NODE_BIN=/path/to/node"
NODE_BIN=$(readlink -f "$NODE_BIN")
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "$NODE_BIN is v$NODE_MAJOR; need 20+.
Ubuntu 24.04 ships 18, so install a newer one and re-run with NODE_BIN=/path/to/node:
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
fi
echo "    node $("$NODE_BIN" -v) at $NODE_BIN"
# Everything below must use the same node, not whatever PATH resolves to.
export PATH="$(dirname "$NODE_BIN"):$PATH"

echo "==> service user"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "==> source"
if [[ -d "$PREFIX/.git" ]]; then
  git -C "$PREFIX" fetch --quiet origin && git -C "$PREFIX" reset --hard --quiet origin/main
else
  rm -rf "$PREFIX"
  git clone --quiet --depth 1 "$REPO" "$PREFIX"
fi

echo "==> build"
cd "$PREFIX"
npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent
# devDependencies carry TypeScript, so build needs them; they are dropped after.
npm install --silent --no-save typescript @types/node @types/ws
npx tsc -p tsconfig.json
rm -rf node_modules/typescript node_modules/@types

echo "==> state and config"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE"
install -d -o root -g "$SERVICE_USER" -m 0750 "$CONF"

if [[ ! -f "$CONF/broker.env" ]]; then
  gen() { node -e "console.log('$1'+require('crypto').randomBytes(16).toString('hex'))"; }
  ADMIN=$(gen admin_)
  APP=$(gen pk_)
  cat > "$CONF/broker.env" <<EOF
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ). Credentials — keep this file secret.
PORT=8787
# Bind to loopback only: nginx terminates TLS and is the only thing that
# should reach the broker directly.
HOST=127.0.0.1

GPUPOOL_ADMIN_KEY=$ADMIN

# App key -> environment name. Add more as you add apps.
GPUPOOL_APP_KEYS={"$APP":"ollama"}

# Machines enrol with invite codes, so no agent tokens are needed here.
GPUPOOL_TOKEN_STORE=$STATE/tokens.json

# Browsers may call the broker from these origins. Narrow this to your own
# site; '*' is convenient but lets any page use a key it has obtained.
GPUPOOL_CORS_ORIGIN=*

# nginx terminates TLS, so every request reaches the broker from 127.0.0.1.
# Without this the rate limiter sees one client and a single attacker would
# lock out everybody. Only safe BECAUSE the broker is bound to loopback and
# nginx is the only thing that can reach it.
GPUPOOL_TRUST_PROXY=true

# Failed authentications from one address before it is blocked, the window
# they must fall within, and how long the block lasts.
GPUPOOL_AUTH_MAX_FAILURES=10
GPUPOOL_AUTH_WINDOW_MS=300000
GPUPOOL_AUTH_BLOCK_MS=900000
EOF
  chown root:"$SERVICE_USER" "$CONF/broker.env"
  chmod 0640 "$CONF/broker.env"
  echo "    generated $CONF/broker.env"
  NEW_CREDS=1
else
  echo "    keeping existing $CONF/broker.env"
  NEW_CREDS=0
fi

chown -R "$SERVICE_USER":"$SERVICE_USER" "$STATE"

echo "==> systemd"
# Substitute the verified interpreter rather than shipping a guess that is
# wrong on any box whose node is not /usr/bin/node.
sed "s|^ExecStart=.*|ExecStart=$NODE_BIN $PREFIX/dist/broker/index.js|"   "$PREFIX/deploy/gpupool-broker.service" > /etc/systemd/system/gpupool-broker.service
chmod 0644 /etc/systemd/system/gpupool-broker.service
echo "    ExecStart=$NODE_BIN"
systemctl daemon-reload
systemctl enable --quiet gpupool-broker
systemctl restart gpupool-broker
sleep 2

if systemctl is-active --quiet gpupool-broker; then
  echo "    running"
else
  echo "    FAILED — journalctl -u gpupool-broker -n 40" >&2
  exit 1
fi

echo
echo "broker is up on 127.0.0.1:8787"
echo
if [[ "$NEW_CREDS" == "1" ]]; then
  echo "credentials are in $CONF/broker.env (root:$SERVICE_USER 0640):"
  echo "  sudo grep GPUPOOL_ $CONF/broker.env"
  echo
fi
cat <<'NEXT'
next:
  1. DNS: add an A record  gpu.odinbd.com -> this server's public IP
  2. nginx:
       sudo cp /opt/gpupool/deploy/nginx-gpupool.conf /etc/nginx/sites-available/gpu.odinbd.com
       # add the map{} block from the top of that file into /etc/nginx/nginx.conf http{}
       sudo ln -s /etc/nginx/sites-available/gpu.odinbd.com /etc/nginx/sites-enabled/
       sudo certbot --nginx -d gpu.odinbd.com
       sudo nginx -t && sudo systemctl reload nginx
  3. check:  curl https://gpu.odinbd.com/_health
  4. invite a GPU machine:
       curl -X POST https://gpu.odinbd.com/_invite -H "Authorization: Bearer $GPUPOOL_ADMIN_KEY"
NEXT
