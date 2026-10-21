#!/bin/bash
# Usage: storytold.sh <app>, e.g. photocraft, vectorcraft, wordcraft, deckcraft, gridcraft
# Installs or updates the app from its latest GitHub release (flatpak, matching this CPU)
set -e

APP=${1:?usage: storytold.sh <app>}
RELEASE=$(curl -fsSL "https://api.github.com/repos/storytold/$APP/releases/latest")
URL=$(grep -o "https://[^\"]*-linux-$(uname -m)\.flatpak" <<<"$RELEASE" | head -1)
[ -n "$URL" ] || { echo "No $APP flatpak for $(uname -m) in latest release" >&2; exit 1; }
TAG=$(grep -oP '"tag_name": *"v?\K[^"]+' <<<"$RELEASE")
INSTALLED=$(flatpak info "ai.storyteller.$APP" 2>/dev/null | sed -n 's/^ *Version: //p')

# Reinstalling the same version fails with "Directory not empty", so only install when the version changed
if [ "$INSTALLED" != "$TAG" ]; then
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT
    curl -fL -o "$TMP/$APP.flatpak" "$URL"
    flatpak install --user -y --reinstall "$TMP/$APP.flatpak"
fi

# Drop every sandbox permission except Wayland, the GPU and read-only ~/.fonts (the clipboard works without X11)
# Files stay reachable through the file chooser portal
# The app's own metadata lists what it asks for, so permissions added by future releases are dropped too
ARGS=()
while IFS='=' read -r KEY VALUES; do
    case $KEY in
        sockets) OPT=--nosocket KEEP=wayland ;;
        devices) OPT=--nodevice KEEP=dri ;;
        shared) OPT=--unshare KEEP= ;;
        filesystems) OPT=--nofilesystem KEEP='~/.fonts:ro' ;;
        features) OPT=--disallow KEEP= ;;
        *) continue ;;
    esac
    # ${V%:*} strips access suffixes like :ro, which --nofilesystem does not take
    for V in ${VALUES//;/ }; do [[ " $KEEP " == *" $V "* ]] || ARGS+=("$OPT=${V%:*}"); done
done < <(flatpak info -M "ai.storyteller.$APP")
[ ${#ARGS[@]} -eq 0 ] || flatpak override --user "${ARGS[@]}" "ai.storyteller.$APP"
