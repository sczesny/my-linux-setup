import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Cogl from 'gi://Cogl';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
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
.clipboard-history-scroll { -st-vfade-offset: 42px; }
/* Same corners as the cards */
.clipboard-history-search StEntry { border-radius: 12px; }
/* Arrow-key focus sets :selected; the theme's highlight didn't show over the card background */
.clipboard-history-item:hover, .clipboard-history-item:selected { background-color: rgba(255, 255, 255, 0.16); }
.clipboard-history-button { padding: 6px; border-radius: 99px; color: rgba(255, 255, 255, 0.6); }
.clipboard-history-button:hover { background-color: rgba(255, 255, 255, 0.15); color: #fff; }
.clipboard-history-button:checked { color: -st-accent-color; }
/* The pin's head sits high in its icon, so it looked above the delete icon's center; same button size */
.clipboard-history-pin { padding: 7px 6px 5px 6px; }
/* The delete button's own 6px padding fills the card's top and right inset, so its icon sits 12px in like the text */
.clipboard-history-content { margin-top: 6px; }
.clipboard-history-files { spacing: 8px; }
/* Edge fades only show where text is cut off; fadedText() sets the height */
.clipboard-history-text { -st-vfade-offset: 48px; -st-hfade-offset: 48px; }
.clipboard-history-empty { padding: 24px; color: rgba(255, 255, 255, 0.5); }
`;

export default class ClipboardHistory {
    enable() {
        try {
            this._history = JSON.parse(new TextDecoder().decode(GLib.file_get_contents(PINNED)[1])).map(e => ({
                ...(e.image ? imageEntry(new GLib.Bytes(GLib.base64_decode(e.image)))
                    : e.files ? fileEntry(e.files) : {key: e.text, text: e.text}),
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
        // The menu flips above the pointer when it doesn't fit below, rechecked on every relayout, so a list that
        // shrank while filtering jumped back below. Decide the side once per open instead.
        // ponytail: patches a private BoxPointer method, recheck after shell upgrades
        const boxPointer = menu._boxPointer;
        const calculateArrowSide = boxPointer._calculateArrowSide.bind(boxPointer);
        boxPointer._calculateArrowSide = side => (this._arrowSide ??= calculateArrowSide(side));

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
        // Typing with an entry focused (arrow keys, Delete) goes to the search instead.
        // The search handles its own keys before they bubble here; space still activates the focused entry
        menu.actor.connect('key-press-event', (_, event) => {
            const char = event.get_key_unicode();
            const backspace = event.get_key_symbol() === Clutter.KEY_BackSpace;
            if (!backspace && !GLib.unichar_isgraph(char)) return Clutter.EVENT_PROPAGATE;
            this._search.grab_key_focus();
            this._search.clutter_text.set_cursor_position(-1);
            if (backspace) this._search.clutter_text.delete_chars(1);
            else this._search.clutter_text.insert_unichar(char);
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
            // Not on close: the closing animation still lays out the menu, which would decide for the old position
            this._arrowSide = null;
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

        // Files win over text, which file managers add as the paths.
        // Text wins over images (office apps add a picture of copied cells); browsers' "Copy Image" has no text
        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (_, type) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
            const mimetypes = clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD);
            if (mimetypes.includes('x-kde-passwordManagerHint')) return;
            const addText = () => clipboard.get_text(St.ClipboardType.CLIPBOARD, (_, text) => {
                // Whitespace-only copies (a stray newline) would show as blank cards
                if (text?.trim()) this._add({key: text, text});
                else if (mimetypes.includes('image/png'))
                    clipboard.get_content(St.ClipboardType.CLIPBOARD, 'image/png', (_, bytes) => this._addImage(bytes));
            });
            if (!mimetypes.includes('text/uri-list')) return addText();
            clipboard.get_content(St.ClipboardType.CLIPBOARD, 'text/uri-list', (_, bytes) => {
                // Browsers offer web links as URI lists too; those stay text
                const uris = bytes?.get_size() ? new TextDecoder().decode(bytes.toArray()).split(/\r?\n/)
                    .filter(line => line && !line.startsWith('#')) : [];
                if (uris.length && uris.every(uri => uri.startsWith('file://'))) this._add(fileEntry(uris));
                else addText();
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
            .map(e => e.bytes ? {image: GLib.base64_encode(e.bytes.toArray())} : e.uris ? {files: e.uris} : {text: e.text})));
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
            // No hover binding: it moved key focus to the entry under the pointer, also on each re-render while typing
            const item = new PopupMenu.PopupBaseMenuItem({style_class: 'clipboard-history-item', hover: false});
            if (entry.thumb) {
                item.add_child(new St.Widget({
                    style_class: 'clipboard-history-content', content: entry.thumb, request_mode: Clutter.RequestMode.CONTENT_SIZE,
                    x_expand: true, x_align: Clutter.ActorAlign.START,
                }));
            } else if (entry.uris) {
                // The icon tells files apart from a copied path
                const files = new St.BoxLayout({style_class: 'clipboard-history-content clipboard-history-files', x_expand: true});
                files.add_child(new St.Icon({icon_name: 'text-x-generic-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.START}));
                files.add_child(fadedText(entry.text));
                item.add_child(files);
            } else {
                item.add_child(fadedText(entry.text, 'clipboard-history-content'));
            }
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

    // Selecting an entry re-copies it (owner-changed moves it to the top) and pastes via Shift+Insert,
    // or Ctrl+V for files: file managers don't bind Shift+Insert, and terminals can't take files anyway
    _paste(entry) {
        this._menu.close();
        if (entry.bytes) {
            clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', entry.bytes);
        } else if (entry.uris) {
            // St offers one type per copy, so no text/plain or cut flag (x-special/gnome-copied-files); pasting copies
            clipboard.set_content(St.ClipboardType.CLIPBOARD, 'text/uri-list',
                new GLib.Bytes(new TextEncoder().encode(entry.uris.map(uri => `${uri}\r\n`).join(''))));
        } else {
            clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
            clipboard.set_text(St.ClipboardType.PRIMARY, entry.text);
        }
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
            const time = Clutter.get_current_event_time() * 1000;
            const SHIFT_L = 42, INSERT = 110, CTRL_L = 29, V = 47;
            const [modifier, key] = entry.uris ? [CTRL_L, V] : [SHIFT_L, INSERT];
            for (const [code, state] of [[modifier, 1], [key, 1], [key, 0], [modifier, 0]])
                this._keyboard.notify_key(time, code, state ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
            this._pasteId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }
}

// Long copies fade out at the bottom and right instead of ending in "…": a scroll view that never scrolls, only for
// its edge fades. Cut to one line more than shown, so the faded line only fades when more follows, each line short,
// so huge copies stay cheap to lay out
function fadedText(text, styleClass = '') {
    const lines = text.trim().split('\n').slice(0, MAX_LINES + 2);
    const label = new St.Label({text: lines.map(line => line.slice(0, 200)).join('\n')});
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    // Scroll views only take scrollable children
    const box = new St.BoxLayout();
    box.add_child(label);
    const view = new St.ScrollView({
        style_class: `clipboard-history-text ${styleClass}`, x_expand: true,
        // NEVER, not EXTERNAL: EXTERNAL has min height 0, and the list's scroll view lays cards out at min height
        hscrollbar_policy: St.PolicyType.EXTERNAL, vscrollbar_policy: St.PolicyType.NEVER,
        // Wheel scrolling still moves the list
        enable_mouse_scrolling: false,
    });
    view.add_child(box);
    // Shows MAX_LINES and the faded one whole: ending at its baseline cut the glyphs in a visible line, as St's fade is
    // still ~7% on the last row. The longer fade keeps the line's bottom faint instead.
    // Line height is measured once the label has its font. No GObject subclass: reloading the extension in the
    // session runs this module again, and registering the type twice failed to load it
    if (lines.length > MAX_LINES + 1) {
        label.connect('style-changed', () => {
            view.height = label.clutter_text.get_preferred_height(-1)[1] / lines.length * (MAX_LINES + 1);
        });
    }
    return view;
}

// Keeps the URIs for pasting; the paths, home as ~, are the card text and what search matches
function fileEntry(uris) {
    const home = GLib.get_home_dir();
    const text = uris.map(uri => {
        const path = Gio.File.new_for_uri(uri).get_path() ?? uri;
        return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
    }).join('\n');
    // Prefixed so the files and their paths copied as text are separate entries
    return {key: `files:${uris.join('\n')}`, uris, text};
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
