#!/bin/bash
set -e

# Usage: install.sh [--first-install]
# --first-install: only marks the extension enabled, GNOME Shell loads it at the next login (used by setup.sh)
# Without it the running GNOME Shell reloads the extension (for development)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["uuid"])' "$SCRIPT_DIR/metadata.json")
INSTALL_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
RAPL_RULE="/etc/udev/rules.d/99-rapl.rules"

if [ ! -f "$RAPL_RULE" ]; then
    echo 'SUBSYSTEM=="powercap", KERNEL=="intel-rapl:0", RUN+="/bin/chmod a+r %S%p/energy_uj"' \
        | sudo tee "$RAPL_RULE" > /dev/null
    sudo udevadm trigger --subsystem-match=powercap
    echo "RAPL energy counter is now readable."
fi

if [ "$1" != --first-install ]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
fi
rm -rf "$INSTALL_DIR"
sleep 0.5

# Copied, not symlinked, so the extension survives moving or deleting the repo
mkdir -p "$INSTALL_DIR"
cp -r "$SCRIPT_DIR/." "$INSTALL_DIR"

if [ "$1" = --first-install ]; then
    # GNOME Shell only sees a new extension after the next login, so add it to the enabled list directly
    EXTS=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ "$EXTS" != *"'$UUID'"* ]]; then
        if [ "$EXTS" = "@as []" ]; then EXTS="['$UUID']"; else EXTS="${EXTS%]}, '$UUID']"; fi
        gsettings set org.gnome.shell enabled-extensions "$EXTS"
    fi
    echo "Installed $UUID, it loads at the next login"
else
    sleep 1

    if gnome-extensions enable "$UUID" 2>/dev/null; then
        echo "Reloaded $UUID"
    else
        echo ""
        echo "Extension not yet known to GNOME Shell (first run only)."
        echo "Open Looking Glass and paste this in the Evaluator:"
        echo ""
        echo "  Copy 'Main.extensionManager._loadExtensions()'"
        echo "  Alt+F2 -> lg -> Enter -> Paste -> Enter"
        echo ""
        read -p "Press Enter here when done..."
        gnome-extensions enable "$UUID"
        echo "Loaded $UUID"
    fi
fi
