#!/bin/sh
# Entrypoint for the PizzaPi runner image.
#
# When started as root (e.g. `user: "0:0"` or PUID/PGID set), remaps the
# baked-in `pizza` user (uid/gid 1000) to the target ids instead of relying
# on a raw `user:` override. A raw override leaves no /etc/passwd entry for
# the running uid, which breaks git and shells (see runner-container-spike.md
# fact #5) — remapping the real `pizza` account keeps that entry intact.
# The daemon itself never runs as root.
set -e

log() {
    echo "[entrypoint] $*" >&2
}

CURRENT_UID=$(id -u)

if [ "$CURRENT_UID" = "0" ]; then
    TARGET_UID="${PUID:-1000}"
    TARGET_GID="${PGID:-1000}"
    PIZZA_UID=$(id -u pizza)
    PIZZA_GID=$(id -g pizza)

    if [ "$TARGET_UID" != "$PIZZA_UID" ] || [ "$TARGET_GID" != "$PIZZA_GID" ]; then
        [ "$TARGET_GID" != "$PIZZA_GID" ] && groupmod -o -g "$TARGET_GID" pizza
        usermod -o -u "$TARGET_UID" -g "$TARGET_GID" pizza
    fi

    for dir in "$HOME" "$HOME/.pizzapi"; do
        if [ -d "$dir" ]; then
            owner_uid=$(stat -c '%u' "$dir")
            [ "$owner_uid" != "$TARGET_UID" ] && chown "$TARGET_UID:$TARGET_GID" "$dir"
        fi
    done

    if [ "${PIZZAPI_CHOWN_WORKSPACE:-0}" = "1" ] && [ -n "${PIZZAPI_WORKSPACE_ROOTS:-}" ]; then
        old_ifs=$IFS
        IFS=,
        for root in $PIZZAPI_WORKSPACE_ROOTS; do
            [ -d "$root" ] && chown -R "$TARGET_UID:$TARGET_GID" "$root"
        done
        IFS=$old_ifs
    fi

    log "starting as uid=$TARGET_UID gid=$TARGET_GID (remapped from root), sandbox=${PIZZAPI_SANDBOX:-none}"
    exec setpriv --reuid="$TARGET_UID" --regid="$TARGET_GID" --init-groups tini -- pizza "$@"
fi

# Already non-root (the default — no PUID/PGID handling needed or possible).
if [ ! -d "$HOME/.pizzapi" ]; then
    log "WARNING: $HOME/.pizzapi does not exist — runner state cannot persist"
elif [ ! -w "$HOME/.pizzapi" ]; then
    log "WARNING: $HOME/.pizzapi is not writable by uid $CURRENT_UID — runner state cannot persist"
fi

log "starting as uid=$CURRENT_UID gid=$(id -g), sandbox=${PIZZAPI_SANDBOX:-none}"
exec tini -- pizza "$@"
