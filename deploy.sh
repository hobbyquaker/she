#!/usr/bin/env bash
set -euo pipefail

# Build, pack and deploy she to a remote host, then restart the service.
# Works from macOS and from WSL.
#
# Usage:
#   bash deploy.sh                  # deploys to root@she-dev
#   bash deploy.sh user@host
#
# Optional env vars:
#   REMOTE_DIR  (default: /usr/local/lib/node_modules/smart-home-engine)
#   SSH_KEY     (default: ~/.ssh/id_ed25519) — loaded into an agent when needed
#   SKIP_BUILD  set to 1 to skip `npm run build:web`

REMOTE="${1:-root@she-dev}"
REMOTE_DIR="${REMOTE_DIR:-/usr/local/lib/node_modules/smart-home-engine}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"

for cmd in npm ssh scp; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "error: required command '$cmd' not found" >&2; exit 1; }
done

# Make the SSH key available without a passphrase prompt per connection:
#  - WSL/Linux with keychain installed: keychain starts/reuses an agent across shells
#  - macOS: the system agent is already there; load the key if the agent has none
#    (a passphrase stored in the login keychain is picked up by --apple-load-keychain)
#  - otherwise: rely on the running agent / ~/.ssh/config
load_ssh_key() {
    [[ -f "$SSH_KEY" ]] || return 0
    if command -v keychain >/dev/null 2>&1; then
        keychain -q --nogui "$SSH_KEY"
        # shellcheck disable=SC1090
        source "$HOME/.keychain/$(hostname)-sh"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
        if ! ssh-add -l >/dev/null 2>&1; then
            ssh-add --apple-load-keychain 2>/dev/null || ssh-add "$SSH_KEY"
        fi
    fi
}

cd "$(dirname "$0")"

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
    echo "==> Building web frontend..."
    npm run build:web
fi

echo "==> Packing..."
# --ignore-scripts keeps the `prepare` hook's output out of the tarball name
TARBALL=$(npm pack --quiet --ignore-scripts 2>/dev/null | tail -n 1)
trap 'rm -f "$TARBALL"' EXIT
echo "    created $TARBALL"

load_ssh_key

echo "==> Copying to $REMOTE..."
scp "$TARBALL" package-lock.json "$REMOTE:/tmp/"

echo "==> Installing on remote..."
ssh "$REMOTE" bash -s -- "$TARBALL" "$REMOTE_DIR" <<'EOF'
    set -euo pipefail
    TARBALL=$1
    REMOTE_DIR=$2
    mkdir -p "$REMOTE_DIR"
    tar -xzf "/tmp/$TARBALL" --strip-components=1 -C "$REMOTE_DIR"
    cp /tmp/package-lock.json "$REMOTE_DIR/"
    # npm pack copies the local file modes — make sure the bin entry stays executable
    chmod 755 "$REMOTE_DIR/src/index.js"
    rm -f "/tmp/$TARBALL" /tmp/package-lock.json
    cd "$REMOTE_DIR"
    npm ci --omit=dev
    # the Services helper + sudoers line (roadmap I4) — install.sh is idempotent
    if [[ -f service/install.sh && $(id -u) -eq 0 ]]; then
        bash service/install.sh >/dev/null && echo "    service/install.sh ok (helper + sudoers refreshed)"
    fi
    systemctl restart smart-home-engine
EOF

echo "==> Done."
