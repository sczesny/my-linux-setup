import Gio from 'gi://Gio';
import Gvc from 'gi://Gvc';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHORTCUT = '<Control><Super>v';
const ICON_SIZE = 24;

export default class AudioOutput {
    enable() {
        // Own control so output-added fires for every device on open (the shell's shared one already has)
        this._outputs = new Set();
        this._control = new Gvc.MixerControl({name: 'Audio Output Switcher'});
        this._control.connect('output-added', (_, id) => this._outputs.add(id));
        this._control.connect('output-removed', (_, id) => this._outputs.delete(id));
        this._control.open();

        this._action = global.display.grab_accelerator(SHORTCUT, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT);
        this._actionName = Meta.external_binding_name_for_action(this._action);
        Main.wm.allowKeybinding(this._actionName, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._accelId = global.display.connect('accelerator-activated', (_, action) => {
            if (action === this._action) this._next();
        });
    }

    disable() {
        global.display.disconnect(this._accelId);
        global.display.ungrab_accelerator(this._action);
        Main.wm.allowKeybinding(this._actionName, Shell.ActionMode.NONE);
        this._control.close();
        this._control = this._outputs = null;
    }

    _next() {
        const ids = [...this._outputs].sort((a, b) => a - b);
        if (!ids.length) return;
        const sink = this._control.get_default_sink();
        const current = sink ? this._control.lookup_device_from_stream(sink)?.get_id() : undefined;
        const device = this._control.lookup_output_id(ids[(ids.indexOf(current) + 1) % ids.length]);
        this._control.change_output(device);

        // Same icon as the quick settings output menu, which renders it symbolic via CSS; the OSD doesn't, so drop the color names
        const icon = new Gio.ThemedIcon({names: device.get_gicon().get_names().filter(n => n.endsWith('-symbolic'))});
        const label = device.get_origin() ? `${device.get_description()} – ${device.get_origin()}` : device.get_description();
        const osd = Main.osdWindowManager;
        osd.showAll ? osd.showAll(icon, label) : osd.show(-1, icon, label); // showAll is GNOME 47+

        // Shrink only our OSD (theme default is 32px); restore once another OSD sets its icon
        for (const {_icon: stIcon} of osd._osdWindows) {
            stIcon.icon_size = ICON_SIZE;
            const id = stIcon.connect('notify::gicon', () => {
                stIcon.disconnect(id);
                stIcon.icon_size = -1;
            });
        }
    }
}
