import St from 'gi://St';
import GLib from 'gi://GLib';
import GTop from 'gi://GTop';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const INTERVAL_S = 2;

function fmtW(w) {
    return (w < 10 ? w.toFixed(1) : w.toFixed(0)) + 'W';
}

function makeLabel() {
    return new St.Label({
        y_align: Clutter.ActorAlign.CENTER,
        // Centering counts the empty descender space under digits, so they look high; padding-top / 2 moves them down
        style: 'font-size: 0.9em; padding-top: 0.1em;',
    });
}

function makeMetric(iconPath) {
    const icon = new St.Icon({
        gicon: new Gio.FileIcon({file: Gio.File.new_for_path(iconPath)}),
        style: 'icon-size: 1.08em;',
    });
    const labelBox = new St.BoxLayout({style: 'spacing: 6px;'});
    const label = makeLabel();
    labelBox.add_child(label);
    const box = new St.BoxLayout({style: 'spacing: 10px;'});
    box.add_child(icon);
    box.add_child(labelBox);
    return {box, labelBox, label};
}

export default class SystemMonitorExtension {
    enable() {
        const moduleFile = Gio.File.new_for_uri(import.meta.url.split('?')[0]);
        const iconDir = moduleFile.get_parent().get_parent().get_child('icons');

        this._container = new St.BoxLayout({
            style_class: 'panel-button',
            style: 'spacing: 20px; padding: 0 10px;',
            reactive: true,
            track_hover: true,
        });
        this._container.connect('button-release-event', () => {
            Shell.AppSystem.get_default().lookup_app('btop.desktop')?.activate();
            return Clutter.EVENT_STOP;
        });

        this._cpu = makeMetric(iconDir.get_child('processor-symbolic.svg').get_path());
        this._cpuTemp  = makeLabel();
        this._cpuWatts = makeLabel();
        this._cpu.labelBox.add_child(this._cpuTemp);
        this._cpu.labelBox.add_child(this._cpuWatts);

        this._gpu = makeMetric(iconDir.get_child('gpu-symbolic.svg').get_path());
        this._gpuTemp  = makeLabel();
        this._gpuWatts = makeLabel();
        this._gpu.labelBox.add_child(this._gpuTemp);
        this._gpu.labelBox.add_child(this._gpuWatts);

        this._mem = makeMetric(iconDir.get_child('memory-symbolic.svg').get_path());
        this._dl  = makeMetric(iconDir.get_child('download-symbolic.svg').get_path());
        this._ul  = makeMetric(iconDir.get_child('upload-symbolic.svg').get_path());

        for (const {box} of [this._cpu, this._gpu, this._mem, this._dl, this._ul]) {
            this._container.add_child(box);
        }

        Main.panel._centerBox.add_child(this._container);

        this._prevCpu    = null;
        this._prevNet    = null;
        this._prevEnergy = null;
        this._tempPaths  = this._findTempPaths();
        this._energyPath = '/sys/class/powercap/intel-rapl:0/energy_uj';
        this._energyMax  = parseInt(this._sysfsRead('/sys/class/powercap/intel-rapl:0/max_energy_range_uj') ?? '0', 10);
        this._gpuPaths   = this._findGpuPaths();
        this._nvidiaSmi  = this._detectNvidia();

        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, INTERVAL_S, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });

        this._update();
    }

    disable() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = null;
        }
        this._container?.destroy();
        this._container = null;
        this._prevCpu = null;
        this._prevNet = null;
    }

    _update() {
        const cpu = this._getCpuPct();
        const mem = this._getMemPct();
        const net = this._getNetMbps();

        this._cpu.label.set_text(cpu !== null ? `${cpu.toFixed(0)}%` : '0%');
        const temp  = this._getCpuTemp();
        const watts = this._getCpuWatts();
        this._cpuTemp.set_text(temp !== null ? `${temp.toFixed(0)}°C` : '0°C');
        this._cpuWatts.set_text(watts !== null ? fmtW(watts) : '');
        const nv = this._nvidiaSmi ? this._getNvidiaStat() : null;
        const gpuPct   = nv ? nv.usage : this._getGpuStat('busy');
        const gpuTemp  = nv ? nv.temp  : this._getGpuStat('temp');
        const gpuWatts = nv ? nv.watts : this._getGpuStat('power');
        this._gpu.label.set_text(gpuPct !== null ? `${gpuPct.toFixed(0)}%` : '0%');
        this._gpuTemp.set_text(gpuTemp  !== null ? `${gpuTemp.toFixed(0)}°C` : '0°C');
        this._gpuWatts.set_text(gpuWatts !== null ? fmtW(gpuWatts) : '');
        this._mem.label.set_text(`${mem.toFixed(0)}%`);
        this._dl.label.set_text(net.down !== null ? `${net.down.toFixed(1)}` : '0.0');
        this._ul.label.set_text(net.up !== null ? `${net.up.toFixed(1)}` : '0.0');
    }

    _getCpuPct() {
        const cpu = new GTop.glibtop_cpu();
        GTop.glibtop_get_cpu(cpu);

        const curr = {total: Number(cpu.total), idle: Number(cpu.idle)};

        if (this._prevCpu !== null) {
            const dTotal = curr.total - this._prevCpu.total;
            const dIdle = curr.idle - this._prevCpu.idle;
            this._prevCpu = curr;
            return dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
        }

        this._prevCpu = curr;
        return null;
    }

    _getCpuWatts() {
        const raw = this._sysfsRead(this._energyPath);
        if (raw === null) return null;
        const energy = parseInt(raw, 10);
        const time   = GLib.get_monotonic_time();
        if (this._prevEnergy === null) {
            this._prevEnergy = {energy, time};
            return null;
        }
        let dE = energy - this._prevEnergy.energy;
        if (dE < 0) dE += this._energyMax;
        const dT = time - this._prevEnergy.time;
        this._prevEnergy = {energy, time};
        return dT > 0 ? dE / dT : null;
    }

    _findGpuPaths() {
        let busyPath = null;
        for (let i = 0; i < 4; i++) {
            const p = `/sys/class/drm/card${i}/device/gpu_busy_percent`;
            if (this._sysfsRead(p) !== null) { busyPath = p; break; }
        }
        let tempPath = null, powerPath = null;
        for (let i = 0; i < 4; i++) {
            const devHwmon = `/sys/class/drm/card${i}/device/hwmon`;
            const hwmonDir = Gio.File.new_for_path(devHwmon);
            let hwmonName = null;
            try {
                const iter = hwmonDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
                const info = iter.next_file(null);
                if (info) hwmonName = info.get_name();
                iter.close(null);
            } catch (_) {}
            if (!hwmonName) continue;
            const hw = `${devHwmon}/${hwmonName}`;
            for (let j = 1; j <= 10; j++) {
                const input = `${hw}/temp${j}_input`;
                if (!this._sysfsRead(input)) continue;
                const label = (this._sysfsRead(`${hw}/temp${j}_label`) ?? '').toLowerCase();
                if (!tempPath || label === 'edge') tempPath = input;
            }
            const avg = `${hw}/power1_average`;
            const inp = `${hw}/power1_input`;
            powerPath = this._sysfsRead(avg) !== null ? avg : this._sysfsRead(inp) !== null ? inp : null;
            break;
        }
        return {busyPath, tempPath, powerPath};
    }

    _detectNvidia() {
        try {
            const [ok, , , status] = GLib.spawn_command_line_sync('nvidia-smi -L');
            return ok && status === 0;
        } catch (_) { return false; }
    }

    _getNvidiaStat() {
        try {
            const [ok, stdout, , status] = GLib.spawn_command_line_sync(
                'nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits'
            );
            if (!ok || status !== 0) return null;
            const [usage, temp, watts] = new TextDecoder().decode(stdout).trim().split(',').map(s => parseFloat(s.trim()));
            return {usage, temp, watts};
        } catch (_) { return null; }
    }

    _getGpuStat(kind) {
        const path = this._gpuPaths[kind === 'busy' ? 'busyPath' : kind === 'temp' ? 'tempPath' : 'powerPath'];
        if (!path) return null;
        const val = parseInt(this._sysfsRead(path) ?? '', 10);
        if (isNaN(val)) return null;
        if (kind === 'temp')  return Math.round(val / 1000);
        if (kind === 'power') return val / 1_000_000;
        return val;
    }

    _sysfsRead(path) {
        try {
            const [ok, data] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(data).trim() : null;
        } catch (_) { return null; }
    }

    _findTempPaths() {
        let k10tdie = null, k10tccds = [], k10tctl = null, cpuLabel = null;
        for (let h = 0; h < 30; h++) {
            const hw = `/sys/class/hwmon/hwmon${h}`;
            const driver = this._sysfsRead(`${hw}/name`);
            if (!driver) continue;
            for (let i = 1; i <= 10; i++) {
                const input = `${hw}/temp${i}_input`;
                if (!this._sysfsRead(input)) continue;
                const label = this._sysfsRead(`${hw}/temp${i}_label`) ?? '';
                if (label === 'CPU' && !cpuLabel) {
                    cpuLabel = input;
                } else if (driver === 'k10temp') {
                    const l = label.toLowerCase();
                    if (l === 'tdie')              k10tdie = input;
                    else if (l.startsWith('tccd')) k10tccds.push(input);
                    else if (l === 'tctl')         k10tctl = input;
                }
            }
        }
        if (cpuLabel)        return [cpuLabel];
        if (k10tdie)         return [k10tdie];
        if (k10tccds.length) return k10tccds;
        if (k10tctl)         return [k10tctl];
        return [];
    }

    _getCpuTemp() {
        let max = -Infinity;
        for (const path of this._tempPaths) {
            const val = parseInt(this._sysfsRead(path) ?? '', 10);
            if (!isNaN(val) && val > max) max = val;
        }
        return max === -Infinity ? null : Math.round(max / 1000);
    }

    _getMemPct() {
        const mem = new GTop.glibtop_mem();
        GTop.glibtop_get_mem(mem);
        return (Number(mem.user) / Number(mem.total)) * 100;
    }

    _getNetMbps() {
        const netlist = new GTop.glibtop_netlist();
        const interfaces = GTop.glibtop_get_netlist(netlist);

        let totalDown = 0n;
        let totalUp = 0n;

        for (const iface of interfaces) {
            if (iface === 'lo') continue;
            const load = new GTop.glibtop_netload();
            GTop.glibtop_get_netload(load, iface);
            totalDown += BigInt(load.bytes_in);
            totalUp += BigInt(load.bytes_out);
        }

        const now = GLib.get_monotonic_time();
        const curr = {down: totalDown, up: totalUp, time: now};

        if (this._prevNet !== null) {
            const dtSec = (curr.time - this._prevNet.time) / 1_000_000;
            const downMbps = (Number(curr.down - this._prevNet.down) * 8) / (dtSec * 1e6);
            const upMbps = (Number(curr.up - this._prevNet.up) * 8) / (dtSec * 1e6);
            this._prevNet = curr;
            return {down: Math.max(0, downMbps), up: Math.max(0, upMbps)};
        }

        this._prevNet = curr;
        return {down: null, up: null};
    }
}
