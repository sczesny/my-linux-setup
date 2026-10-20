import St from 'gi://St';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Background from 'resource:///org/gnome/shell/ui/background.js';

// Same knobs as the lock screen blur in unlockDialog.js
const RADIUS = 60;
const BRIGHTNESS = 0.6;

const makeBlur = mode => new Shell.BlurEffect({
    mode,
    brightness: BRIGHTNESS,
    radius: RADIUS * St.ThemeContext.get_for_stage(global.stage).scale_factor,
});

// Blurred wallpaper behind the overview instead of the flat background color, built like the lock screen's
function blurOverview() {
    const group = new St.Widget();
    Main.layoutManager.overviewGroup.insert_child_at_index(group, 0);
    let bgManagers = [];
    const build = () => {
        bgManagers.forEach(m => m.destroy());
        group.destroy_all_children();
        bgManagers = Main.layoutManager.monitors.map((monitor, monitorIndex) => {
            const widget = new St.Widget({
                x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
                effect: makeBlur(Shell.BlurMode.ACTOR),
            });
            group.add_child(widget);
            return new Background.BackgroundManager({container: widget, monitorIndex, controlPosition: false});
        });
    };
    Main.layoutManager.connectObject('monitors-changed', build, group);
    build();
    return () => {
        bgManagers.forEach(m => m.destroy());
        group.destroy();
    };
}

// Live blur of whatever is behind the panel. Only shows in the overview: outside it the theme panel is opaque black.
// No inline tint: the overview owns Main.panel.style for its fade and clears it on every show/hide.
function blurPanel() {
    Main.panel.add_effect_with_name('blur', makeBlur(Shell.BlurMode.BACKGROUND));
    return () => Main.panel.remove_effect_by_name('blur');
}

export default class Blur {
    enable() {
        this._undo = [blurOverview(), blurPanel()];
    }

    disable() {
        this._undo.reverse().forEach(undo => undo());
        this._undo = null;
    }
}
