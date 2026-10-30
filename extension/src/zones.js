import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Zones relative to the monitor work area; re-read on every drag, so edits apply immediately.
// Each value up to 1 is a fraction of the work area, above 1 it is logical pixels (mixable per value).
// Negative x/y (including -0) measure from the right/bottom edge to the zone's far edge.
// Negative w/h are the work area size minus that amount, e.g. h: -1440 is height - 1440
const CONFIG = `${GLib.get_user_config_dir()}/zones.json`;
const DEFAULT_ZONES = [
    {x: 0, y: 0, w: 1, h: 1},
    {x: 0, y: 0, w: 0.5, h: 1},
    {x: -0, y: 0, w: 0.5, h: 1},
    {x: 0, y: 0, w: 0.5, h: 0.5},
    {x: -0, y: 0, w: 0.5, h: 0.5},
    {x: 0, y: -0, w: 0.5, h: 0.5},
    {x: -0, y: -0, w: 0.5, h: 0.5}
];
// Last zone config per wm_class, restored when a window of that class opens
const PLACES = `${GLib.get_user_state_dir()}/zones-windows.json`;
// Mutter's tile/maximize bindings (Super+arrows by default) are taken over to step between zones
const KEYS = {'toggle-tiled-left': [-1, 0], 'toggle-tiled-right': [1, 0], 'maximize': [0, -1], 'unmaximize': [0, 1]};
const FADE_MS = 150; // zone preview fade-in
const SLIDE_MS = 250; // Super+arrow slide
const SLIDE_WAIT_MS = 500; // max wait for the app to redraw at the new size, then it snaps without slide
const RESTORE_MS = 10000; // fixed window, raise it if a slow-loading app still escapes its zone
const GAP = 1; // px between zone and its outline, visual only; fractions are crisp only at scale 2+

const px = (v, size) => Math.round(Math.abs(v) > 1 ? Math.abs(v) : Math.abs(v) * size);
const len = (v, size) => (v < 0 ? size - px(v, size) : px(v, size));
const pos = (v, len, size) => (1 / v < 0 ? size - len - px(v, size) : px(v, size)); // 1 / v < 0 also catches -0

// Zone config resolved to an absolute rect inside the work area
function zoneRect(z, area) {
    const w = len(z.w, area.width), h = len(z.h, area.height);
    return {
        x: area.x + pos(z.x, w, area.width),
        y: area.y + pos(z.y, h, area.height),
        width: w,
        height: h,
    };
}

// Non-resizable windows (e.g. games with fixed size hints) keep their size and are centered in the zone,
// clamped to the work area so they stay on screen and below the panel (top-left wins if larger than it).
function place(win, r, a) {
    if (win.allows_resize()) {
        win.move_resize_frame(true, r.x, r.y, r.width, r.height);
        return r;
    }
    const f = win.get_frame_rect();
    const clamp = (v, lo, size, max) => Math.max(lo, Math.min(v, lo + max - size));
    const x = clamp(r.x + Math.round((r.width - f.width) / 2), a.x, f.width, a.width);
    const y = clamp(r.y + Math.round((r.height - f.height) / 2), a.y, f.height, a.height);
    win.move_frame(true, x, y);
    return {x, y, width: f.width, height: f.height};
}

// Mutter animates only its own maximize/tile, so this copies GNOME Shell's maximize animation: a snapshot of the
// old content slides and fades out while the window, already redrawn at its new size, grows from the old rect.
// The window is frozen until the app commits the new size, so a responsive layout changes once, under the fade.
// A step during a slide continues from the snapshot's current rect
function slide(win, move) {
    const actor = win.get_compositor_private();
    if (!actor || !St.Settings.get().enable_animations) return move();
    const f0 = win.get_frame_rect();
    const prev = actor._zonesSnap ?? f0; // f0 is a boxed rect, its fields do not spread
    const from = {x: prev.x, y: prev.y, width: prev.width, height: prev.height};
    actor._zonesDone?.();
    const content = actor.paint_to_content(f0);
    if (!content) return move();
    const snap = new St.Widget({content, ...from});
    snap.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS); // fades as one layer
    global.window_group.add_child(snap);
    actor.opacity = 0;
    actor.freeze();

    let frozen = true, timer = 0;
    const thaw = () => frozen && actor.thaw();
    const done = () => {
        if (actor._zonesDone !== done) return;
        delete actor._zonesDone;
        delete actor._zonesSnap;
        if (timer) GLib.source_remove(timer);
        win.disconnectObject(snap);
        actor.disconnectObject(snap);
        thaw();
        frozen = false;
        actor.remove_all_transitions();
        actor.set({opacity: 255, scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0});
        snap.destroy();
    };
    actor._zonesDone = done;
    actor._zonesSnap = snap;
    actor.connectObject('destroy', done, snap);
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDE_WAIT_MS, () => {
        timer = 0;
        done(); // app did not resize in time, the window just appears in its zone
        return GLib.SOURCE_REMOVE;
    });

    const r = move();
    const resize = r.width !== f0.width || r.height !== f0.height;
    // Ready once the app has committed the new size (or, without a resize, the new position)
    const ready = f => (resize ? f.width !== f0.width || f.height !== f0.height : f.x !== f0.x || f.y !== f0.y);
    const start = () => {
        win.disconnectObject(snap);
        GLib.source_remove(timer);
        timer = 0;
        // The actor's origin is the buffer rect, which adds client-side shadows around the frame
        const f = win.get_frame_rect(), b = win.get_buffer_rect();
        const sx = from.width / f.width, sy = from.height / f.height;
        actor.set_pivot_point(0, 0);
        actor.set({
            opacity: 255,
            scale_x: sx,
            scale_y: sy,
            translation_x: from.x - b.x - (f.x - b.x) * sx,
            translation_y: from.y - b.y - (f.y - b.y) * sy,
        });
        thaw();
        frozen = false;
        const ease = {duration: SLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
        actor.ease({scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, ...ease});
        snap.ease({x: f.x, y: f.y, width: f.width, height: f.height, opacity: 0, ...ease, onStopped: done});
    };
    if (ready(win.get_frame_rect())) return start();
    const check = () => ready(win.get_frame_rect()) && start();
    win.connectObject('size-changed', check, 'position-changed', check, snap);
}

// JSON.stringify writes -0 as 0, so pass it through as a placeholder string
const toJson = v => JSON.stringify(v, (_k, n) => (Object.is(n, -0) ? '-0!' : n), 4).replaceAll('"-0!"', '-0');

// St crossfades between styles for transition-duration, taken from the new style, so both carry it
const ZONE_STYLE = `transition-duration: ${FADE_MS}ms; border-radius: 12px; border: 2px solid rgba(255, 255, 255, 0.3);`; // background-color: rgba(255, 255, 255, 0.03);
const HOVER_STYLE = `transition-duration: ${FADE_MS}ms; border-radius: 12px; border: 2px solid rgba(53, 132, 228, 0.5); background-color: rgba(53, 132, 228, 0.1);`;

function loadZones() {
    if (!GLib.file_test(CONFIG, GLib.FileTest.EXISTS))
        GLib.file_set_contents(CONFIG, toJson(DEFAULT_ZONES));
    try {
        return JSON.parse(new TextDecoder().decode(GLib.file_get_contents(CONFIG)[1]));
    } catch (e) {
        Main.notifyError(`Invalid ${CONFIG}`, e.message);
        return [];
    }
}

export default class Zones {
    enable() {
        try {
            this._places = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(PLACES)[1]));
        } catch {
            this._places = {};
        }
        global.display.connectObject(
            'grab-op-begin', (_d, win, op) => {
                if (op === Meta.GrabOp.MOVING || op === Meta.GrabOp.MOVING_UNCONSTRAINED) this._show(win);
            },
            'grab-op-end', () => this._drop(),
            'window-created', (_d, win) => this._restore(win), this);
        for (const [name, [dx, dy]] of Object.entries(KEYS))
            Main.wm.setCustomKeybindingHandler(name, Shell.ActionMode.NORMAL, (_d, win) => this._step(win, dx, dy));
    }

    disable() {
        this._hide();
        global.display.disconnectObject(this);
        Object.keys(KEYS).forEach(name => Meta.keybindings_set_custom_handler(name, null)); // null restores Mutter's handler
        this._places = null;
    }

    // Wait for the first frame, before it the app may still apply its own size and position.
    // Some apps (e.g. Proton games) move back to their own position seconds later, so for RESTORE_MS
    // every move not made by a drag is undone
    _restore(win) {
        if (win.get_window_type() !== Meta.WindowType.NORMAL || win.get_transient_for()) return;
        const actor = win.get_compositor_private();
        const id = actor.connect('first-frame', () => {
            actor.disconnect(id);
            const t0 = Date.now();
            const snap = () => {
                if (this._win === win) return true; // being dragged, the drop decides
                const z = this._places?.[win.get_wm_class()];
                if (!z || win.is_maximized() || win.is_fullscreen() || Date.now() - t0 > RESTORE_MS) return false;
                const area = Main.layoutManager.getWorkAreaForMonitor(win.get_monitor());
                place(win, zoneRect(z, area), area);
                return true;
            };
            if (!snap()) return;
            const moved = win.connect('position-changed', () => snap() || win.disconnect(moved));
        });
    }

    // Picks the zone whose center is ahead of the window's center, preferring zones in line with it
    _step(win, dx, dy) {
        if (!win || win.is_fullscreen() || win.get_window_type() !== Meta.WindowType.NORMAL) return;
        const area = Main.layoutManager.getWorkAreaForMonitor(win.get_monitor());
        const f = win.get_frame_rect(), cx = f.x + f.width / 2, cy = f.y + f.height / 2;
        let best = null, bestCost = Infinity;
        for (const z of loadZones()) {
            const r = zoneRect(z, area);
            const ex = r.x + r.width / 2 - cx, ey = r.y + r.height / 2 - cy;
            const ahead = ex * dx + ey * dy, side = Math.abs(ex * dy - ey * dx);
            const cost = ahead + 2 * side;
            if (ahead >= 1 && cost < bestCost) [best, bestCost] = [z, cost];
        }
        if (!best) return;
        // GNOME 49 dropped unmaximize's flags argument
        // Unmaximize has its own Shell animation, so only steps between zones slide
        if (win.is_maximized()) {
            win.unmaximize.length ? win.unmaximize(Meta.MaximizeFlags.BOTH) : win.unmaximize();
            place(win, zoneRect(best, area), area);
        } else {
            slide(win, () => place(win, zoneRect(best, area), area));
        }
        this._remember(win, best);
    }

    // One outline per zone on the pointer's monitor; the zone under the pointer is highlighted while the window moves
    _show(win) {
        this._hide();
        const area = Main.layoutManager.getWorkAreaForMonitor(global.display.get_current_monitor());
        this._overlay = new St.Widget({x: area.x, y: area.y, width: area.width, height: area.height, opacity: 0});
        this._configs = loadZones();
        this._zones = this._configs.map(z => {
            const r = zoneRect(z, area);
            const actor = new St.Widget({x: r.x - area.x + GAP, y: r.y - area.y + GAP, width: r.width - 2 * GAP, height: r.height - 2 * GAP, style: ZONE_STYLE});
            this._overlay.add_child(actor);
            return actor;
        });
        Main.layoutManager.addTopChrome(this._overlay);
        this._overlay.ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        this._win = win;
        win.connectObject('position-changed', () => this._hover(), this);
        this._hover();
    }

    // Of the zones under the pointer, the one whose center is nearest wins; outside all zones nothing is picked.
    // Holding Ctrl hides the zones and disables snapping
    _hover() {
        const [px, py, mods] = global.get_pointer();
        this._overlay.visible = !(mods & Clutter.ModifierType.CONTROL_MASK);
        if (!this._overlay.visible) {
            this._hit = null;
            return;
        }
        const x = px - this._overlay.x, y = py - this._overlay.y;
        const dist = a => Math.hypot(a.x + a.width / 2 - x, a.y + a.height / 2 - y);
        this._hit = this._zones
            .filter(a => x >= a.x && x < a.x + a.width && y >= a.y && y < a.y + a.height)
            .reduce((best, a) => (!best || dist(a) < dist(best) ? a : best), null);
        this._zones.forEach(a => (a.style = a === this._hit ? HOVER_STYLE : ZONE_STYLE));
    }

    // Window takes the highlighted zone's rect, without the outline's GAP
    // Dropping outside a zone forgets the remembered zone for that wm_class
    _drop() {
        if (!this._overlay) return; // grab was not a move, e.g. a resize
        this._hover(); // Ctrl may have changed since the last move
        const z = this._hit && this._configs[this._zones.indexOf(this._hit)];
        const win = this._win, o = this._overlay;
        const area = {x: o.x, y: o.y, width: o.width, height: o.height};
        this._remember(win, z);
        this._hide();
        // Mutter segfaults on a move/resize during its own grab-op-end emission (edge drag), so place after it
        if (z) {
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (win.get_compositor_private()) place(win, zoneRect(z, area), area); // skip if closed meanwhile
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Stores z as the window's wm_class zone; no z forgets it
    _remember(win, z) {
        const key = win.get_wm_class();
        if (!key || (!z && !(key in this._places))) return;
        if (z) this._places[key] = z;
        else delete this._places[key];
        GLib.mkdir_with_parents(GLib.path_get_dirname(PLACES), 0o755);
        GLib.file_set_contents(PLACES, toJson(this._places));
    }

    _hide() {
        this._win?.disconnectObject(this);
        this._overlay?.destroy();
        this._overlay = this._zones = this._configs = this._win = this._hit = null;
    }
}
