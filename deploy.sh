#!/usr/bin/env bash
set -euo pipefail

REMOTE=root@she
REMOTE_DIR=/usr/local/lib/node_modules/smart-home-engine

echo "==> Building web frontend..."
npm run build:web

echo "==> Packing..."
TARBALL=$(npm pack --quiet)
echo "    created $TARBALL"

echo "==> Copying to $REMOTE..."
/usr/bin/keychain -q --nogui ~/.ssh/id_ed25519; source ~/.keychain/infinite-sh; scp "$TARBALL" package-lock.json "$REMOTE:/tmp/"

echo "==> Installing on remote..."
/usr/bin/keychain -q --nogui ~/.ssh/id_ed25519; source ~/.keychain/infinite-sh; ssh "$REMOTE" bash -s -- "$TARBALL" "$REMOTE_DIR" <<'EOF'
    TARBALL=$1
    REMOTE_DIR=$2
    mkdir -p "$REMOTE_DIR"
    tar -xzf "/tmp/$TARBALL" --strip-components=1 -C "$REMOTE_DIR"
    cp /tmp/package-lock.json "$REMOTE_DIR/"
    rm -f "/tmp/$TARBALL" /tmp/package-lock.json
    cd "$REMOTE_DIR"
    npm ci --omit=dev

    # Migrate ~/.she to new subfolder layout (idempotent)
    SHE_DIR="$HOME/.she"
    if [ -d "$SHE_DIR" ]; then
        echo "==> Migrating $SHE_DIR to new subfolder layout..."
        mkdir -p "$SHE_DIR/config" "$SHE_DIR/scripts" "$SHE_DIR/db"

        # Move config.json -> config/config.json
        if [ -f "$SHE_DIR/config.json" ] && [ ! -f "$SHE_DIR/config/config.json" ]; then
            echo "    Moving config.json -> config/config.json"
            mv "$SHE_DIR/config.json" "$SHE_DIR/config/config.json"
        fi

        # Move *.js script files -> scripts/
        for f in "$SHE_DIR"/*.js; do
            [ -f "$f" ] || continue
            echo "    Moving $(basename "$f") -> scripts/"
            mv "$f" "$SHE_DIR/scripts/"
        done
    fi

    #systemctl restart smart-home-engine
EOF

echo "==> Cleaning up local tarball..."
rm -f "$TARBALL"

echo "==> Done."
