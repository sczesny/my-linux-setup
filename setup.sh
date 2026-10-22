#!/bin/bash
set -e

REMOVE=(
    alacritty baobab file-roller firefox glances gnome-power-manager gnome-tweaks meld micro resources shelly vim
    cachy-update cachyos-fish-config cachyos-grub-theme cachyos-hello cachyos-kernel-manager
    cachyos-micro-settings cachyos-packageinstaller cachyos-plymouth-bootanimation
    cachyos-plymouth-theme cachyos-wallpapers cachyos-zsh-config
    plymouth malcontent realtime-privileges vlc-plugins-all
    dmraid lvm2 f2fs-tools jfsutils nilfs-utils xfsprogs
    efitools fsarchiver hdparm hwdetect lsscsi sg3_utils sysfsutils
    iwd netctl xl2tpd
)

fail() { printf '\e[1;31merror:\e[0m %s\n' "$*" >&2; exit 1; }
grep -qx 'ID=cachyos' /etc/os-release || fail "This script only runs on CachyOS"
pacman -Q gnome-shell >/dev/null 2>&1 || fail "GNOME is not installed"

# Ask everything up front, so the rest runs unattended
sudo -v
# Inline checklist, checked by default except UNCHECKED: arrows move, enter or space toggles, enter on <DONE> confirms
OPTIONAL=(google-chrome:"Google Chrome" brave-bin:"Brave" visual-studio-code-bin:"Visual Studio Code" npm:"Node.js + Npm" discord:"Discord" steam:"Steam" photocraft:"PhotoCraft" vectorcraft:"VectorCraft" wordcraft:"WordCraft" deckcraft:"DeckCraft" gridcraft:"GridCraft")
UNCHECKED=(brave-bin steam photocraft vectorcraft wordcraft deckcraft gridcraft)
# Flatpaks from github.com/storytold releases, installed by files/storytold.sh instead of yay
STORYTOLD=(photocraft vectorcraft wordcraft deckcraft gridcraft)
CHECKED=()
for i in "${!OPTIONAL[@]}"; do [[ " ${UNCHECKED[*]} " == *" ${OPTIONAL[i]%%:*} "* ]] || CHECKED[i]=x; done
DONE=${#OPTIONAL[@]} # index of the <DONE> row
CUR=$DONE # start on [CONTINUE], so enter accepts the defaults
printf '\e[1;34m::\e[0;1m Install packages:\e[0m\n'
while true; do
    for ((i = 0; i <= DONE; i++)); do
        if [ "$i" = "$CUR" ]; then printf ' \e[1;34m>\e[0m'; else printf '  '; fi
        if [ "$i" = "$DONE" ]; then printf ' (CONTINUE) '; else printf ' [%s] %s\n' "${CHECKED[i]:- }" "${OPTIONAL[i]#*:}"; fi
    done
    IFS= read -rsn1 KEY
    case $KEY in
        '' | ' ')
            [ "$CUR" = "$DONE" ] && break
            if [ -n "${CHECKED[CUR]}" ]; then CHECKED[CUR]=; else CHECKED[CUR]=x; fi ;;
        $'\e') read -rsn2 KEY
            case $KEY in
                '[A') CUR=$(( (CUR + DONE) % (DONE + 1) )) ;;
                '[B') CUR=$(( (CUR + 1) % (DONE + 1) )) ;;
            esac ;;
    esac
    # No newline after [DONE] keeps the cursor on that line; go back to the first row to redraw in place
    printf '\r\e[%dA' "$DONE"
done
echo
SELECTED=()
for i in "${!OPTIONAL[@]}"; do
    [ -n "${CHECKED[i]}" ] && SELECTED+=("${OPTIONAL[i]}")
done
if [ -f /etc/default/grub ]; then
    read -rp $'\e[1;34m::\e[0;1m Skip GRUB timeout? [Y/n] \e[0m' SKIP_GRUB_TIMEOUT
fi
read -rp $'\e[1;34m::\e[0;1m Install my fonts? (requires password) [y/N] \e[0m' INSTALL_FONTS
if [[ "$INSTALL_FONTS" =~ ^[Yy] ]]; then
    # Checked here, so a typo doesn't fail the unattended part later
    while :; do
        read -rsp $'\e[1;34m::\e[0;1m Type password: \e[0m' FONTS_PASSWORD; echo
        unzip -tqq -P "$FONTS_PASSWORD" "$(dirname "$0")/files/my-fonts.zip" >/dev/null 2>&1 && break
        printf '\e[1;31merror:\e[0m wrong password\n'
    done
fi

# Only step messages reach the terminal (fd 3); command output goes to a log that is printed if a step fails
LOG=$(mktemp)
exec 3>&1 >>"$LOG" 2>&1
trap 'STATUS=$?; spin_stop; if [ $STATUS -ne 0 ]; then printf "\e[1;31merror:\e[0m step failed, output:\n" >&3; cat "$LOG" >&3; fi; rm -f "$LOG"' EXIT
# Clearing the log at each step keeps a failure's output to that step
# A spinner (plus a space, so the cursor does not cover it) after the step message shows the step is still running; the next step or exit stops it
SPIN=
spin_stop() {
    [ -z "$SPIN" ] && return
    kill "$SPIN"
    wait "$SPIN" 2>/dev/null || true
    SPIN=
    printf '\b\b  \n' >&3
}
step() {
    spin_stop
    : >"$LOG"
    printf '\e[1;34m::\e[0;1m %s\e[0m   ' "$*" >&3
    while :; do for C in ⠖ ⠲ ⢲ ⢰ ⣰ ⣠ ⣄ ⣆ ⡆ ⡖; do printf '\b\b%s ' "$C" >&3; sleep 0.1; done; done &
    SPIN=$!
}

# Fish gets removed with cachyos-fish-config, so switch to bash
if [ "$(getent passwd "$USER" | cut -d: -f7)" != "/bin/bash" ]; then
    step "Switching login shell to bash"
    sudo chsh -s /bin/bash "$USER"
fi

step "Configuring mkinitcpio and GRUB"
# Without this, mkinitcpio fails once plymouth is gone
sudo sed -i -E '/^HOOKS=/ s/ plymouth\b//' /etc/mkinitcpio.conf

sudo tee /etc/initcpio/install/hide-initrd-status >/dev/null <<'EOF'
#!/bin/bash
build() {
    printf '[Manager]\nShowStatus=auto\n' | add_file - /etc/systemd/system.conf.d/hide-status.conf 644
}
EOF
sudo sed -i -E '/^HOOKS=/ { /\bhide-initrd-status\b/! s/\)/ hide-initrd-status)/ }' /etc/mkinitcpio.conf

if [ -f /etc/default/grub ]; then
    sudo sed -i -E 's/^GRUB_THEME=/#GRUB_THEME=/; /^GRUB_CMDLINE_LINUX_DEFAULT=/ s/ ?\bsplash\b//' /etc/default/grub
    if ! grep -q '^GRUB_DISABLE_BOOTNEXT=' /etc/default/grub; then
        echo 'GRUB_DISABLE_BOOTNEXT=true' | sudo tee -a /etc/default/grub >/dev/null
    fi
    grub_set() {
        if grep -qE "^#?$1=" /etc/default/grub; then
            sudo sed -i -E "s/^#?$1=.*/$1=$2/" /etc/default/grub
        else
            echo "$1=$2" | sudo tee -a /etc/default/grub >/dev/null
        fi
    }
    grub_set GRUB_DISTRIBUTOR "'Linux'"
    grub_set GRUB_GFXMODE 1920x1080
    if [[ ! "$SKIP_GRUB_TIMEOUT" =~ ^[Nn] ]]; then
        grub_set GRUB_TIMEOUT 0
        grub_set GRUB_TIMEOUT_STYLE hidden
    fi
fi

step "Removing CachyOS branding"
sudo sed -i -E 's/^(NAME|PRETTY_NAME)=.*/\1="Linux"/; /^(LOGO|ANSI_COLOR)=/d' /etc/os-release

step "Hiding v4l-utils and hwloc launchers"
# v4l-utils is needed by ffmpeg and gstreamer, hwloc by flatpak, so only hide their launchers (NoExtract keeps them gone after updates)
if ! grep -q 'lstopo\.desktop' /etc/pacman.conf; then
    sudo sed -i '/^\[options\]/a NoExtract = usr/share/applications/qv4l2.desktop usr/share/applications/qvidcap.desktop usr/share/applications/lstopo.desktop' /etc/pacman.conf
fi
sudo rm -f /usr/share/applications/{qv4l2,qvidcap,lstopo}.desktop

# Only remove what is actually installed (package sets differ between devices)
INSTALLED=$(pacman -Qq "${REMOVE[@]}" 2>/dev/null || true)
if [ -n "$INSTALLED" ]; then
    step "Removing unneeded packages"
    sudo pacman -Rns --noconfirm $INSTALLED
fi

step "Disabling unneeded services"
# wait-online only delays boot; avahi is unused without CUPS and without mdns in nsswitch.conf
sudo systemctl disable --now NetworkManager-wait-online.service avahi-daemon.service avahi-daemon.socket

step "Updating system"
sudo pacman -Syu --noconfirm

step "Installing yay and flatpak"
# Both are in the repos, so no AUR build is needed (flatpak ships with the Flathub remote)
sudo pacman -S --needed --noconfirm yay flatpak

# One step per package, so the terminal shows which one is installing
for ITEM in "${SELECTED[@]}"; do
    step "Installing ${ITEM#*:}"
    if [[ " ${STORYTOLD[*]} " == *" ${ITEM%%:*} "* ]]; then
        "$(dirname "$0")/files/storytold.sh" "${ITEM%%:*}"
    else
        yay -S --needed --noconfirm "${ITEM%%:*}"
    fi
done

if [[ "$INSTALL_FONTS" =~ ^[Yy] ]]; then
    step "Installing my fonts"
    # The fonts are packed into one tar inside the zip, so listing the zip doesn't show their names
    mkdir -p ~/.local/share/fonts/my-fonts
    unzip -p -P "$FONTS_PASSWORD" "$(dirname "$0")/files/my-fonts.zip" fonts.tar | tar -x -C ~/.local/share/fonts/my-fonts
    fc-cache -f
fi

step "Setting wallpaper and login screen"
# The default wallpapers are gone, so make plain black the system default instead of GNOME's blue fallback
# The login-screen logo beats CachyOS's override (loaded later by name) and, unlike editing that file, survives cachyos-settings updates
sudo tee /usr/share/glib-2.0/schemas/zz_device-setup.gschema.override >/dev/null <<'EOF'
[org.gnome.desktop.background]
picture-uri=''
picture-uri-dark=''
primary-color='#000000'
color-shading-type='solid'

[org.gnome.login-screen]
logo=''
EOF
sudo glib-compile-schemas /usr/share/glib-2.0/schemas

# Keep a custom wallpaper, otherwise (none set or file removed) use files/background.png
# Copied out of the repo so the wallpaper survives moving or deleting it
WALLPAPER=$(gsettings get org.gnome.desktop.background picture-uri | tr -d "'")
if [ -z "$WALLPAPER" ] || ! gio info "$WALLPAPER" >/dev/null 2>&1; then
    gsettings reset-recursively org.gnome.desktop.background
    BACKGROUND="$HOME/.local/share/backgrounds/background.png"
    install -Dm644 "$(dirname "$0")/files/background.png" "$BACKGROUND"
    gsettings set org.gnome.desktop.background picture-uri "file://$BACKGROUND"
    gsettings set org.gnome.desktop.background picture-uri-dark "file://$BACKGROUND"
fi

step "Rebuilding initramfs and GRUB config"
sudo mkinitcpio -P
[ -f /etc/default/grub ] && sudo grub-mkconfig -o /boot/grub/grub.cfg

step "Applying GNOME settings and shortcuts"
gsettings set org.gnome.desktop.peripherals.touchpad click-method 'areas'
gsettings set org.gnome.SessionManager logout-prompt false
gsettings set org.gnome.desktop.interface show-battery-percentage true
gsettings set org.gnome.desktop.interface clock-format '24h'
gsettings set org.gnome.desktop.datetime automatic-timezone true
gsettings set org.gnome.shell.keybindings toggle-message-tray "['<Shift><Super>v', '<Super>m']"
gsettings set org.gnome.desktop.wm.keybindings close "['<Shift><Super>x']"
gsettings set org.gnome.shell.keybindings show-screenshot-ui "['<Shift><Super>s']"
gsettings set org.gnome.desktop.sound event-sounds false
gsettings set org.gnome.shell.app-switcher current-workspace-only true
gsettings set org.gnome.desktop.interface enable-hot-corners false
gsettings set org.gnome.desktop.app-folders folder-children "['System']"
FOLDER_SCHEMA=org.gnome.desktop.app-folders.folder:/org/gnome/desktop/app-folders/folders/System/
gsettings set "$FOLDER_SCHEMA" name 'System'
gsettings set "$FOLDER_SCHEMA" apps "['org.gnome.Calculator.desktop', 'org.gnome.DiskUtility.desktop', 'btop.desktop', 'org.pulseaudio.pavucontrol.desktop', 'org.gnome.Snapshot.desktop', 'org.gnome.Decibels.desktop', 'org.gnome.Software.desktop', 'org.gnome.SimpleScan.desktop', 'org.gnome.Papers.desktop', 'org.gnome.Loupe.desktop', 'org.gnome.Showtime.desktop']"
gsettings reset org.gnome.shell app-picker-layout

# Appended to the list so other custom shortcuts are kept
KB=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/terminal/
KBS=$(gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings)
if [[ "$KBS" != *"'$KB'"* ]]; then
    if [ "$KBS" = "@as []" ]; then KBS="['$KB']"; else KBS="${KBS%]}, '$KB']"; fi
    gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "$KBS"
fi
KB_SCHEMA=org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:$KB
gsettings set "$KB_SCHEMA" name 'Terminal'
gsettings set "$KB_SCHEMA" command 'ptyxis --new-window'
gsettings set "$KB_SCHEMA" binding '<Super>t'

gsettings set org.gnome.settings-daemon.plugins.media-keys home "['<Super>e']"
gsettings set org.gnome.settings-daemon.plugins.media-keys www "['<Super>b']"

# Rename apps and replace their icons with files/<icon>.svg: btop looks like GNOME Resources, Ptyxis like GNOME Terminal
# A launcher in ~/.local/share/applications overrides the system one
# Translated names (Name[en_GB]=...) are dropped from the main section so the new name shows in every language
for APP in btop:btop:Resources org.gnome.Ptyxis:ptyxis:Terminal; do
    IFS=: read -r ID ICON_NAME NAME <<<"$APP"
    DESKTOP=/usr/share/applications/$ID.desktop
    ICON=$HOME/.local/share/icons/$ICON_NAME.svg
    if [ -f "$DESKTOP" ]; then
        install -Dm644 "$(dirname "$0")/files/$ICON_NAME.svg" "$ICON"
        mkdir -p ~/.local/share/applications
        sed -E "s|^Icon=.*|Icon=$ICON|; /^\[Desktop Entry\]/,/^\[Desktop Action/{/^Name\[/d; s|^Name=.*|Name=$NAME|}" \
            "$DESKTOP" > ~/.local/share/applications/"$ID".desktop
    fi
done

# btop leaves the background to the terminal; its own truecolor background shows darker than the same color in Ptyxis
# Only this key is replaced so other btop settings survive re-runs
mkdir -p ~/.config/btop
touch ~/.config/btop/btop.conf
sed -i '/^theme_background = /d' ~/.config/btop/btop.conf
echo 'theme_background = false' >> ~/.config/btop/btop.conf

# The marker line keeps re-runs from appending the block twice
if ! grep -qs '^# my-linux-setup$' ~/.bashrc; then
    step "Adding shell config to ~/.bashrc"
    cat >> ~/.bashrc <<'EOF'

# my-linux-setup
export PATH=$PATH:~/.node/bin
export PATH=$PATH:~/.local/bin

PROMPT_PREFIX='' # '\u@\h:'
export PROMPT_DIRTRIM=2 PS1='\[\033[1;34m\]${PROMPT_PREFIX@P}$(d="\w"; d="${d@P}"; echo -n "${d/...\//…/}")\[\033[0m\]\$ '
_tilde_prep_once() { :; }

alias ll="ls -alh"
sl() { if [ $# -le 1 ] && [ -d "${1:-.}" ]; then (cd "${1:-.}" && du -sh .[!.]* * 2>/dev/null | sort -hr); else du -sh "$@" | sort -hr; fi; }
EOF
fi

step "Lowercasing home dirs"
# Empty ones are removed, apps recreate them when needed
[ -f ~/.config/user-dirs.dirs ] || xdg-user-dirs-update
grep -oP '^XDG_\w+_DIR="\$HOME/\K[^"]+' ~/.config/user-dirs.dirs | while read -r DIR; do
    if [ -d "$HOME/$DIR" ] && [ ! -e "$HOME/${DIR,,}" ]; then
        mv "$HOME/$DIR" "$HOME/${DIR,,}"
    fi
    if [ -d "$HOME/${DIR,,}" ]; then
        rmdir --ignore-fail-on-non-empty "$HOME/${DIR,,}"
    fi
done
sed -i -E 's|^(XDG_\w+_DIR="\$HOME/)([^"]+)"|\1\L\2"|' ~/.config/user-dirs.dirs
# Stops xdg-user-dirs-update from recreating the capitalized dirs at login
echo 'enabled=False' > ~/.config/user-dirs.conf
mkdir -p ~/.config/gtk-3.0
cat > ~/.config/gtk-3.0/bookmarks <<EOF
file://$HOME/downloads
file://$HOME/documents
file://$HOME/pictures
file://$HOME/videos
EOF

step "Configuring git"
git config --global pull.rebase merges
git config --global rerere.enabled true
git config --global rerere.autoupdate true

if [ ! -f ~/.ssh/id_rsa ]; then
    step "Creating SSH key"
    mkdir -p -m 700 ~/.ssh
    ssh-keygen -t ed25519 -f ~/.ssh/id_rsa -P ""
    NEW_KEY=1
fi
# ssh-keygen already sets 600; this fixes a key copied in from elsewhere, which ssh refuses if others can read it
chmod 600 ~/.ssh/id_rsa

if [ ! -f ~/.ssh/config ]; then
    step "Creating SSH config"
    cat > ~/.ssh/config <<'EOF'
Host *
    StrictHostKeyChecking accept-new
    LogLevel ERROR

Host github.com
    User git
    HostName github.com
    PreferredAuthentications publickey
    IdentityFile ~/.ssh/id_rsa
EOF
fi

step "Installing GNOME extension"
source "$(dirname "$0")/extension/install.sh" --first-install
spin_stop

if [ -n "$NEW_KEY" ]; then
    printf '\e[1;34m::\e[0;1m If you use GitHub, add this SSH key at \e[0;4;34mhttps://github.com/settings/keys\e[0m\n   \e[33m%s\e[0m\n' "$(cat ~/.ssh/id_rsa.pub)" >&3
fi
if [ -z "$(git config --global user.name)" ] || [ -z "$(git config --global user.email)" ]; then
    printf '\e[1;34m::\e[0;1m Set your git identity:\e[0m\n   \e[33mgit config --global user.email "you@example.com"\n   git config --global user.name "Your Name"\e[0m\n' >&3
fi
step "Done. Reboot to apply"
