import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {MonitorConstraint} from 'resource:///org/gnome/shell/ui/layout.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';
import {WorkspaceLayout} from 'resource:///org/gnome/shell/ui/workspace.js';
import {FitMode, WorkspacesView} from 'resource:///org/gnome/shell/ui/workspacesView.js';

// Visible gap between the current workspace and its neighbors, in logical pixels
const GAP = 24;
// WORKSPACE_INACTIVE_SCALE in workspacesView.js: neighbors shrink around their center, which widens the gap
const INACTIVE_SCALE = 0.94;
// Minimum width of each neighbor workspace left visible at the monitor edge, in logical pixels
const PEEK = 32;

// Each tweak applies itself and returns a function that undoes it

function hideDash() {
    const {dash} = Main.overview;
    // Hidden actors still report a preferred height to the overview layout, so also force 0
    dash.hide();
    dash.height = 0;
    return () => {
        dash.height = -1;
        dash.show();
    };
}

// Freed overview space makes the workspace wider, pushing its neighbors off screen.
// Place them so the gap after their shrink is GAP instead of GAP plus the shrink.
function tightenWorkspaceGap() {
    const orig = WorkspacesView.prototype._getSpacing;
    WorkspacesView.prototype._getSpacing = function (box, fitMode, vertical) {
        const spacing = orig.call(this, box, fitMode, vertical);
        if (vertical || fitMode !== FitMode.SINGLE)
            return spacing;
        const [, workspaceWidth] = this._workspaces[0].get_preferred_width(box.get_height());
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        return Math.min(spacing, GAP * scaleFactor - workspaceWidth * (1 - INACTIVE_SCALE) / 2);
    };
    return () => {
        WorkspacesView.prototype._getSpacing = orig;
    };
}

// With two or fewer workspaces GNOME hides the thumbnails. Without them, the dash and the search entry, the workspace
// grows to a few pixels from the monitor edges, less than GAP, so the neighbors land off screen.
// Shrink the workspace until PEEK of each neighbor shows past the gap.
function keepNeighborsVisible() {
    const layout = Main.overview._overview.controls.layout_manager;
    const proto = Object.getPrototypeOf(layout);
    const orig = proto._computeWorkspacesBoxForState;
    proto._computeWorkspacesBoxForState = function (state, ...args) {
        const box = orig.call(this, state, ...args);
        if (state !== ControlsState.WINDOW_PICKER)
            return box;
        // Workspaces keep the work area's aspect ratio, so cap the height that gives the widest allowed workspace
        const {scaleFactor} = St.ThemeContext.get_for_stage(global.stage);
        const [areaWidth, areaHeight] = this._workAreaBox.get_size();
        const maxWidth = box.get_width() - 2 * (GAP + PEEK) * scaleFactor;
        const excess = box.get_height() - maxWidth * areaHeight / areaWidth;
        if (excess > 0) {
            box.y1 += excess / 2;
            box.y2 -= excess / 2;
        }
        return box;
    };
    layout.layout_changed();
    return () => {
        proto._computeWorkspacesBoxForState = orig;
        layout.layout_changed();
    };
}

// Window previews hang their icon and title below the slot and their close button and hover growth above it.
// GNOME only reserves room for them near the monitor's bottom edge, counting on the dash space below the
// workspace and the search entry above it. Without those they spill out of the workspace, so always reserve it inside.
function keepWindowsInWorkspace() {
    const orig = WorkspaceLayout.prototype._adjustSpacingAndPadding;
    WorkspaceLayout.prototype._adjustSpacingAndPadding = function (rowSpacing, colSpacing, containerBox) {
        const [window] = this._sortedWindows;
        if (containerBox && window) {
            const [topOverlap, bottomOverlap] = window.overlapHeights();
            const [topOversize, bottomOversize] = window.chromeHeights();
            containerBox.y1 += topOverlap + topOversize;
            containerBox.y2 -= bottomOverlap + bottomOversize;
        }
        return orig.call(this, rowSpacing, colSpacing, containerBox);
    };
    return () => {
        WorkspaceLayout.prototype._adjustSpacingAndPadding = orig;
    };
}

// Collapse the search entry until typing starts a search; not hide(), so it can still take key focus
function hideSearchUntilTyping() {
    const {searchController} = Main.overview;
    const bin = Main.overview.searchEntry.get_parent();
    const owner = {};
    const sync = () => {
        bin.height = searchController.searchActive ? -1 : 0;
        bin.opacity = searchController.searchActive ? 255 : 0;
    };
    searchController.connectObject('notify::search-active', sync, owner);
    sync();
    return () => {
        searchController.disconnectObject(owner);
        bin.height = -1;
        bin.opacity = 255;
    };
}

// Typing reaches the unfocused entry through its input interceptor, but on Ctrl+V that only focuses it.
// Same paste as the entry's context menu; a focused entry handles the key itself, so it never bubbles up to here.
function pasteStartsSearch() {
    const {clutter_text: text} = Main.overview.searchEntry;
    const keys = new Clutter.KeyController();
    keys.connect('key-press', () => {
        const [, symbol] = keys.get_key();
        const [, pressed] = keys.get_state();
        if (!Main.overview.visible || Main.modalCount > 1 ||
            !(pressed & Clutter.ModifierType.CONTROL_MASK) || (symbol !== Clutter.KEY_v && symbol !== Clutter.KEY_V))
            return Clutter.EVENT_PROPAGATE;
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_, pasted) => {
            if (!pasted)
                return;
            text.grab_key_focus();
            text.delete_selection();
            text.insert_text(pasted, text.get_cursor_position());
        });
        return Clutter.EVENT_STOP;
    });
    global.stage.add_action(keys);
    return () => global.stage.remove_action(keys);
}

// Search entry at the bottom with results above it: swap the two after the overview layout placed them.
// The controller is allocated after the entry, so its allocation sees both final.
function searchAtBottom() {
    const {searchController} = Main.overview;
    const bin = Main.overview.searchEntry.get_parent();
    const owner = {};
    searchController.connectObject('notify::allocation', () => {
        bin.translation_y = searchController.y + searchController.height - bin.y - bin.height;
        searchController.translation_y = bin.y - searchController.y;
    }, owner);
    // Expanding spacer before the providers pushes the results down against the entry
    const content = searchController._searchResults._content;
    const spacer = new St.Widget({y_expand: true});
    content.insert_child_at_index(spacer, 0);
    // Providers in reverse, so apps (registered first) sit right above the entry; later ones go on top too
    const reverse = () => content.get_children().filter(child => child !== spacer)
        .forEach(child => content.set_child_at_index(child, 1));
    reverse();
    content.add_child = child => content.insert_child_at_index(child, 1);
    return () => {
        searchController.disconnectObject(owner);
        searchController.translation_y = 0;
        bin.translation_y = 0;
        delete content.add_child;
        reverse();
        spacer.destroy();
    };
}

// Panel at the bottom: the work area strut follows the box, and menus flip upward on their own when they
// don't fit below. Layout manager resets the position on monitor changes, so reapply after it.
function panelAtBottom() {
    const {layoutManager} = Main;
    const {panelBox} = layoutManager;
    const owner = {};
    const move = () => {
        const {x, y, height} = layoutManager.primaryMonitor;
        panelBox.set_position(x, y + height - panelBox.height);
    };
    layoutManager.connectObject('monitors-changed', move, owner);
    panelBox.connectObject('notify::height', move, owner);
    move();
    Main.panel.translation_y = 0; // undo the lock screen shift below
    // The overview spans the whole monitor and only skips a top panel; keep it out from under the bottom one
    const constraint = Main.overview._overview.get_constraints().find(c => c instanceof MonitorConstraint);
    constraint.work_area = true;
    return () => {
        layoutManager.disconnectObject(owner);
        panelBox.disconnectObject(owner);
        constraint.work_area = false;
        const {x, y} = layoutManager.primaryMonitor;
        // Locking disables the extension. Moving the box would move its strut to the top, and Mutter pushes windows
        // out from under it, so they stay shifted down after unlock. Keep the box and only show the panel on top.
        if (Main.sessionMode.isLocked) {
            Main.panel.translation_y = y - panelBox.y;
            return;
        }
        panelBox.set_position(x, y);
    };
}

// With the panel at the bottom, menus open upward, so the theme's bottom margin (meant to keep them off the screen
// edge) floats them above the panel. Inline style won't do: panel buttons overwrite it with max-height on open.
// St only loads stylesheets from files, so write the rule to one.
function flushPanelMenus() {
    const file = Gio.File.new_for_path(`${GLib.get_user_runtime_dir()}/customizations-tweaks.css`);
    file.replace_contents(new TextEncoder().encode('.popup-menu.panel-menu { margin-bottom: 0; }'),
        null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
    theme.load_stylesheet(file);
    return () => {
        theme.unload_stylesheet(file);
        file.delete(null);
    };
}

// Drop the workspace indicator and put the clock in its place on the left.
// The panel rebuilds its boxes on session mode changes, but extensions get re-enabled after those.
function rearrangePanel() {
    const {_leftBox, _centerBox, statusArea: {activities, dateMenu}} = Main.panel;
    activities.container.hide();
    _centerBox.remove_child(dateMenu.container);
    _leftBox.insert_child_at_index(dateMenu.container, 0);
    return () => {
        _leftBox.remove_child(dateMenu.container);
        _centerBox.insert_child_at_index(dateMenu.container, 0);
        activities.container.show();
    };
}

// Without a battery the system indicator falls back to a power off icon. Show its icon only while the battery
// toggle is visible, so laptops keep the battery; the indicator hides itself once none of its icons are visible.
function hidePowerIconWithoutBattery() {
    const {_system} = Main.panel.statusArea.quickSettings;
    const binding = _system._systemItem.powerToggle.bind_property('visible',
        _system._indicator, 'visible', GObject.BindingFlags.SYNC_CREATE);
    return () => {
        binding.unbind();
        _system._indicator.show();
    };
}

// Notification banners in the bottom left, sliding up from the bottom edge. The tray slides the banner from
// y = -height to y = 0 at the top; mirror that position vertically, so the animation flips with it.
function notificationsAtBottomLeft() {
    const tray = Main.messageTray;
    const bin = tray._bannerBin;
    const owner = {};
    const mirror = () => {
        bin.translation_y = tray.height - bin.height - 2 * bin.y;
    };
    bin.connectObject('notify::y', mirror, 'notify::height', mirror, owner);
    tray.connectObject('notify::height', mirror, owner);
    tray.bannerAlignment = Clutter.ActorAlign.START;
    return () => {
        bin.disconnectObject(owner);
        tray.disconnectObject(owner);
        bin.translation_y = 0;
        tray.bannerAlignment = Clutter.ActorAlign.CENTER;
    };
}

export default class Tweaks {
    enable() {
        this._undo = [
            hideDash(),
            tightenWorkspaceGap(),
            keepNeighborsVisible(),
            keepWindowsInWorkspace(),
            hideSearchUntilTyping(),
            pasteStartsSearch(),
            searchAtBottom(),
            panelAtBottom(),
            flushPanelMenus(),
            rearrangePanel(),
            hidePowerIconWithoutBattery(),
            notificationsAtBottomLeft(),
        ];
    }

    disable() {
        this._undo.reverse().forEach(undo => undo());
        this._undo = null;
    }
}
