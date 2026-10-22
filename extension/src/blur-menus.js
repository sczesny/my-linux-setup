import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Live blur behind the quick settings, calendar and clipboard history menus and notification banners, with the theme's rounded corners.
// Shell.BlurEffect can't round its corners, so this rebuilds its background mode as paint nodes:
// copy the screen behind the box, blur it, cut the corners with a shader, then paint the box on top.

// Blur defaults of Blur my Shell's popups
const RADIUS = 10;
const BRIGHTNESS = 0.8;
// Same as Shell.BlurEffect: downscale until the blur node's sigma is at most this
const MAX_SIGMA = 6;

const CSS = `
.quick-settings, .datemenu-popover { background-color: rgba(54, 54, 58, 0.3) !important; }
.notification-banner { background-color: rgba(84, 84, 90, 0.3) !important; }
.blur-menus-clipboard { background-color: rgba(54, 54, 58, 0.3) !important; }
`;

const CORNERS = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, 'uniform vec2 blur_size; uniform float blur_radius;', `
    vec2 q = abs(cogl_tex_coord0_in.st * blur_size - blur_size * 0.5) - (blur_size * 0.5 - blur_radius);
    cogl_color_out *= clamp(blur_radius - length(max(q, 0.0)) + 0.5, 0.0, 1.0);
`);

// Mutter 48 renamed `cogl_blit_framebuffer()` to `cogl_framebuffer_blit()`
const blit = Cogl.Framebuffer.prototype.blit
    ? (source, ...args) => source.blit(...args)
    : Cogl.blit_framebuffer;

function makeOffscreen(context, width, height) {
    const texture = Cogl.Texture2D.new_with_size(context, width, height);
    const framebuffer = Cogl.Offscreen.new_with_texture(texture);
    framebuffer.allocate();
    framebuffer.orthographic(0, 0, width, height, -1, 1);
    const pipeline = Cogl.Pipeline.new(context);
    pipeline.set_layer_texture(0, texture);
    pipeline.set_layer_wrap_mode(0, Cogl.PipelineWrapMode.CLAMP_TO_EDGE);
    return {width, height, framebuffer, pipeline};
}

// The actor's bounding box in framebuffer pixels
function framebufferRect(actor, framebuffer) {
    const modelview = framebuffer.get_modelview_matrix();
    const projection = framebuffer.get_projection_matrix();
    const vx = framebuffer.get_viewport_x(), vy = framebuffer.get_viewport_y();
    const vw = framebuffer.get_viewport_width(), vh = framebuffer.get_viewport_height();
    const xs = [], ys = [];
    for (const [x, y] of [[0, 0], [actor.width, 0], [0, actor.height], [actor.width, actor.height]]) {
        const p = projection.transform_vec4(modelview.transform_vec4(new Graphene.Vec4().init(x, y, 0, 1)));
        xs.push(vx + (p.get_x() / p.get_w() + 1) * vw / 2);
        ys.push(vy + (1 - p.get_y() / p.get_w()) * vh / 2);
    }
    const x = Math.round(Math.min(...xs)), y = Math.round(Math.min(...ys));
    return {x, y, width: Math.max(1, Math.round(Math.max(...xs)) - x), height: Math.max(1, Math.round(Math.max(...ys)) - y)};
}

// GTypes can't be registered twice, and install.sh re-imports this module into the same shell.
// ponytail: leaks one type per reload, fine for a dev loop.
const MenuBlurEffect = GObject.registerClass({
    GTypeName: `CustomMenuBlurEffect${Date.now()}`,
}, class MenuBlurEffect extends Clutter.Effect {
    vfunc_paint_node(node, paintContext) {
        const actor = this.get_actor();
        const source = paintContext.get_framebuffer();
        const context = source.get_context();
        const rect = framebufferRect(actor, source);

        // Copy what is behind the box. Pixels off the framebuffer stay transparent.
        if (this._copy?.width !== rect.width || this._copy?.height !== rect.height)
            this._copy = makeOffscreen(context, rect.width, rect.height);
        this._copy.framebuffer.clear4f(Cogl.BufferBit.COLOR, 0, 0, 0, 0);
        const sx = Math.max(0, rect.x), sy = Math.max(0, rect.y);
        const cw = Math.min(rect.x + rect.width, source.get_width()) - sx;
        const ch = Math.min(rect.y + rect.height, source.get_height()) - sy;
        if (cw > 0 && ch > 0)
            blit(source, this._copy.framebuffer, sx, sy, sx - rect.x, sy - rect.y, cw, ch);

        // Blur at a lower resolution like Shell.BlurEffect, then draw it rounded and darkened under the box
        const scale = rect.width / actor.width;
        let sigma = RADIUS * scale, downscale = 1;
        while (sigma / downscale > MAX_SIGMA && rect.width / downscale > 2 && rect.height / downscale > 2)
            downscale *= 2;
        const w = Math.ceil(rect.width / downscale), h = Math.ceil(rect.height / downscale);
        if (this._blurred?.width !== w || this._blurred?.height !== h) {
            this._blurred = makeOffscreen(context, w, h);
            this._blurred.pipeline.add_snippet(CORNERS);
        }
        const {pipeline} = this._blurred;
        pipeline.set_uniform_float(pipeline.get_uniform_location('blur_size'), 2, 1, [w, h]);
        pipeline.set_uniform_1f(pipeline.get_uniform_location('blur_radius'),
            actor.get_theme_node().get_border_radius(St.Corner.TOPLEFT) * scale / downscale);
        const opacity = actor.get_paint_opacity() / 255;
        const color = new Cogl.Color();
        color.init_from_4f(BRIGHTNESS * opacity, BRIGHTNESS * opacity, BRIGHTNESS * opacity, opacity);
        pipeline.set_color(color);

        const rounded = Clutter.LayerNode.new_to_framebuffer(this._blurred.framebuffer, pipeline);
        rounded.add_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: actor.width, y2: actor.height}));
        const blur = Clutter.BlurNode.new(w, h, sigma / downscale);
        blur.add_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: w, y2: h}));
        const copy = new Clutter.PipelineNode(this._copy.pipeline);
        copy.add_rectangle(new Clutter.ActorBox({x1: 0, y1: 0, x2: w, y2: h}));
        blur.add_child(copy);
        rounded.add_child(blur);
        node.add_child(rounded);
        node.add_child(new Clutter.ActorNode(actor, -1));

        // Outside the redraw clip the framebuffer still holds the last frame, menu included, which would
        // leak into the blur. Repaint the whole box next frame. ponytail: one frame of smear on partial redraws.
        const clip = paintContext.get_redraw_clip();
        const extents = actor.get_transformed_extents();
        const stageRect = new Mtk.Rectangle({
            x: Math.floor(extents.get_x()), y: Math.floor(extents.get_y()),
            width: Math.ceil(extents.get_width()) + 1, height: Math.ceil(extents.get_height()) + 1,
        });
        if (clip && clip.contains_rectangle(stageRect) !== Mtk.RegionOverlap.IN)
            global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                // The actor may be gone by now, like a dismissed banner
                this.get_actor()?.queue_redraw();
                return GLib.SOURCE_REMOVE;
            });
    }
});

export default class BlurMenus {
    enable() {
        // St only loads stylesheets from files
        this._file = Gio.File.new_for_path(`${GLib.get_user_runtime_dir()}/customizations-blur-menus.css`);
        this._file.replace_contents(new TextEncoder().encode(CSS), null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(this._file);

        const {quickSettings, dateMenu} = Main.panel.statusArea;
        this._menus = [];
        [quickSettings.menu, dateMenu.menu].forEach(menu => this._blurMenu(menu));

        // The clipboard history menu (clipboard-history.js), found by its search row so that module needs no hook.
        // Either module can load first, and it fills its menu after adding it to uiGroup, so look once that's done.
        const findClipboard = actor => global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            const menu = actor._delegate;
            if (this._menus && menu?.box?.get_children().some(c => c.has_style_class_name?.('clipboard-history-search'))) {
                menu.box.add_style_class_name('blur-menus-clipboard');
                this._blurMenu(menu);
            }
            return GLib.SOURCE_REMOVE;
        });
        Main.uiGroup.get_children().forEach(findClipboard);
        Main.uiGroup.connectObject('child-added', (_, actor) => findClipboard(actor), this);

        // The message tray puts a new banner in this bin for every notification
        Main.messageTray._bannerBin.connectObject('child-added',
            (_, banner) => banner.add_effect_with_name('blur-menus', new MenuBlurEffect()), this);
    }

    _blurMenu(menu) {
        menu.box.add_effect_with_name('blur-menus', new MenuBlurEffect());
        // The box pointer always paints into its own offscreen buffer, where there is nothing behind the box to blur
        menu._boxPointer.offscreen_redirect = 0;
        this._menus.push(menu);
        // The clipboard history menu goes away when its module is disabled first
        menu.actor.connectObject('destroy', () => this._menus = this._menus.filter(m => m !== menu), this);
    }

    disable() {
        Main.uiGroup.disconnectObject(this);
        this._menus.forEach(menu => {
            menu.actor.disconnectObject(this);
            menu.box.remove_effect_by_name('blur-menus');
            menu.box.remove_style_class_name('blur-menus-clipboard');
            menu._boxPointer.offscreen_redirect = Clutter.OffscreenRedirect.ALWAYS;
        });
        this._menus = null;
        Main.messageTray._bannerBin.disconnectObject(this);
        Main.messageTray._bannerBin.get_children().forEach(banner => banner.remove_effect_by_name('blur-menus'));
        St.ThemeContext.get_for_stage(global.stage).get_theme().unload_stylesheet(this._file);
        this._file.delete(null);
        this._file = null;
    }
}
