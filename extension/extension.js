import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import GLib from 'gi://GLib';

export default class HelloExtension extends Extension {
    async enable() {
        const srcPath = `${this.dir.get_path()}/src`;
        const dir = GLib.Dir.open(srcPath, 0);
        const files = [];
        let name;
        while ((name = dir.read_name()) !== null) {
            if (name.endsWith('.js')) files.push(name);
        }
        dir.close();

        this._modules = [];
        for (const name of files) {
            // One broken module is logged and skipped instead of stopping the rest
            try {
                const {default: Impl} = await import(`${this.dir.get_uri()}/src/${name}?v=${Date.now()}`);
                const impl = new Impl();
                impl.enable();
                this._modules.push(impl);
            } catch (e) {
                console.error(`custom: ${name} failed to load`, e);
            }
        }
    }

    disable() {
        this._modules?.forEach(m => m.disable());
        this._modules = null;
    }
}
