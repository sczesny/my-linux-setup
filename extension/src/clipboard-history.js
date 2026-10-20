import St from 'gi://St';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const SHORTCUT = '<Super>v';
const MAX_ENTRIES = 1000;
const MAX_SHOWN = 50;
const WIDTH = 600;
const clipboard = St.Clipboard.get_default();

export default class ClipboardHistory {
    enable() {
        this._history = [];

        // Anchored to the shell's dummy cursor, which is moved to the pointer on open (like the desktop right-click menu)
        const menu = this._menu = new PopupMenu.PopupMenu(Main.layoutManager.dummyCursor, 0, St.Side.TOP);
        Main.uiGroup.add_child(menu.actor);
        menu.actor.hide();
        menu.actor.width = WIDTH;
        this._manager = new PopupMenu.PopupMenuManager(Main.layoutManager.dummyCursor);
        this._manager.addMenu(menu);

        this._search = new St.Entry({hint_text: 'Search clipboard history…', can_focus: true, x_expand: true});
        this._search.clutter_text.connect('text-changed', () => this._render());
        this._search.clutter_text.connect('activate', () => this._list.firstMenuItem?.activate(Clutter.get_current_event()));
        const searchItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        searchItem.add_child(this._search);
        menu.addMenuItem(searchItem);

        this._list = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({style: 'max-height: 450px;', overlay_scrollbars: true});
        scroll.add_child(this._list.actor);
        const scrollSection = new PopupMenu.PopupMenuSection();
        scrollSection.actor.add_child(scroll);
        menu.addMenuItem(scrollSection);

        menu.connect('open-state-changed', (_, open) => {
            if (!open) return;
            this._search.text = '';
            this._render();
            // PopupMenu grabs focus after this signal, so focus the search entry on the next tick
            this._focusId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1, () => {
                global.stage.set_key_focus(this._search);
                this._focusId = 0;
                return GLib.SOURCE_REMOVE;
            });
        });

        this._selection = global.display.get_selection();
        this._ownerId = this._selection.connect('owner-changed', (_, type) => {
            if (type !== Meta.SelectionType.SELECTION_CLIPBOARD) return;
            if (clipboard.get_mimetypes(St.ClipboardType.CLIPBOARD).includes('x-kde-passwordManagerHint')) return;
            clipboard.get_text(St.ClipboardType.CLIPBOARD, (_, text) => this._add(text));
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
        this._menu = this._manager = this._search = this._list = this._selection = this._keyboard = this._history = null;
    }

    _add(text) {
        if (!text || !this._history) return; // get_text callback can land after disable()
        this._history = [text, ...this._history.filter(t => t !== text)].slice(0, MAX_ENTRIES);
    }

    _render() {
        this._list.removeAll();
        const query = this._search.text.toLowerCase();
        for (const text of this._history.filter(t => t.toLowerCase().includes(query)).slice(0, MAX_SHOWN)) {
            const item = new PopupMenu.PopupMenuItem(text.replace(/\s+/g, ' ').trim().slice(0, 200));
            item.connect('activate', () => this._paste(text));
            this._list.addMenuItem(item);
        }
    }

    // Selecting an entry re-copies it (owner-changed moves it to the top) and pastes via Shift+Insert
    _paste(text) {
        this._menu.close();
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        clipboard.set_text(St.ClipboardType.PRIMARY, text);
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
