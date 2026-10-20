import St from 'gi://St';
import Gio from 'gi://Gio';
import Cogl from 'gi://Cogl';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';

const SHORTCUT = '<Shift><Super>c';
const ZOOM = 1;   // loupe magnification
const RADIUS = 1; // loupe radius, in source pixels beyond 10

const hex = rgb => `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`;

// Magnified pixel grid with a ring in the picked color, ported from color-picker@tuberry
// Unique GType per load: install.sh re-imports this module and GTypes cannot be unregistered
const Loupe = GObject.registerClass({GTypeName: `ColorPickerLoupe${Date.now()}`}, class Loupe extends Clutter.Effect {
    constructor() {
        super();
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._pipeline = Cogl.Pipeline.new(global.stage.context.get_backend().get_cogl_context());
        this._pipeline.set_layer_filters(0, Cogl.PipelineFilter.NEAREST, Cogl.PipelineFilter.NEAREST);
        this._pipeline.set_layer_null_texture(1); // gives the standard cogl_tex_coord_in[1] over the actor
        this._pipeline.add_snippet(Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, `
            uniform vec4 u_args[3];
            uniform mat4 cogl_texture_matrix[2];
            #define edge(d, a) smoothstep(a, -(a), d)
        `, `
            mat4 M = cogl_texture_matrix[0];
            vec2 S = u_args[0].xy; // size
            vec2 T = u_args[0].zw; // center
            vec3 C = u_args[1].rgb; // color
            float W = u_args[1].a; // grid width
            float R = u_args[2].x; // radius
            float L = u_args[2].y; // half line width
            float A = u_args[2].z; // anti-aliasing scale

            vec2 uv = cogl_tex_coord_in[1].st * S;
            float r = distance(uv, T);
            if(r > R + 4.5 * L) discard;

            vec4 ret = texture2D(cogl_sampler0, (cogl_tex_coord_in[0].st - M[3].xy) / vec2(M[0].x, M[1].y));

            vec2 xy = abs(uv - T);
            float cell = max(xy.x, xy.y) - W * .5;
            xy = fwidth(uv);
            float aa = max(xy.x, xy.y) * A;
            xy = abs(fract(uv / W + .5) - .5) * W;
            float grid = edge(min(xy.x, xy.y) - L, aa);
            ret = mix(ret, vec4(vec3(edge(cell, aa)), 1.), grid * mix(.4, 1., edge(cell - L, aa)));

            aa = 1.;
            ret = mix(ret, vec4(1. - C, 1.), edge(R - r, aa));
            ret = mix(ret, vec4(C, 1.), edge(R + 2. * L - r, aa));
            ret = mix(ret, vec4(0.), edge(R + 4. * L - r, aa));

            cogl_color_out = ret;
        `));
        this._location = this._pipeline.get_uniform_location('u_args');
    }

    vfunc_paint_node(node) {
        const pipelineNode = new Clutter.PipelineNode(this._pipeline);
        pipelineNode.add_texture_rectangle(Clutter.ActorBox.new(0, 0, this.actor.width, this.actor.height), 0, 0, 1, 1);
        node.add_child(pipelineNode);
    }

    // x, y: picked texture pixel; width, height: last texture pixel; pointer: stage coords
    setup(rgb, [px, py], texture, x, y, width, height, scale) {
        const n = 10 + RADIUS + 1,
            a = Math.max(x - n, 0),
            b = Math.max(y - n, 0),
            c = Math.min(x, width - x, n) + n + 1,
            d = Math.min(y, height - y, n) + n + 1,
            s = Math.round((ZOOM + 4) * this._scale) * 2,
            w = s * c,
            h = s * d,
            u = s * (x - a + .5),
            v = s * (y - b + .5),
            r = s * Math.hypot(n - .5, .5);
        this.actor.set_size(w, h);
        this.actor.set_position(px - u, py - v);
        this._pipeline.set_layer_texture(0, Cogl.SubTexture.new(texture.get_context(), texture, a, b, c, d));
        this._pipeline.set_uniform_float(this._location, 4, 3,
            [w, h, u, v, ...rgb.map(k => k / 255), s, r, Math.round(s / 10), scale > 1 ? .5 : 0, 0]);
    }
});

export default class ColorPicker {
    enable() {
        this._action = global.display.grab_accelerator(SHORTCUT, Meta.KeyBindingFlags.NONE);
        this._actionName = Meta.external_binding_name_for_action(this._action);
        Main.wm.allowKeybinding(this._actionName, Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW);
        this._accelId = global.display.connect('accelerator-activated', (_, action) => {
            if (action === this._action) this._pick();
        });
    }

    disable() {
        if (this._area) this._close();
        global.display.disconnect(this._accelId);
        global.display.ungrab_accelerator(this._action);
        Main.wm.allowKeybinding(this._actionName, Shell.ActionMode.NONE);
    }

    // Frozen screenshot fills the screen; the loupe replaces the cursor. Click/Enter copies hex, Escape/other button cancels
    async _pick() {
        if (this._area) return;
        const area = this._area = new St.Widget({reactive: true});
        area.add_constraint(new Clutter.BindConstraint({source: global.stage, coordinate: Clutter.BindCoordinate.ALL}));
        Main.layoutManager.addTopChrome(area);
        this._grab = Main.pushModal(area, {actionMode: Shell.ActionMode.POPUP});
        area.set_cursor_type(Clutter.CursorType.NONE);

        const loupe = new Loupe();
        this._lens = new Clutter.Actor({effect: loupe});
        const swatch = new St.Bin({y_align: Clutter.ActorAlign.CENTER}); // don't stretch to label height
        const label = new St.Label({style: 'color: #fff; font-family: monospace; font-size: 1.4em; min-width: 4.4em;'});
        const box = new St.BoxLayout({style: 'padding: 0.3em 0.3em 0.3em 0.5em; spacing: 0.4em; border-radius: 0.4em; ' +
            'background-color: #4f4f54; border: 0.05em solid rgba(255, 255, 255, 0.4);'});
        box.add_child(swatch);
        box.add_child(label);
        this._tip = new BoxPointer.BoxPointer(St.Side.TOP);
        this._tip.bin.set_child(box);
        this._tip.hide(); // BoxPointer starts visible at 0,0 and would end up in the screenshot; open() shows it
        Main.layoutManager.addTopChrome(this._lens);
        Main.layoutManager.addTopChrome(this._tip);
        // BoxPointer positions from the lens allocation, which lags set_position; re-run once the lens has moved.
        // First open waits for the next frame, after the lens is placed, so the tip never paints at 0,0
        let rgb = null;
        this._lens.connect('notify::allocation', () => {
            this._tip.queue_relayout();
            if (rgb && !this._tip.visible) global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._tip?.open(BoxPointer.PopupAnimation.NONE);
                return false;
            });
        });
        const pick = (px, py) => {
            const x = Math.min(Math.round(px * scale), width);
            const y = Math.min(Math.round(py * scale), height);
            const stream = Gio.MemoryOutputStream.new_resizable();
            Shell.Screenshot.composite_to_stream(texture, x, y, 1, 1, scale, null, 0, 0, 1, stream).then(pixbuf => {
                if (this._area !== area) return; // closed while reading
                rgb = [...pixbuf.get_pixels().slice(0, 3)];
                loupe.setup(rgb, [px, py], texture, x, y, width, height, scale);
                swatch.style = `width: 1.4em; height: 1.4em; border-radius: 0.2em; background-color: ${hex(rgb)};`;
                label.text = hex(rgb);
                this._tip.setPosition(this._lens, 0.5);
            }).catch(logError).finally(() => stream.close(null));
        };

        const [content, scale] = await new Shell.Screenshot().screenshot_stage_to_content();
        if (this._area !== area) return; // closed while capturing
        area.content = content;
        const texture = content.get_texture();
        const width = texture.get_width() - 1, height = texture.get_height() - 1;

        const motion = new Clutter.MotionController();
        motion.connect('motion', (_c, _s, x, y) => pick(x, y));
        area.add_action(motion);
        const click = new Clutter.ClickGesture();
        click.connect('recognize', () => this._close(click.get_button() === Clutter.BUTTON_PRIMARY && rgb));
        area.add_action(click);
        const keys = new Clutter.KeyController();
        keys.connect('key-press', c => {
            const key = c.get_key()[1];
            if (key === Clutter.KEY_Escape) this._close();
            else if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(key)) this._close(rgb);
        });
        area.add_action(keys);
        pick(...global.get_pointer());
    }

    _close(rgb) {
        if (rgb) St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, hex(rgb));
        Main.popModal(this._grab);
        this._area.destroy();
        this._lens.destroy();
        this._tip.destroy();
        this._area = this._lens = this._tip = this._grab = null;
    }
}
