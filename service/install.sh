#!/usr/bin/env bash
# install.sh - set up the smart-home-engine system service
# Run as root after: npm install -g smart-home-engine
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "error: must be run as root (sudo $0)" >&2
    exit 1
fi

SHE_USER=she
SERVICE_SRC="$(npm root -g)/smart-home-engine/service/smart-home-engine.service"
SERVICE_DST=/etc/systemd/system/smart-home-engine.service

# --- ensure sudo is installed (required for web UI restart/update buttons) -
if ! command -v sudo &>/dev/null; then
    echo "sudo not found, installing..."
    apt-get install -y sudo
fi

# --- system user ---------------------------------------------------------
if ! id "$SHE_USER" &>/dev/null; then
    useradd \
        --system \
        --create-home \
        --home-dir /home/she \
        --shell /usr/sbin/nologin \
        --comment "Smart Home Engine daemon" \
        "$SHE_USER"
    echo "created system user '$SHE_USER'"
else
    echo "user '$SHE_USER' already exists, skipping"
fi

# --- state directory ------------------------------------------------------
install -d -o "$SHE_USER" -g "$SHE_USER" -m 750 /var/lib/she
echo "created /var/lib/she"

# --- sudoers rules -------------------------------------------------------
NPM_BIN="$(command -v npm)"
SUDOERS_FILE=/etc/sudoers.d/she
cat > "$SUDOERS_FILE" <<EOF
she ALL=(root) NOPASSWD: /usr/bin/systemctl restart smart-home-engine
she ALL=(root) NOPASSWD: $NPM_BIN install -g smart-home-engine
EOF
chmod 440 "$SUDOERS_FILE"
echo "created $SUDOERS_FILE"

# --- systemd service -----------------------------------------------------
cp "$SERVICE_SRC" "$SERVICE_DST"
chmod 644 "$SERVICE_DST"
systemctl daemon-reload
systemctl enable smart-home-engine

echo ""
echo "Done. To start the service:"
echo "  systemctl start smart-home-engine"