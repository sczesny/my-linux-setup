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
read -rp $'\e[1;34m::\e[0;1m Install Chrome and VSCode? [Y/n] \e[0m' REPLY

# Only step messages reach the terminal (fd 3); command output goes to a log that is printed if a step fails
LOG=$(mktemp)
exec 3>&1 >>"$LOG" 2>&1
trap 'if [ $? -ne 0 ]; then printf "\e[1;31merror:\e[0m step failed, output:\n" >&3; cat "$LOG" >&3; fi; rm -f "$LOG"' EXIT
# Clearing the log at each step keeps a failure's output to that step
step() { : >"$LOG"; printf '\e[1;34m::\e[0;1m %s\e[0m\n' "$*" >&3; }

# Fish gets removed with cachyos-fish-config, so switch to bash
if [ "$(getent passwd "$USER" | cut -d: -f7)" != "/bin/bash" ]; then
    step "Switching login shell to bash"
    sudo chsh -s /bin/bash "$USER"
fi

step "Configuring mkinitcpio and GRUB"
# Without this, mkinitcpio fails once plymouth is gone
sudo sed -i -E '/^HOOKS=/ s/ plymouth\b//' /etc/mkinitcpio.conf

if [ -f /etc/default/grub ]; then
    sudo sed -i -E 's/^GRUB_THEME=/#GRUB_THEME=/; /^GRUB_CMDLINE_LINUX_DEFAULT=/ s/ ?\bsplash\b//' /etc/default/grub
    # Hides the UEFI firmware boot entries CachyOS's 31_efi_bootnext adds to the menu
    if ! grep -q '^GRUB_DISABLE_BOOTNEXT=' /etc/default/grub; then
        echo 'GRUB_DISABLE_BOOTNEXT=true' | sudo tee -a /etc/default/grub >/dev/null
    fi
fi

step "Hiding v4l-utils launchers"
# v4l-utils is needed by ffmpeg and gstreamer, so only hide its Qt launchers (NoExtract keeps them gone after updates)
if ! grep -q 'qv4l2\.desktop' /etc/pacman.conf; then
    sudo sed -i '/^\[options\]/a NoExtract = usr/share/applications/qv4l2.desktop usr/share/applications/qvidcap.desktop' /etc/pacman.conf
fi
sudo rm -f /usr/share/applications/{qv4l2,qvidcap}.desktop

# Only remove what is actually installed (package sets differ between devices)
INSTALLED=$(pacman -Qq "${REMOVE[@]}" 2>/dev/null || true)
if [ -n "$INSTALLED" ]; then
    step "Removing unneeded packages"
    sudo pacman -Rns --noconfirm $INSTALLED
fi

step "Updating system"
sudo pacman -Syu --noconfirm

step "Installing yay"
# yay is in the CachyOS repo, so no AUR build is needed
sudo pacman -S --needed --noconfirm yay

if [[ ! "$REPLY" =~ ^[Nn] ]]; then
    step "Installing Chrome and VSCode"
    yay -S --needed --noconfirm google-chrome visual-studio-code-bin
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
gsettings set org.gnome.desktop.sound allow-volume-above-100-percent true
gsettings set org.gnome.desktop.sound event-sounds false
gsettings set org.gnome.shell.app-switcher current-workspace-only true
gsettings set org.gnome.desktop.interface enable-hot-corners false
gsettings set org.gnome.desktop.app-folders folder-children "[]"

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
alias sl="du -sh .[!.]* * 2>/dev/null | sort -hr"
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

if [ -n "$NEW_KEY" ]; then
    printf '\e[1;34m::\e[0;1m If you use GitHub, add this SSH key at \e[0;4;34mhttps://github.com/settings/keys\e[0m\n   \e[33m%s\e[0m\n' "$(cat ~/.ssh/id_rsa.pub)" >&3
fi
if [ -z "$(git config --global user.name)" ] || [ -z "$(git config --global user.email)" ]; then
    printf '\e[1;34m::\e[0;1m Set your git identity:\e[0m\n   \e[33mgit config --global user.email "you@example.com"\n   git config --global user.name "Your Name"\e[0m\n' >&3
fi
step "Done. Reboot to apply"
