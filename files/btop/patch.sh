#!/bin/bash
# Usage: patch.sh [binary], default /usr/bin/btop; needs root for the installed one
# Swaps btop's box title brackets for half lines: ─╴cpu╶─ instead of ─┐cpu┌─
# Run by btop-titles.hook after every btop install or upgrade, so the change survives updates
# Each bracket is its own NUL-terminated string in the binary, and the half lines are also 3 bytes, so they swap in place
# The square box corners use the same strings and change too, but those are only drawn with rounded_corners = false or in TTY mode
set -e

BTOP=${1:-/usr/bin/btop}
# sed -i writes a new file, which drops btop's capabilities (used to read other users' processes), so they're restored after
CAPS=$(getcap "$BTOP" | cut -d' ' -f2)
# ┐ ┘ become ╴, ┌ └ become ╶
LC_ALL=C sed -i -E \
    -e 's/\x00\xe2\x94(\x90|\x98)\x00/\x00\xe2\x95\xb4\x00/g' \
    -e 's/\x00\xe2\x94(\x8c|\x94)\x00/\x00\xe2\x95\xb6\x00/g' "$BTOP"
[ -z "$CAPS" ] || setcap "$CAPS" "$BTOP"
# A btop release that stores these strings differently leaves nothing to swap
if ! LC_ALL=C grep -qaP '\x00\xe2\x95\xb4\x00' "$BTOP"; then
    echo "btop's title brackets not found, files/btop/patch.sh needs updating" >&2
    exit 1
fi
