import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

const SHORTCUT = '<Super>v';
const MAX_ENTRIES = 1000;
// ponytail: images are kept in RAM, so only the newest few; move them to a cache dir if more are wanted
const MAX_IMAGES = 25;
const MAX_SHOWN = 50;
const MAX_LINES = 4;
const WIDTH = 600;
const THUMB_WIDTH = 480, THUMB_HEIGHT = 120, THUMB_RADIUS = 8;
// Pinned entries, images as base64 PNG, so they survive reboots
const PINNED = `${GLib.get_user_state_dir()}/clipboard-pinned.json`;
const clipboard = St.Clipboard.get_default();

// Cards like the Windows clipboard history; hover and focus colors come from the theme's .popup-menu-item rules
const CSS = `
.clipboard-history-item { padding: 6px 6px 12px 12px; background-color: rgba(255, 255, 255, 0.05); }
/* One gap everywhere, matching the menu's own 6px padding: border to search, search to list, card to card, card to border */
.clipboard-history-search { padding: 0; margin-bottom: 6px; }
.clipboard-history-list { spacing: 6px; }
/* Scrollbar beside the cards, not over them, with the same 6px gap as between it and the border. Kept out of the
   popup's rounded bottom corner, where its end looked closer to the border than everything else */
.clipboard-history-scroll StScrollBar { margin-left: 6px; margin-bottom: 8px; }
/* Fades cards cut off by scrolling; the theme's 68px fades more than a whole card */
.clipboard-history-scroll { -st-vfade-offset: 32px; }
/* Same corners as the cards */
.clipboard-history-search StEntry { border-radius: 12px; }
/* Clear-all icon as far from the right border as from the top one (it's centered in the 37px search row) */
.clipboard-history-search .clipboard-history-button { margin-right: 4px; }
/* Hover and arrow-key focus both set :selected; the theme's highlight didn't show over the card background */
.clipboard-history-item:selected { background-color: rgba(255, 255, 255, 0.16); }
.clipboard-history-button { padding: 6px; border-radius: 99px; color: rgba(255, 255, 255, 0.6); }
.clipboard-history-button:hover { background-color: rgba(255, 255, 255, 0.15); color: #fff; }
.clipboard-history-button:checked { color: -st-accent-color; }
/* The pin's head sits high in its icon, so it looked above the delete icon's center; same button size */
.clipboard-history-pin { padding: 7px 6px 5px 6px; }
/* The delete button's own 6px padding fills the card's top and right inset, so its icon sits 12px in like the text */
.clipboard-history-content { margin-top: 6px; }
.clipboard-history-empty { padding: 24px; color: rgba(255, 255, 255, 0.5); }
`;

export default class ClipboardHistory {
    enable() {
        try {
            this._history = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(PINNED)[1])).map(e => ({
                ...(e.image ? imageEntry(new GLib.Bytes(GLib.base64_decode(e.image))) : {key: e.text, text: e.text}),
                pinned: true,
            }));
        } catch {
            this._history = [];
        }

        // St only loads stylesheets from files
        this._cssFile = Gio.File.new_for_path(`${GLib.get_user_runtime_dir()}/customizations-clipboard-history.css`);
        this._cssFile.replace_contents(new TextEncoder().encode(CSS), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._cssFile);

        // Anchored to the shell's dummy cursor, which is moved to the pointer on open (like the desktop right-click menu)
        const menu = this._menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        menu.actor.width = WIDTH;
        this._manager = new PopupMenu.PopupMenuManager(Main.layoutManager.dummyCursor);
        this._manager.addMenu(menu);

        this._search = new St.Entry({hint_text: 'Search clipboard history…', can_focus: true, x_expand: true});
        // Opening clears the search too, so both start at the top: newest entries and best matches are there.
        // Pin and delete re-render without this, so tidying the list doesn't jump away.
        this._search.clutter_text.connect('text-changed', () => {
            this._render();
            this._scroll.vadjustment.value = 0;
        });
        this._search.clutter_text.connect('activate', () => this._list.firstMenuItem?.activate(Clutter.get_current_event()));
        // Down jumps from the search into the list; the shell's focus navigation takes over from there
        this._search.clutter_text.connect('key-press-event', (_, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Down || !this._list.firstMenuItem) return Clutter.EVENT_PROPAGATE;
            this._list.firstMenuItem.grab_key_focus();
            return Clutter.EVENT_STOP;
        });
        const clearAll = new St.Button({
            style_class: 'clipboard-history-button', y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'edit-clear-all-symbolic', icon_size: 16}),
        });
        clearAll.connect('clicked', () => {
            this._history = this._history.filter(e => e.pinned);
            this._render();
        });
        const searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'clipboard-history-search'});
        searchItem.add_child(this._search);
        searchItem.add_child(clearAll);
        menu.addMenuItem(searchItem);

        this._list = new PopupMenu.PopupMenuSection();
        this._list.box.add_style_class_name('clipboard-history-list');
        const scroll = this._scroll = new St.ScrollView({style: 'max-height: 500px;', style_class: 'clipboard-history-scroll vfade'});
        scroll.add_child(this._list.actor);
        const scrollSection = new PopupMenu.PopupMenuSection();
        scrollSection.actor.add_child(scroll);
        menu.addMenuItem(scrollSection);

        menu.connect('open-state-changed', (_, open) => {
            if (!open) return;
            this._search.text = '';
            this._render();
            this._scroll.vadjustment.value = 0;
            // PopupMenu grabs focus after this signal, so focus the search entry on the next tick
            this._focusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
                global.stage.set_key_focus(this._search);
                this._focusId = 0;
                return GLib.SOURCE_REMOVE;
            });
        });

        // Text wins when both are offered (office apps add a picture of copied cells); browsers' "Copy Image" has no text
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (_, type) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
            const mimetypes = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
            if (mimetypes.includes('x-kde-passwordManagerHint')) return;
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_, text) => {
                // Whitespace-only copies (a stray newline) would show as blank cards
                if (text?.trim()) this._add({key: text, text});
                else if (mimetypes.includes('image/png'))
                    clipboard.get_content(St.ClipboardType.CLIPBOARD, 'image/png', (_, bytes) => this._addImage(bytes));
            });
        });

        this._action = global.display.grab_accelerator(SHORTCUT, Meta.KeyBindingFlags.NONE);
        this._actionName = Meta.external_binding_name_for_action(this._action);
        Main.wm.allowKeybinding(this._actionName, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._accelId = global.display.connect('accelerator-activated', (_, action) => {
            if (action !== this._action) return;
            const [x, y] = global.get_pointer();
            Main.layoutManager.setDummyCursorGeometry(x, y, 0, 0);
            menu.toggle();
        });

        this._keyboard = global.stage.context.get_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    }

    disable() {
        global.display.disconnect(this._accelId);
        global.display.ungrab_accelerator(this._action);
        Main.wm.allowKeybinding(this._actionName, Shell.ActionMode.NONE);
        this._selection.disconnect(this._ownerId);
        if (this._focusId) GLib.Source.remove(this._focusId);
        if (this._pasteId) GLib.Source.remove(this._pasteId);
        this._menu.destroy();
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._cssFile);
        this._cssFile.delete(null);
        this._menu = this._manager = this._search = this._scroll = this._list = this._selection = this._keyboard = this._history = null;
        this._cssFile = null;
    }

    // get_text/get_content callbacks can land after disable()
    // Pinned entries keep their place, also when pasted, and don't count against the limits
    _add(entry) {
        if (!this._history || this._history.some(e => e.key === entry.key && e.pinned)) return;
        let entries = 0, images = 0;
        this._history = [entry, ...this._history.filter(e => e.key !== entry.key)]
            .filter(e => e.pinned || (++entries <= MAX_ENTRIES && (!e.bytes || ++images <= MAX_IMAGES)));
    }

    _addImage(bytes) {
        if (!bytes?.get_size() || !this._history) return;
        // GJS only borrows callback arguments: St frees these bytes after the callback, so keeping them crashed the
        // shell on the next paste (use-after-free in g_bytes_unref)
        this._add(imageEntry(new GLib.Bytes(bytes.toArray())));
    }

    _togglePin(entry) {
        entry.pinned = !entry.pinned;
        this._savePinned();
        this._render();
        this._search.grab_key_focus();
    }

    _savePinned() {
        GLib.file_set_contents(PINNED, JSON.stringify(this._history.filter(e => e.pinned)
            .map(e => e.bytes ? {image: GLib.base64_encode(e.bytes.toArray())} : {text: e.text})));
    }

    _remove(entry, index) {
        this._history = this._history.filter(e => e !== entry);
        if (entry.pinned) this._savePinned();
        this._render();
        // Keep keyboard deletes going down the list
        const next = this._list.box.get_child_at_index(index);
        (next instanceof PopupMenu.PopupBaseMenuItem ? next : this._search).grab_key_focus();
    }

    _render() {
        this._list.box.destroy_all_children();
        const query = this._search.text.toLowerCase();
        const matches = this._history.filter(e => e.text ? e.text.toLowerCase().includes(query) : !query);
        const shown = [...matches.filter(e => e.pinned), ...matches.filter(e => !e.pinned)].slice(0, MAX_SHOWN);
        if (!shown.length) {
            this._list.box.add_child(new St.Label({
                text: query ? 'No matches' : 'Copy something to see it here',
                style_class: 'clipboard-history-empty', x_align: Clutter.ActorAlign.CENTER,
            }));
        }
        shown.forEach((entry, index) => {
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'clipboard-history-item'});
            item.add_child(entry.thumb
                ? new St.Widget({
                    style_class: 'clipboard-history-content', content: entry.thumb, request_mode: Clutter.RequestMode.CONTENT_SIZE,
                    x_expand: true, x_align: Clutter.ActorAlign.START,
                })
                : new St.Label({style_class: 'clipboard-history-content', text: preview(entry.text), x_expand: true}));
            const pin = new St.Button({
                style_class: 'clipboard-history-button clipboard-history-pin', y_align: Clutter.ActorAlign.START, checked: !!entry.pinned,
                child: new St.Icon({icon_name: 'view-pin-symbolic', icon_size: 16}),
            });
            pin.connect('clicked', () => this._togglePin(entry));
            const remove = new St.Button({
                style_class: 'clipboard-history-button', y_align: Clutter.ActorAlign.START,
                child: new St.Icon({icon_name: 'edit-delete-symbolic', icon_size: 16}),
            });
            remove.connect('clicked', () => this._remove(entry, index));
            // Grouped, so the item's 6px child spacing doesn't add to the buttons' own padding between them
            const buttons = new St.BoxLayout({y_align: Clutter.ActorAlign.START});
            buttons.add_child(pin);
            buttons.add_child(remove);
            item.add_child(buttons);
            item.connect('activate', () => this._paste(entry));
            item.connect('key-focus-in', () => ensureActorVisibleInScrollView(this._scroll, item));
            item.connect('key-press-event', (_, event) => {
                if (event.get_key_symbol() !== Clutter.KEY_Delete) return Clutter.EVENT_PROPAGATE;
                this._remove(entry, index);
                return Clutter.EVENT_STOP;
            });
            this._list.addMenuItem(item);
        });
    }

    // Selecting an entry re-copies it (owner-changed moves it to the top) and pastes via Shift+Insert
    _paste(entry) {
        this._menu.close();
        if (entry.bytes) {
            clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', entry.bytes);
        } else {
            clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
            clipboard.set_text(St.ClipboardType.PRIMARY, entry.text);
        }
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
            const time = Clutter.get_current_event_time() * 1000;
            const SHIFT_L = 42, INSERT = 110;
            for (const [key, state] of [[SHIFT_L, 1], [INSERT, 1], [INSERT, 0], [SHIFT_L, 0]])
                this._keyboard.notify_key(time, key, state ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
            this._pasteId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}

// First few lines, each cut short, so huge copies stay cheap to lay out; St.Label ellipsizes the long ones
function preview(text) {
    const lines = text.trim().split('\n');
    const shown = lines.slice(0, MAX_LINES).map(line => line.slice(0, 200));
    if (lines.length > MAX_LINES) shown.push('…');
    return shown.join('\n');
}

// Keeps the PNG for pasting and a downscaled copy for the card
function imageEntry(bytes) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    let pixbuf = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes), null);
    const factor = Math.min(1, THUMB_WIDTH * scale / pixbuf.width, THUMB_HEIGHT * scale / pixbuf.height);
    if (factor < 1) {
        pixbuf = pixbuf.scale_simple(Math.max(1, Math.round(pixbuf.width * factor)),
            Math.max(1, Math.round(pixbuf.height * factor)), GdkPixbuf.InterpType.BILINEAR);
    }
    pixbuf = pixbuf.add_alpha(false, 0, 0, 0);
    const thumb = St.ImageContent.new_with_preferred_size(pixbuf.width / scale, pixbuf.height / scale);
    thumb.set_bytes(global.stage.context.get_backend().get_cogl_context(), roundCorners(pixbuf, THUMB_RADIUS * scale),
        Cogl.PixelFormat.RGBA_8888, pixbuf.width, pixbuf.height, pixbuf.rowstride);
    return {key: GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA1, bytes), bytes, thumb};
}

// St doesn't clip content to border-radius, so fade the corner pixels out instead (antialiased by pixel coverage)
function roundCorners(pixbuf, radius) {
    const {width: w, height: h, rowstride} = pixbuf;
    const pixels = pixbuf.get_pixels();
    const r = Math.min(radius, w / 2, h / 2);
    for (let y = 0; y < r; y++) {
        for (let x = 0; x < r; x++) {
            const coverage = Math.min(1, Math.max(0, r - Math.hypot(r - x - 0.5, r - y - 0.5) + 0.5));
            for (const [cx, cy] of [[x, y], [w - 1 - x, y], [x, h - 1 - y], [w - 1 - x, h - 1 - y]])
                pixels[cy * rowstride + cx * 4 + 3] *= coverage;
        }
    }
    return new GLib.Bytes(pixels);
}
