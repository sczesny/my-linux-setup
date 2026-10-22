import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

// Recolor the theme's warning color (#e66100) on the microphone/camera/location icons and the screen sharing pill.
// The theme repeats these rules with more specific selectors for the overview and lock screen, so !important
// lets short selectors win everywhere; the pseudo-class rules stay more specific, so hover shades still apply.
const COLOR = '#ffffff'; // #45a366
const SHARING_FG_COLOR = '#000000'; // icon and label on the screen sharing pill

// Pill states fade COLOR (#rrggbb only) toward the panel background instead of using fixed shades
const fade = alpha => `rgba(${COLOR.match(/\w\w/g).map(h => parseInt(h, 16)).join(', ')}, ${alpha})`;

const CSS = `
.privacy-indicator { color: ${COLOR} !important; }
.screen-sharing-indicator { color: ${SHARING_FG_COLOR} !important; box-shadow: inset 0 0 0 100px ${COLOR} !important; }
.screen-sharing-indicator:hover, .screen-sharing-indicator:focus { box-shadow: inset 0 0 0 100px ${fade(0.85)} !important; }
.screen-sharing-indicator:active, .screen-sharing-indicator:checked { box-shadow: inset 0 0 0 100px ${fade(0.75)} !important; }
.screen-sharing-indicator:active:hover, .screen-sharing-indicator:checked:hover { box-shadow: inset 0 0 0 100px ${fade(0.7)} !important; }
`;

export default class WarnColor {
    enable() {
        // St only loads stylesheets from files
        this._file = Gio.File.new_for_path(`${GLib.get_user_runtime_dir()}/customizations-warn-color.css`);
        this._file.replace_contents(new TextEncoder().encode(CSS), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._file);
    }

    disable() {
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._file);
        this._file.delete(null);
        this._file = null;
    }
}
