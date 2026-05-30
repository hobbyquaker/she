#!/usr/bin/env bash
set -euo pipefail

REMOTE=root@she
REMOTE_DIR=/usr/local/lib/node_modules/smart-home-engine

echo "==> Packing..."
TARBALL=$(npm pack --quiet)
echo "    created $TARBALL"

echo "==> Copying to $REMOTE..."
scp "$TARBALL" "$REMOTE:/tmp/$TARBALL"

echo "==> Installing on remote..."
ssh "$REMOTE" bash -s -- "$TARBALL" "$REMOTE_DIR" <<'EOF'
    TARBALL=$1
    REMOTE_DIR=$2
    mkdir -p "$REMOTE_DIR"
    tar -xzf "/tmp/$TARBALL" --strip-components=1 -C "$REMOTE_DIR"
    rm -f "/tmp/$TARBALL"
    cd "$REMOTE_DIR"
    npm install --omit=dev --prefer-offline
    systemctl restart she
EOF

echo "==> Cleaning up local tarball..."
rm -f "$TARBALL"

echo "==> Done."
