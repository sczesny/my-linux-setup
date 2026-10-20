import St from 'gi://St';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ShellMountOperation} from 'resource:///org/gnome/shell/ui/shellMountOperation.js';

Gio._promisify(Gio.Mount.prototype, 'eject_with_operation');
Gio._promisify(Gio.Mount.prototype, 'unmount_with_operation');

// Same filter as drive-menu@gnome-shell-extensions, minus its async filesystem::remote query for volume-less mounts
const removable = m => (m.can_eject() || m.can_unmount()) && !m.is_shadowed() &&
    (m.get_volume() ? m.get_volume().get_identifier('class') !== 'network' : m.get_root().is_native());

async function eject(m) {
    const args = [Gio.MountUnmountFlags.NONE, new ShellMountOperation(m).mountOp, null];
    try {
        await (m.can_eject() ? m.eject_with_operation(...args) : m.unmount_with_operation(...args));
    } catch (e) {
        Main.notifyError(`Ejecting drive “${m.get_name()}” failed:`, e.message);
    }
}

export default class DriveMenu {
    enable() {
        this._button = new PanelMenu.Button(0.5, 'Removable devices');
        // Square like the app indicator buttons: no theme side padding, width taken from the panel height
        this._button.add_child(new St.Icon({
            icon_name: 'media-eject-symbolic',
            style_class: 'system-status-icon',
            style: 'padding: 0; margin: 0;',
        }));
        this._button.width = Main.panel.get_preferred_height(-1)[1];
        this._button.style = '-natural-hpadding: 0; -minimum-hpadding: 0;';
        // Right before quick settings, so app indicators (always inserted at the box start) end up left of it
        const {_rightBox, statusArea: {quickSettings}} = Main.panel;
        Main.panel.addToStatusArea('removable-drive-menu', this._button,
            _rightBox.get_children().indexOf(quickSettings.container));

        this._monitor = Gio.VolumeMonitor.get();
        this._monitor.connectObject(
            'mount-added', () => this._sync(),
            'mount-removed', () => this._sync(),
            'mount-changed', () => this._sync(), this._button);
        this._sync();
    }

    disable() {
        this._button.destroy();
        this._button = this._monitor = null;
    }

    _sync() {
        const menu = this._button.menu;
        menu.removeAll();
        const mounts = this._monitor.get_mounts().filter(removable);
        this._button.visible = mounts.length > 0;

        for (const m of mounts) {
            const item = menu.addAction(m.get_name(), event => Gio.AppInfo.launch_default_for_uri(
                m.get_root().get_uri(), global.create_app_launch_context(event.get_time(), -1)));
            item.label.x_expand = true;
            const button = new St.Button({
                child: new St.Icon({icon_name: 'media-eject-symbolic', style_class: 'popup-menu-icon'}),
                style_class: 'button',
                style: 'border-radius: 99px; padding: 3px; min-height: auto;',
            });
            button.connect('clicked', () => eject(m));
            item.add_child(button);
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Open Files', event =>
            Shell.AppSystem.get_default().lookup_app('org.gnome.Nautilus.desktop')?.activate_full(-1, event.get_time()));
    }
}
