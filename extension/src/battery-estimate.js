import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import UPower from 'gi://UPowerGlib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Seconds between power draw samples, and how many samples the average spans (10 minutes)
const INTERVAL = 30;
const SAMPLES = 20;

// Remaining battery time next to the battery icon while discharging, e.g. "5h" or "40m". Energy left divided by
// the average power draw over the last few minutes, so short load spikes don't make the estimate jump.
export default class BatteryEstimate {
    enable() {
        const {_system} = Main.panel.statusArea.quickSettings;
        this._proxy = _system._systemItem.powerToggle._proxy;
        // Adwaita Sans leaves descender room below the text, so it sits high; nudge it down like the system monitor.
        // The stock percentage label has the same problem, and both have to match.
        this._percentage = _system._percentageLabel;
        this._percentage.style = 'padding-top: 0.1em;';
        this._label = new St.Label({y_expand: true, y_align: Clutter.ActorAlign.CENTER, style: 'padding-top: 0.1em;'});
        _system.add_child(this._label);
        this._rates = [];
        // UPower only notifies on changes, so sample on a timer to weight each rate by how long it lasted
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVAL, () => {
            this._sample();
            return GLib.SOURCE_CONTINUE;
        });
        this._id = this._proxy.connect('g-properties-changed', () => this._sync());
        this._sample();
    }

    // The shell's proxy interface leaves out the energy properties, but the proxy still caches them
    _get(name) {
        return this._proxy.get_cached_property(name)?.unpack() ?? 0;
    }

    _sample() {
        const rate = this._get('EnergyRate');
        if (this._proxy.State === UPower.DeviceState.DISCHARGING && rate > 0)
            this._rates = [...this._rates, rate].slice(-SAMPLES);
        this._sync();
    }

    _sync() {
        // Start over after charging, the old draw says nothing about the new discharge
        if (this._proxy.State !== UPower.DeviceState.DISCHARGING)
            this._rates = [];
        const rate = this._rates.reduce((a, b) => a + b, 0) / this._rates.length;
        const secs = this._get('Energy') / rate * 3600;
        this._label.visible = this._rates.length > 0;
        this._label.text = secs >= 3600 ? ` ${Math.round(secs / 3600)}h` : ` ${Math.round(secs / 60)}m`;
    }

    disable() {
        GLib.source_remove(this._timer);
        this._proxy.disconnect(this._id);
        this._label.destroy();
        this._percentage.style = null;
        this._proxy = this._percentage = this._label = this._rates = null;
    }
}
