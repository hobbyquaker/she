#!/usr/bin/env bash
# install.sh - set up the smart-home-engine system service
# Run as root after: npm install -g smart-home-engine
set -euo pipefail

HELPER_DST=/usr/local/bin/she-servicectl

# --- sudoers rules -------------------------------------------------------
# Two rules, nothing else: the web UI's Restart button and the helper, through which everything
# else privileged goes - she's own update included (she-servicectl she-update <version>). The file
# is written anew each time, so a rule of an earlier version does not survive a re-install: up to
# 3.0.0-beta.7 there was a third one, "<npm> install -g smart-home-engine", for the update.
# Written next to the target and renamed, so sudo never reads half a file (it skips names with a dot).
write_sudoers() {
    local file=$1 tmp
    if [ -f "$file" ] && grep -q 'install -g smart-home-engine' "$file"; then
        echo "removing the npm rule of earlier versions from $file"
    fi
    tmp="$(mktemp "$file.XXXXXX")"
    cat > "$tmp" <<EOF
she ALL=(root) NOPASSWD: /usr/bin/systemctl restart smart-home-engine
she ALL=(root) NOPASSWD: $HELPER_DST
EOF
    chmod 440 "$tmp"
    mv -f "$tmp" "$file"
}

# install.sh --sudoers-only <file>: write only the rules, to <file> - what the tests run.
if [ "${1:-}" = "--sudoers-only" ]; then
    [ -n "${2:-}" ] || { echo "usage: $0 --sudoers-only <file>" >&2; exit 2; }
    write_sudoers "$2"
    exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "error: must be run as root (sudo $0)" >&2
    exit 1
fi

SHE_USER=she
SERVICE_SRC="$(npm root -g)/smart-home-engine/service/smart-home-engine.service"
SERVICE_DST=/etc/systemd/system/smart-home-engine.service

# --- ensure sudo is installed (required for web UI restart/update buttons) -
if ! command -v sudo &>/dev/null; then
    echo "error: sudo not found. Please install sudo before running this script." >&2
    exit 1
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

# --- service management helper (she-servicectl, roadmap I4) -------------
# The only privileged command the Services page uses; every argument is validated
# inside the script. See doc/services.md.
HELPER_SRC="$(dirname "$SERVICE_SRC")/she-servicectl"
install -m 755 -o root -g root "$HELPER_SRC" "$HELPER_DST"
echo "installed $HELPER_DST"

# --- sudoers rules (write_sudoers above) ---------------------------------
SUDOERS_FILE=/etc/sudoers.d/she
write_sudoers "$SUDOERS_FILE"
echo "wrote $SUDOERS_FILE"

# --- systemd service -----------------------------------------------------
cp "$SERVICE_SRC" "$SERVICE_DST"
chmod 644 "$SERVICE_DST"
systemctl daemon-reload
systemctl enable smart-home-engine

echo ""
echo "Done. To start the service:"
echo "  systemctl start smart-home-engine"