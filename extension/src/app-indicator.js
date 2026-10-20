import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// StatusNotifierItem host (what tray apps like Discord, Steam or nm-applet talk to), minus appindicator's
// legacy XEmbed tray, tooltips, overlay icons and scrolling

Gio._promisify(Gio.DBusConnection.prototype, 'call');

const WATCHER = 'org.kde.StatusNotifierWatcher';
const ITEM = 'org.kde.StatusNotifierItem';
const MENU = 'com.canonical.dbusmenu';
const WATCHER_XML = `<node><interface name="${WATCHER}">
    <method name="RegisterStatusNotifierItem"><arg type="s" direction="in"/></method>
    <method name="RegisterStatusNotifierHost"><arg type="s" direction="in"/></method>
    <property name="RegisteredStatusNotifierItems" type="as" access="read"/>
    <property name="IsStatusNotifierHostRegistered" type="b" access="read"/>
    <property name="ProtocolVersion" type="i" access="read"/>
    <signal name="StatusNotifierItemRegistered"><arg type="s"/></signal>
    <signal name="StatusNotifierItemUnregistered"><arg type="s"/></signal>
    <signal name="StatusNotifierHostRegistered"/>
</interface></node>`;

const bus = Gio.DBus.session;
const call = async (name, path, iface, method, args = null, type = null) =>
    (await bus.call(name, path, iface, method, args, type && new GLib.VariantType(type),
        Gio.DBusCallFlags.NONE, -1, null)).recursiveUnpack();

// Item Ids hidden by "Remove Icon", one per line; delete a line and restart the app to get its icon back
const REMOVED_FILE = `${GLib.get_user_config_dir()}/tray-icons-removed.txt`;

function isRemoved(id) {
    try {
        return new TextDecoder().decode(GLib.file_get_contents(REMOVED_FILE)[1]).split('\n').includes(id);
    } catch {
        return false; // no file yet
    }
}

function remove(id) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(REMOVED_FILE), 0o755);
    const stream = Gio.File.new_for_path(REMOVED_FILE).append_to(Gio.FileCreateFlags.NONE, null);
    stream.write_all(new TextEncoder().encode(`${id}\n`), null);
    stream.close(null);
}

// Mnemonics: "_File" shows "File", "__" is a literal underscore
const stripMnemonic = label => (label ?? '').replace(/_(_?)/g, '$1');

function pixmapIcon(pixmaps) {
    // Largest one, St scales it down. ARGB32 in network byte order is Cogl's ARGB_8888.
    const [width, height, bytes] = pixmaps.reduce((a, b) => b[0] > a[0] ? b : a);
    const content = St.ImageContent.new_with_preferred_size(width, height);
    content.set_bytes(global.stage.context.get_backend().get_cogl_context(), new GLib.Bytes(bytes),
        Cogl.PixelFormat.ARGB_8888, width, height, width * 4);
    return content;
}

function itemIcon(p) {
    const attention = p.Status === 'NeedsAttention';
    const name = (attention && p.AttentionIconName) || p.IconName;
    const pixmaps = (attention && p.AttentionIconPixmap?.length && p.AttentionIconPixmap) || p.IconPixmap;
    if (name && p.IconThemePath) {
        const theme = new St.IconTheme();
        theme.append_search_path(p.IconThemePath);
        const file = theme.lookup_icon(name, 16, 0)?.get_filename();
        if (file)
            return Gio.FileIcon.new(Gio.File.new_for_path(file));
    }
    if (name?.startsWith('/'))
        return Gio.FileIcon.new(Gio.File.new_for_path(name));
    if (pixmaps?.length)
        return pixmapIcon(pixmaps);
    return name ? Gio.ThemedIcon.new(name) : null;
}

class Item {
    constructor(name, path) {
        this._name = name;
        this._path = path;
        this._props = {};
        this._button = new PanelMenu.Button(0.5, name);
        // Without the theme's side padding and margin, which don't fit the square button below and shrink the icon.
        // A bit over the theme's 1.091em (16px): app icons have thinner shapes than the symbolic ones and look smaller.
        this._icon = new St.Icon({
            style_class: 'system-status-icon',
            style: 'padding: 0; margin: 0; icon-size: 1.25em;',
        });
        this._button.add_child(this._icon);
        this._button.visible = false;
        // Square instead of the theme's wide padding. The button's own height is only the panel stretching it,
        // so take the panel's. ponytail: read once, a text scaling change applies to items registered after it.
        this._button.width = Main.panel.get_preferred_height(-1)[1];
        this._button.style = '-natural-hpadding: 0; -minimum-hpadding: 0;';
        Main.panel.addToStatusArea(`app-indicator-${name}${path}`, this._button);

        // The panel button opens its menu on any click; items want left click to activate them instead
        this._button._clickGesture.set_enabled(false);
        const click = new Clutter.ClickGesture({recognize_on_press: true});
        click.connect('recognize', () => this._click(click.get_button()));
        this._button.add_action(click);
        this._button.menu.connect('open-state-changed', (_, open) => open && this._aboutToShow(0));

        // Items announce changes with bare signals (NewIcon, NewStatus, ...), not PropertiesChanged
        this._itemSub = bus.signal_subscribe(name, ITEM, null, path, null, Gio.DBusSignalFlags.NONE,
            () => this._sync());
        this._sync();
    }

    destroy() {
        bus.signal_unsubscribe(this._itemSub);
        if (this._menuSub)
            bus.signal_unsubscribe(this._menuSub);
        this._button.destroy();
        this._button = null;
    }

    async _sync() {
        // Signals can come in bursts; only the newest reply gets applied
        const seq = this._syncSeq = (this._syncSeq ?? 0) + 1;
        let props;
        try {
            [props] = await call(this._name, this._path, 'org.freedesktop.DBus.Properties', 'GetAll',
                new GLib.Variant('(s)', [ITEM]), '(a{sv})');
        } catch (e) {
            logError(e, `app-indicator ${this._name}${this._path}`);
            return;
        }
        if (seq !== this._syncSeq || !this._button)
            return;
        this._props = props;
        this._hidden ??= isRemoved(props.Id);
        this._icon.gicon = itemIcon(props);
        this._button.accessible_name = props.Title ?? '';
        this._button.visible = !this._hidden && props.Status !== 'Passive';

        const menuPath = props.Menu && props.Menu !== '/' ? props.Menu : null;
        if (menuPath === this._menuPath)
            return;
        if (this._menuSub)
            bus.signal_unsubscribe(this._menuSub);
        this._menuSub = this._menuPath = null;
        this._button.menu.removeAll();
        if (!menuPath)
            return;
        this._menuPath = menuPath;
        // LayoutUpdated, ItemsPropertiesUpdated: refetch the whole tree
        this._menuSub = bus.signal_subscribe(this._name, MENU, null, menuPath, null, Gio.DBusSignalFlags.NONE,
            () => this._syncMenu());
        this._syncMenu();
    }

    async _syncMenu() {
        const seq = this._menuSeq = (this._menuSeq ?? 0) + 1;
        let layout;
        try {
            [, layout] = await call(this._name, this._menuPath, MENU, 'GetLayout',
                new GLib.Variant('(iias)', [0, -1, []]), '(u(ia{sv}av))');
        } catch (e) {
            logError(e, `app-indicator ${this._name}${this._menuPath}`);
            return;
        }
        if (seq !== this._menuSeq || !this._button)
            return;
        // ponytail: rebuilds the whole menu on every change, which closes open submenus; diff by id if that bites
        this._button.menu.removeAll();
        this._fill(this._button.menu, layout[2]);
        // Hide lasts until the app quits (its next start registers a new item), Remove until REMOVED_FILE says otherwise
        const hide = () => {
            this._hidden = true;
            this._button.hide();
        };
        this._button.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this._props.Id) {
            this._button.menu.addAction('Remove Icon', () => {
                remove(this._props.Id);
                hide();
            });
        }
        this._button.menu.addAction('Hide Icon', hide);
    }

    _fill(menu, children) {
        for (const [id, p, grandchildren] of children) {
            if (p.visible === false)
                continue;
            if (p.type === 'separator') {
                menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                continue;
            }
            const label = stripMnemonic(p.label);
            const icon = p['icon-data'] ? Gio.BytesIcon.new(new GLib.Bytes(p['icon-data'])) : p['icon-name'];
            let item;
            if (p['children-display'] === 'submenu') {
                item = new PopupMenu.PopupSubMenuMenuItem(label);
                item.menu.connect('open-state-changed', (_, open) => open && this._aboutToShow(id));
                this._fill(item.menu, grandchildren);
            } else {
                item = icon ? new PopupMenu.PopupImageMenuItem(label, icon) : new PopupMenu.PopupMenuItem(label);
                item.connect('activate', (_, event) => this._menuEvent(id, event.get_time()));
            }
            item.setSensitive(p.enabled !== false);
            if (p['toggle-type'] === 'checkmark')
                item.setOrnament(p['toggle-state'] === 1 ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            else if (p['toggle-type'] === 'radio')
                item.setOrnament(p['toggle-state'] === 1 ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
            menu.addMenuItem(item);
        }
    }

    // Lets lazily built menus fill in; they answer with LayoutUpdated
    _aboutToShow(id) {
        if (this._menuPath)
            call(this._name, this._menuPath, MENU, 'AboutToShow', new GLib.Variant('(i)', [id])).catch(() => {});
    }

    _menuEvent(id, time) {
        call(this._name, this._menuPath, MENU, 'Event',
            new GLib.Variant('(isvu)', [id, 'clicked', new GLib.Variant('i', 0), time])).catch(logError);
    }

    // Left activates unless the item is only a menu, middle is the secondary action, right is the menu
    _click(button) {
        const menu = this._menuPath ? this._button.menu : null;
        const [x, y] = global.get_pointer();
        const itemCall = method =>
            call(this._name, this._path, ITEM, method, new GLib.Variant('(ii)', [x, y])).catch(logError);
        if (button === Clutter.BUTTON_MIDDLE)
            itemCall('SecondaryActivate');
        else if (button === Clutter.BUTTON_PRIMARY && !(this._props.ItemIsMenu && menu))
            itemCall('Activate');
        else if (menu)
            menu.toggle();
        else
            itemCall('ContextMenu');
    }
}

export default class AppIndicator {
    enable() {
        this._items = new Map();
        this._watches = new Map();
        this._dbus = Gio.DBusExportedObject.wrapJSObject(WATCHER_XML, this);
        this._dbus.export(bus, '/StatusNotifierWatcher');
        // Apps watch for this name and register their items once it shows up
        this._nameId = Gio.bus_own_name_on_connection(bus, WATCHER, Gio.BusNameOwnerFlags.NONE,
            () => this._dbus.emit_signal('StatusNotifierHostRegistered', null),
            () => log(`app-indicator: ${WATCHER} is owned by another tray host`));
    }

    disable() {
        Gio.bus_unown_name(this._nameId);
        this._dbus.unexport();
        this._watches.forEach(id => Gio.bus_unwatch_name(id));
        this._items.forEach(item => item.destroy());
        this._items = this._watches = this._dbus = null;
    }

    // Apps pass their bus name (item at the default path) or just an object path on their own connection
    RegisterStatusNotifierItemAsync([service], invocation) {
        const [name, path] = service.startsWith('/')
            ? [invocation.get_sender(), service] : [service, '/StatusNotifierItem'];
        const key = `${name}${path}`;
        if (!this._items.has(key)) {
            this._items.set(key, new Item(name, path));
            if (!this._watches.has(name)) {
                this._watches.set(name, Gio.bus_watch_name_on_connection(bus, name, Gio.BusNameWatcherFlags.NONE,
                    null, () => this._vanished(name)));
            }
        }
        invocation.return_value(null);
    }

    RegisterStatusNotifierHostAsync(_params, invocation) {
        invocation.return_value(null);
    }

    _vanished(name) {
        Gio.bus_unwatch_name(this._watches.get(name));
        this._watches.delete(name);
        for (const [key, item] of this._items) {
            if (key.startsWith(`${name}/`)) {
                item.destroy();
                this._items.delete(key);
            }
        }
    }

    get RegisteredStatusNotifierItems() {
        return [...this._items.keys()];
    }

    get IsStatusNotifierHostRegistered() {
        return true;
    }

    get ProtocolVersion() {
        return 0;
    }
}
