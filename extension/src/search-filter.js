import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';
import {AppSearchProvider} from 'resource:///org/gnome/shell/ui/appDisplay.js';

// Desktop file ids left out of overview search; the app grid still shows them
const HIDDEN = `${GLib.get_user_config_dir()}/search-hidden-apps.json`;

// Right click menu of app icons (grid and search results) gets a toggle after the favorites item
export default class SearchFilter {
    enable() {
        try {
            this._hidden = new Set(JSON.parse(new TextDecoder().decode(GLib.file_get_contents(HIDDEN)[1])));
        } catch {
            this._hidden = new Set();
        }
        this._menus = new Set();

        const hidden = this._hidden;
        this._origSearch = AppSearchProvider.prototype.getInitialResultSet;
        const origSearch = this._origSearch;
        AppSearchProvider.prototype.getInitialResultSet = async function (...args) {
            const results = await origSearch.apply(this, args);
            return results.filter(id => !hidden.has(id));
        };

        const self = this;
        const origOpen = AppMenu.prototype.open;
        AppMenu.prototype.open = function (...args) {
            if (!this._searchItem) {
                this._searchItem = new PopupMenu.PopupMenuItem('');
                this._searchItem.connect('activate', () => self._toggle(this._app.get_id()));
                this.actor.connect('destroy', () => self._menus?.delete(this));
                self._menus.add(this);
                this.addMenuItem(this._searchItem, this._getMenuItems().indexOf(this._toggleFavoriteItem) + 1);
            }
            this._searchItem.label.text = hidden.has(this._app.get_id()) ? 'Show in search' : 'Hide in search';
            origOpen.apply(this, args);
        };
    }

    _toggle(id) {
        if (!this._hidden.delete(id))
            this._hidden.add(id);
        GLib.mkdir_with_parents(GLib.path_get_dirname(HIDDEN), 0o755);
        GLib.file_set_contents(HIDDEN, JSON.stringify([...this._hidden], null, 4));
        // Rerun the current search so a just hidden app leaves the results
        const {searchController} = Main.overview;
        if (searchController.searchActive)
            searchController._searchResults._doSearch();
    }

    disable() {
        AppSearchProvider.prototype.getInitialResultSet = this._origSearch;
        delete AppMenu.prototype.open; // open is inherited from PopupMenu
        for (const menu of this._menus) {
            menu._searchItem.destroy();
            delete menu._searchItem;
        }
        this._menus = this._hidden = null;
    }
}
