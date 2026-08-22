#!/bin/sh
# Fake ssh/scp for unit tests (I5 ssh driver).
#   as ssh (any name without "scp"): skips option flags, takes the target, runs the command
#           locally with sh -c, stdin passed through; records "ssh <target> <cmd>" in $FAKE_SSH_LOG.
#           FAKE_SSH_FAIL=1 → exit 255 like an unreachable host.
#           A command starting with "sudo -n install" is simulated: copies the uploaded file to
#           $FAKE_HELPER_TARGET, or fails like sudo without a rule when FAKE_SUDO_FAIL=1.
#   as scp (name contains "scp"): copies <local> to the path after the colon; a relative remote
#           path lands in $FAKE_HOME.
set -e
case "$(basename "$0")" in
    *scp*)
        while [ $# -gt 2 ]; do shift; done
        local=$1; remote=${2#*:}
        case "$remote" in /*) ;; *) remote="${FAKE_HOME:-/tmp}/$remote" ;; esac
        cp "$local" "$remote"
        [ -n "${FAKE_SSH_LOG:-}" ] && printf 'scp %s %s\n' "$local" "$remote" >> "$FAKE_SSH_LOG"
        exit 0 ;;
esac
while [ $# -gt 0 ]; do
    case "$1" in
        -i|-o|-p) shift 2 ;;
        *) break ;;
    esac
done
target=$1; shift
cmd=$1
[ -n "${FAKE_SSH_LOG:-}" ] && printf 'ssh %s %s\n' "$target" "$cmd" >> "$FAKE_SSH_LOG"
if [ "${FAKE_SSH_FAIL:-}" = "1" ]; then
    echo "ssh: connect to host ${target#*@} port 22: Connection refused" >&2
    exit 255
fi
case "$cmd" in
    "sudo -n install"*)
        if [ "${FAKE_SUDO_FAIL:-}" = "1" ]; then
            echo "sudo: a password is required" >&2
            exit 1
        fi
        cp "${FAKE_HOME:-/tmp}/she-servicectl.tmp" "${FAKE_HELPER_TARGET:?}"
        chmod 755 "$FAKE_HELPER_TARGET"
        rm -f "${FAKE_HOME:-/tmp}/she-servicectl.tmp"
        exit 0 ;;
esac
exec sh -c "$cmd"
