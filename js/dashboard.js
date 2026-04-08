/**
 * dashboard.js — TimeseriesDashboard node frontend extension.
 *
 * Opens a full-screen ECharts modal when the user clicks "Open Dashboard".
 * ECharts 5 is loaded from CDN on first use (requires internet access).
 *
 * Extensibility points
 * --------------------
 * PLOT_TYPES           — add { label, buildSeries(name, xData, yData, color) }
 * FIT_TYPES            — add { label, compute(xData, yData) → [[x,y],...] | null }
 * PALETTES             — add { label, colors: [...] }
 * COLORMAP_SCHEMES     — add { label, colors: [...echarts color stops] }
 * SERIES_CONTEXT_MENU  — push plugin objects to add right-click menu entries.
 *
 * Context menu plugin interface  (buildItems pattern)
 * ----------------------------------------------------
 * {
 *   id:    "my_option",
 *   label: "My Option",
 *   icon:  "⚙",
 *
 *   // ctx fields:
 *   //   effectivePlotType  — resolved plot type for this series
 *   //   palette            — current palette hex array
 *   //   seriesStyle        — mutable per-series override object
 *   //   allChannels        — channel intersection across all series
 *   //   seriesChannels     — channels available in THIS series (superset)
 *   //   apply(fn)          — fn(seriesStyle), save+render+CLOSE menu
 *   //   applyInPlace(fn)   — fn(seriesStyle), save+render, keep menu open
 *   //
 *   // Item types:
 *   //  Leaf:      { label, check?, swatch?, onSelect }
 *   //  Group:     { group: true, label, children: [...items] }
 *   //  Toggle:    { toggle: true, label, checked, onToggle(bool) }
 *   //  Stepper:   { stepper: true, getLabel(), value, min, max, step, onStep(n) }
 *   //  Picker:    { picker: true, label, currentHex, onPick(hex) }
 *   //  Separator: { separator: true }
 *   //  Header:    { header: true, label }
 *   buildItems(ctx) { return [...]; },
 * }
 *
 * Per-series style override keys (config.series_styles[name]):
 *   plot_type, line_style, symbol, color,
 *   x_ch, y_ch,
 *   colormap_enabled, colormap_scheme, colormap_channel,
 *   bubble_enabled, bubble_channel, bubble_max_px,
 *   list_break
 */

import { app } from "../../scripts/app.js";

const LOG        = "[Dashboard]";
const ECHARTS_CDN = "https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js";
const DATA_URL    = (nodeId) => `/timeseries/dashboard/data/${nodeId}`;

// ---------------------------------------------------------------------------
// ECharts loader
// ---------------------------------------------------------------------------

let _echartsPromise = null;

function loadECharts() {
    if (window.echarts) return Promise.resolve(window.echarts);
    if (_echartsPromise) return _echartsPromise;
    _echartsPromise = new Promise((resolve, reject) => {
        const s   = document.createElement("script");
        s.src     = ECHARTS_CDN;
        s.onload  = () => resolve(window.echarts);
        s.onerror = () => reject(new Error("Failed to load ECharts from CDN. Check internet connectivity."));
        document.head.appendChild(s);
    });
    return _echartsPromise;
}

// ---------------------------------------------------------------------------
// HSV / color utilities
// ---------------------------------------------------------------------------

function _hsvToRgb(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
    let r, g, b;
    if      (h < 60)  { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function _rgbToHex(r, g, b) {
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function _hexToHsv(hex) {
    const safe = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : "#5470c6";
    const r = parseInt(safe.slice(1, 3), 16) / 255;
    const g = parseInt(safe.slice(3, 5), 16) / 255;
    const b = parseInt(safe.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max, v = max;
    if (d !== 0) {
        if (max === r)      h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else                h = (r - g) / d + 4;
        h = ((h * 60) + 360) % 360;
    }
    return { h, s, v };
}

// ---------------------------------------------------------------------------
// Color palettes
// ---------------------------------------------------------------------------

const PALETTES = {
    echarts: {
        label:  "ECharts Default",
        colors: ["#5470c6","#91cc75","#fac858","#ee6666","#73c0de",
                 "#3ba272","#fc8452","#9a60b4","#ea7ccc","#48b8d0"],
    },
    colorblind: {
        label:  "Colorblind-safe",
        colors: ["#E69F00","#56B4E9","#009E73","#F0E442","#0072B2",
                 "#D55E00","#CC79A7","#000000"],
    },
    warm: {
        label:  "Warm",
        colors: ["#e63946","#f4a261","#e9c46a","#f72585","#b5179e",
                 "#7209b7","#d62828","#f77f00","#fcbf49","#eae2b7"],
    },
    cool: {
        label:  "Cool",
        colors: ["#0077b6","#00b4d8","#90e0ef","#0096c7","#48cae4",
                 "#023e8a","#03045e","#ade8f4","#caf0f8","#7b2d8b"],
    },
    pastel: {
        label:  "Pastel",
        colors: ["#a8dadc","#457b9d","#e63946","#f1faee","#1d3557",
                 "#ffb703","#fb8500","#8ecae6","#219ebc","#023047"],
    },
};

const BASIC_COLORS = [
    { label: "Red",     hex: "#FF0000" }, { label: "Maroon",  hex: "#800000" },
    { label: "Orange",  hex: "#FF8C00" }, { label: "Gold",    hex: "#FFD700" },
    { label: "Yellow",  hex: "#FFFF00" }, { label: "Lime",    hex: "#00FF00" },
    { label: "Green",   hex: "#008000" }, { label: "Teal",    hex: "#008080" },
    { label: "Cyan",    hex: "#00FFFF" }, { label: "Navy",    hex: "#000080" },
    { label: "Blue",    hex: "#0000FF" }, { label: "Purple",  hex: "#800080" },
    { label: "Magenta", hex: "#FF00FF" }, { label: "Pink",    hex: "#FF69B4" },
    { label: "Brown",   hex: "#8B4513" }, { label: "White",   hex: "#FFFFFF" },
    { label: "Gray",    hex: "#808080" }, { label: "Black",   hex: "#000000" },
];

// ---------------------------------------------------------------------------
// Colormap schemes
// ---------------------------------------------------------------------------

const COLORMAP_SCHEMES = {
    viridis:  { label: "Viridis",  colors: ["#440154","#31688e","#35b779","#fde725"] },
    plasma:   { label: "Plasma",   colors: ["#0d0887","#7e03a8","#cc4778","#f89441","#f0f921"] },
    inferno:  { label: "Inferno",  colors: ["#000004","#56106e","#bc3754","#f98e09","#fcffa4"] },
    magma:    { label: "Magma",    colors: ["#000004","#51127c","#b73779","#fc8961","#fbfcbf"] },
    hot:      { label: "Hot",      colors: ["#000000","#ff0000","#ffff00","#ffffff"] },
    cool_cm:  { label: "Cool",     colors: ["#00ffff","#ff00ff"] },
    rdbu:     { label: "RdBu",     colors: ["#d73027","#f7f7f7","#4575b4"] },
    spectral: { label: "Spectral", colors: ["#d53e4f","#f46d43","#fdae61","#fee08b",
                                             "#e6f598","#abdda4","#66c2a5","#3288bd"] },
    grays:    { label: "Grays",    colors: ["#ffffff","#000000"] },
    reds:     { label: "Reds",     colors: ["#fff5f0","#fc0d0d"] },
};

// ---------------------------------------------------------------------------
// UI themes
// ---------------------------------------------------------------------------

const THEMES = {
    dark: {
        overlay:      "#0d0d1a",
        header:       "#12122a",
        sidebar:      "#0a0a18",
        border:       "#2e2e44",
        text:         "#ddd",
        dimText:      "#777",
        titleColor:   "#aac",
        labelColor:   "#aaa",
        splitLine:    "#1e1e32",
        chartBg:      "#13132a",
        selectBg:     "#1e1e38",
        selectBorder: "#555",
        menuBg:       "#1a1a30",
        menuHover:    "#252540",
        echartsTheme: "dark",
    },
    light: {
        overlay:      "#f4f4f8",
        header:       "#e0e0ee",
        sidebar:      "#eaeaf4",
        border:       "#c8c8dc",
        text:         "#1a1a2e",
        dimText:      "#666",
        titleColor:   "#334",
        labelColor:   "#444",
        splitLine:    "#e0e0e8",
        chartBg:      "#ffffff",
        selectBg:     "#ffffff",
        selectBorder: "#bbb",
        menuBg:       "#ffffff",
        menuHover:    "#eeeef8",
        echartsTheme: "",
    },
};

// ---------------------------------------------------------------------------
// Plot type registry
// ---------------------------------------------------------------------------

const PLOT_TYPES = {
    line: {
        label: "Line",
        buildSeries(name, xData, yData, color) {
            return {
                name, type: "line",
                data:      xData.map((x, i) => [x, yData[i]]),
                symbol:    "none",
                lineStyle: { width: 1.5, color },
                itemStyle: { color },
                emphasis:  { disabled: true },
            };
        },
    },
    scatter: {
        label: "Scatter",
        buildSeries(name, xData, yData, color) {
            return {
                name, type: "scatter",
                data:       xData.map((x, i) => [x, yData[i]]),
                symbol:     "circle",
                symbolSize: 6,
                itemStyle:  { color },
            };
        },
    },
    area: {
        label: "Area",
        buildSeries(name, xData, yData, color) {
            return {
                name, type: "line",
                data:      xData.map((x, i) => [x, yData[i]]),
                symbol:    "none",
                lineStyle: { width: 1.5, color },
                areaStyle: { color, opacity: 0.25 },
                itemStyle: { color },
                emphasis:  { disabled: true },
            };
        },
    },
};

// ---------------------------------------------------------------------------
// Fit type registry
// ---------------------------------------------------------------------------

function _linearFit(xData, yData) {
    const n = xData.length;
    if (n < 2) return null;
    const mx = xData.reduce((a, b) => a + b, 0) / n;
    const my = yData.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
        num += (xData[i] - mx) * (yData[i] - my);
        den += (xData[i] - mx) ** 2;
    }
    if (den === 0) return null;
    const slope = num / den, intercept = my - slope * mx;
    return xData.map((x) => [x, slope * x + intercept]);
}

function _movingAvg(xData, yData, w = 20) {
    const half = Math.floor(w / 2);
    return xData.map((x, i) => {
        const lo = Math.max(0, i - half), hi = Math.min(yData.length, i + half + 1);
        return [x, yData.slice(lo, hi).reduce((a, b) => a + b, 0) / (hi - lo)];
    });
}

const FIT_TYPES = {
    none:   { label: "None",            compute: null },
    linear: { label: "Linear Fit",      compute: (x, y) => _linearFit(x, y) },
    ma20:   { label: "Moving Avg (20)", compute: (x, y) => _movingAvg(x, y, 20) },
    ma50:   { label: "Moving Avg (50)", compute: (x, y) => _movingAvg(x, y, 50) },
};

// ---------------------------------------------------------------------------
// Render utilities
// ---------------------------------------------------------------------------

/** Insert null-y break points where the X gap exceeds threshold × median gap. */
function _insertLineBreaks(points, threshold = 3.0) {
    if (points.length < 2) return points;
    const gaps = [];
    for (let i = 1; i < points.length; i++) {
        const dx = points[i][0] - points[i - 1][0];
        gaps.push(isFinite(dx) ? Math.abs(dx) : 0);
    }
    const sorted = [...gaps].filter((g) => g > 0).sort((a, b) => a - b);
    if (!sorted.length) return points;
    const median = sorted[Math.floor(sorted.length / 2)];
    const cutoff = threshold * median;

    const out = [points[0]];
    for (let i = 1; i < points.length; i++) {
        if (gaps[i - 1] > cutoff) {
            const nullPt = new Array(points[i].length).fill(null);
            nullPt[0] = (points[i - 1][0] + points[i][0]) / 2;
            out.push(nullPt);
        }
        out.push(points[i]);
    }
    return out;
}

/** Map a raw size value into [minPx, maxPx] pixels. */
function _normalizeBubble(val, dMin, dMax, minPx, maxPx) {
    if (dMax === dMin || val == null) return (minPx + maxPx) / 2;
    return minPx + ((val - dMin) / (dMax - dMin)) * (maxPx - minPx);
}

// ---------------------------------------------------------------------------
// Series right-click context menu registry  (buildItems pattern)
// ---------------------------------------------------------------------------

const SERIES_CONTEXT_MENU = [];

// ---- Plugin: X Axis Channel ----
SERIES_CONTEXT_MENU.push({
    id: "x_channel", label: "X Axis Channel", icon: "↔",
    buildItems(ctx) {
        const cur = ctx.seriesStyle.x_ch ?? null;
        return [
            { label: "↩ Use global", check: cur === null,
              onSelect: () => ctx.apply((s) => delete s.x_ch) },
            { separator: true },
            ...ctx.seriesChannels.map((ch) => ({
                label:    ch === "__time__" ? "time" : ch,
                check:    cur === ch,
                onSelect: () => ctx.apply((s) => { s.x_ch = ch; }),
            })),
        ];
    },
});

// ---- Plugin: Y Axis Channel ----
SERIES_CONTEXT_MENU.push({
    id: "y_channel", label: "Y Axis Channel", icon: "↕",
    buildItems(ctx) {
        const cur = ctx.seriesStyle.y_ch ?? null;
        return [
            { label: "↩ Use global", check: cur === null,
              onSelect: () => ctx.apply((s) => delete s.y_ch) },
            { separator: true },
            ...ctx.seriesChannels.map((ch) => ({
                label:    ch === "__time__" ? "time" : ch,
                check:    cur === ch,
                onSelect: () => ctx.apply((s) => { s.y_ch = ch; }),
            })),
        ];
    },
});

// ---- Plugin: ColorMap ----
SERIES_CONTEXT_MENU.push({
    id: "colormap", label: "ColorMap", icon: "◈",
    buildItems(ctx) {
        const st      = ctx.seriesStyle;
        const enabled = !!st.colormap_enabled;
        const scheme  = st.colormap_scheme  ?? "viridis";
        const channel = st.colormap_channel ?? null;
        const dataChs = ctx.seriesChannels.filter((c) => c !== "__time__");
        return [
            { toggle: true, label: enabled ? "ON" : "OFF", checked: enabled,
              onToggle: (v) => ctx.applyInPlace((s) => { s.colormap_enabled = v; }) },
            { separator: true },
            { header: true, label: "Color Scheme" },
            {
                group: true,
                label: (COLORMAP_SCHEMES[scheme]?.label ?? scheme),
                children: Object.entries(COLORMAP_SCHEMES).map(([k, v]) => ({
                    label: v.label, check: scheme === k,
                    onSelect: () => ctx.applyInPlace((s) => { s.colormap_scheme = k; }),
                })),
            },
            { separator: true },
            { header: true, label: "Channel" },
            { label: "↩ None", check: channel === null,
              onSelect: () => ctx.applyInPlace((s) => delete s.colormap_channel) },
            ...dataChs.map((ch) => ({
                label: ch, check: channel === ch,
                onSelect: () => ctx.applyInPlace((s) => { s.colormap_channel = ch; }),
            })),
        ];
    },
});

// ---- Plugin: Scatter Options (bubble) — only for scatter plot type ----
SERIES_CONTEXT_MENU.push({
    id: "bubble", label: "Scatter Options", icon: "◉",
    buildItems(ctx) {
        if (ctx.effectivePlotType !== "scatter") return [];
        const st      = ctx.seriesStyle;
        const enabled = !!st.bubble_enabled;
        const maxPx   = st.bubble_max_px ?? 30;
        const channel = st.bubble_channel ?? null;
        const dataChs = ctx.seriesChannels.filter((c) => c !== "__time__");
        return [
            { toggle: true, label: `Bubble: ${enabled ? "ON" : "OFF"}`, checked: enabled,
              onToggle: (v) => ctx.applyInPlace((s) => { s.bubble_enabled = v; }) },
            { separator: true },
            {
                stepper:  true,
                getLabel: () => `Max size: ${st.bubble_max_px ?? 30} px`,
                value: maxPx, min: 5, max: 100, step: 5,
                onStep: (v) => ctx.applyInPlace((s) => { s.bubble_max_px = v; }),
            },
            { separator: true },
            { header: true, label: "Size Channel" },
            { label: "↩ None", check: channel === null,
              onSelect: () => ctx.applyInPlace((s) => delete s.bubble_channel) },
            ...dataChs.map((ch) => ({
                label: ch, check: channel === ch,
                onSelect: () => ctx.applyInPlace((s) => { s.bubble_channel = ch; }),
            })),
        ];
    },
});

// ---- Plugin: List Break — only for line / area ----
SERIES_CONTEXT_MENU.push({
    id: "list_break", label: "List Break", icon: "⋮",
    buildItems(ctx) {
        const pt = ctx.effectivePlotType;
        if (pt !== "line" && pt !== "area") return [];
        const enabled = !!ctx.seriesStyle.list_break;
        return [
            { toggle: true, label: enabled ? "ON" : "OFF", checked: enabled,
              onToggle: (v) => ctx.apply((s) => { s.list_break = v; }) },
        ];
    },
});

// ---- Plugin: Plot Type ----
SERIES_CONTEXT_MENU.push({
    id: "plot_type", label: "Plot Type", icon: "▤",
    buildItems(ctx) {
        const cur = ctx.seriesStyle.plot_type ?? null;
        return [
            { label: "↩ Use global", check: cur === null,
              onSelect: () => ctx.apply((s) => delete s.plot_type) },
            ...Object.entries(PLOT_TYPES).map(([k, v]) => ({
                label: v.label, check: cur === k,
                onSelect: () => ctx.apply((s) => { s.plot_type = k; }),
            })),
        ];
    },
});

// ---- Plugin: Style ----
SERIES_CONTEXT_MENU.push({
    id: "style", label: "Style", icon: "✏",
    buildItems(ctx) {
        const { seriesStyle: st, effectivePlotType: pt } = ctx;
        if (pt === "line" || pt === "area") {
            const cur = st.line_style ?? "solid";
            return [
                { label: "Line (solid)", check: cur === "solid",  onSelect: () => ctx.apply((s) => { s.line_style = "solid"; }) },
                { label: "Dashed",       check: cur === "dashed", onSelect: () => ctx.apply((s) => { s.line_style = "dashed"; }) },
                { label: "Dotted",       check: cur === "dotted", onSelect: () => ctx.apply((s) => { s.line_style = "dotted"; }) },
            ];
        }
        if (pt === "scatter") {
            const cur = st.symbol ?? "circle";
            return [
                { label: "Circle",       check: cur === "circle",    onSelect: () => ctx.apply((s) => { s.symbol = "circle"; }) },
                { label: "Square",       check: cur === "rect",       onSelect: () => ctx.apply((s) => { s.symbol = "rect"; }) },
                { label: "Rounded Rect", check: cur === "roundRect",  onSelect: () => ctx.apply((s) => { s.symbol = "roundRect"; }) },
                { label: "Triangle",     check: cur === "triangle",   onSelect: () => ctx.apply((s) => { s.symbol = "triangle"; }) },
                { label: "Diamond",      check: cur === "diamond",    onSelect: () => ctx.apply((s) => { s.symbol = "diamond"; }) },
                { label: "Pin",          check: cur === "pin",        onSelect: () => ctx.apply((s) => { s.symbol = "pin"; }) },
                { label: "Arrow",        check: cur === "arrow",      onSelect: () => ctx.apply((s) => { s.symbol = "arrow"; }) },
            ];
        }
        return [];
    },
});

// ---- Plugin: Color ----
SERIES_CONTEXT_MENU.push({
    id: "color", label: "Color", icon: "●",
    buildItems(ctx) {
        const { seriesStyle: st, palette } = ctx;
        const cur = st.color ?? "__auto__";
        return [
            {
                group: true, label: "Color Palette",
                children: palette.map((hex, i) => ({
                    label: `Color ${i + 1}`, check: cur === hex, swatch: hex,
                    onSelect: () => ctx.apply((s) => { s.color = hex; }),
                })),
            },
            {
                group: true, label: "Basic",
                children: BASIC_COLORS.map(({ label, hex }) => ({
                    label, check: cur === hex, swatch: hex,
                    onSelect: () => ctx.apply((s) => { s.color = hex; }),
                })),
            },
            { picker: true, label: "Color Picker",
              currentHex: cur !== "__auto__" ? cur : "#5470c6",
              onPick: (hex) => ctx.apply((s) => { s.color = hex; }) },
            { label: "↩ Reset (auto)", check: cur === "__auto__",
              onSelect: () => ctx.apply((s) => delete s.color) },
        ];
    },
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function hideWidget(w) {
    if (!w) return;
    w.type = "hidden"; w.computeSize = () => [0, -4]; w.draw = () => {}; w.serialize = true;
}

function fmtNum(v) {
    if (typeof v !== "number") return v;
    if (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0)) return v.toExponential(2);
    return +v.toPrecision(5) + "";
}

function makeSelect(label, optionPairs, currentValue, theme, onChange) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:4px;";
    const lbl = document.createElement("label");
    lbl.textContent   = label;
    lbl.style.cssText = `font-size:19px;color:${theme.dimText};white-space:nowrap;`;
    const sel = document.createElement("select");
    sel.dataset.tsDashSelect = "1";
    sel.style.cssText = (
        `background:${theme.selectBg};color:${theme.text};border:1px solid ${theme.selectBorder};` +
        "padding:3px 6px;border-radius:3px;font-size:16px;cursor:pointer;"
    );
    for (const [val, text] of optionPairs) {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = text;
        if (val === currentValue) opt.selected = true;
        sel.appendChild(opt);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    wrap.append(lbl, sel);
    return { wrap, sel };
}

// ---------------------------------------------------------------------------
// Dashboard class
// ---------------------------------------------------------------------------

class Dashboard {
    constructor(nodeId, configWidget) {
        this.nodeId         = nodeId;
        this.configWidget   = configWidget;
        this.data           = null;
        this.chart          = null;
        this.config         = this._loadConfig();
        this.overlay        = null;
        this._resizeHandler = null;
        this._themeEls      = {};
        this._boxZoomActive = false;
        this._boxZoomBtn    = null;
        this._tabs          = [];
        this._tabBtns       = {};
        this._activeTabId   = "plot-options";
    }

    _loadConfig() {
        try { return JSON.parse(this.configWidget?.value || "{}"); }
        catch { return {}; }
    }

    _saveConfig() {
        if (this.configWidget) this.configWidget.value = JSON.stringify(this.config);
    }

    _theme()   { return THEMES[this.config.dark_mode !== false ? "dark" : "light"]; }
    _palette() { return (PALETTES[this.config.palette] ?? PALETTES.echarts).colors; }

    _getColor(i, seriesName) {
        const override = (this.config.series_styles ?? {})[seriesName]?.color;
        if (override) return override;
        return this._palette()[i % this._palette().length];
    }

    // ---- Lifecycle ----

    async open() {
        if (this.config.dark_mode       === undefined) this.config.dark_mode       = true;
        if (this.config.palette         === undefined) this.config.palette         = "echarts";
        if (this.config.plot_type       === undefined) this.config.plot_type       = "line";
        if (this.config.fit             === undefined) this.config.fit             = "none";
        if (this.config.panel_collapsed   === undefined) this.config.panel_collapsed   = false;
        if (this.config.sidebar_collapsed === undefined) this.config.sidebar_collapsed = false;
        if (this.config.sidebar_width     === undefined) this.config.sidebar_width     = 220;
        if (!this.config.series_styles)               this.config.series_styles   = {};

        this._buildOverlay();

        this._setStatus("Loading ECharts…");
        try { await loadECharts(); }
        catch (err) { this._setStatus(`ECharts load failed: ${err.message}`); return; }

        this._setStatus("Fetching data…");
        try {
            const resp = await fetch(DATA_URL(this.nodeId));
            if (!resp.ok) {
                const body = await resp.json().catch(() => ({}));
                this._setStatus(`Error: ${body.error || resp.statusText}`);
                return;
            }
            this.data = await resp.json();
        } catch (err) { this._setStatus(`Fetch failed: ${err.message}`); return; }

        if (!this.data.series?.length) {
            this._setStatus("No series data — connect a TIMESERIES_LIST and re-run.");
            return;
        }

        this._setStatus("");
        this._buildPlotOptions();
        this._buildSeriesList();
        this._initChart();
        this._render();
    }

    close() {
        this._closeContextMenu();
        document.getElementById("ts-color-picker")?.remove();
        if (this._resizeHandler) {
            window.removeEventListener("resize", this._resizeHandler);
            this._resizeHandler = null;
        }
        this.chart?.dispose();
        this.chart = null;
        this.overlay?.remove();
        this.overlay = null;
    }

    // ---- DOM builders ----

    _buildOverlay() {
        const t   = this._theme();
        const div = document.createElement("div");
        div.id = "ts-dashboard-overlay";
        div.style.cssText = (
            `position:fixed;inset:0;z-index:9999;background:${t.overlay};` +
            "display:flex;flex-direction:column;font-family:monospace;font-size:17px;"
        );
        this._themeEls.overlay = div;

        const header = document.createElement("div");
        header.style.cssText = (
            `display:flex;align-items:center;padding:8px 14px;` +
            `background:${t.header};border-bottom:1px solid ${t.border};flex-shrink:0;gap:10px;`
        );
        this._themeEls.header = header;

        const title = document.createElement("span");
        title.textContent   = "Timeseries Dashboard";
        title.style.cssText = `font-size:19px;font-weight:bold;color:${t.titleColor};white-space:nowrap;`;
        this._themeEls.title = title;

        const right = document.createElement("div");
        right.style.cssText = "margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;";

        const status = document.createElement("span");
        status.id = "ts-dash-status";
        status.style.cssText = `color:${t.dimText};font-size:19px;`;
        this._themeEls.status = status;

        const makeHdrBtn = (label, onClick) => {
            const btn = document.createElement("button");
            btn.textContent = label;
            btn.style.cssText = this._btnStyle(t);
            btn.addEventListener("click", onClick);
            return btn;
        };
        const resetBtn   = makeHdrBtn("Reset",      () => this._zoomReset());
        const resetXBtn  = makeHdrBtn("Reset X",    () => this._zoomResetX());
        const resetYBtn  = makeHdrBtn("Reset Y",    () => this._zoomResetY());
        const fitXBtn    = makeHdrBtn("Fit X",      () => this._zoomFitX());
        const fitYBtn    = makeHdrBtn("Fit Y",      () => this._zoomFitY());
        const boxBtn     = makeHdrBtn("□ Box Zoom", () => this._toggleBoxZoom());
        this._boxZoomBtn = boxBtn;
        this._themeEls.resetBtn  = resetBtn;
        this._themeEls.resetXBtn = resetXBtn;
        this._themeEls.resetYBtn = resetYBtn;
        this._themeEls.fitXBtn   = fitXBtn;
        this._themeEls.fitYBtn   = fitYBtn;

        const modeBtn = document.createElement("button");
        this._updateModeBtn(modeBtn);
        modeBtn.style.cssText = this._btnStyle(t);
        modeBtn.addEventListener("click", () => {
            this.config.dark_mode = !(this.config.dark_mode !== false);
            this._saveConfig();
            this._applyTheme();
        });
        this._themeEls.modeBtn = modeBtn;

        const closeBtn = document.createElement("button");
        closeBtn.textContent   = "✕  Close";
        closeBtn.style.cssText = this._btnStyle(t);
        closeBtn.addEventListener("click", () => this.close());
        this._themeEls.closeBtn = closeBtn;

        right.append(status, resetBtn, resetXBtn, resetYBtn, fitXBtn, fitYBtn, boxBtn, modeBtn, closeBtn);
        header.append(title, right);

        const body = document.createElement("div");
        body.style.cssText = "display:flex;flex:1;overflow:hidden;";

        // ---- Sidebar panel (resizable + collapsible) ----
        const sidebarCollapsed = this.config.sidebar_collapsed ?? false;
        const sidebarW         = this.config.sidebar_width     ?? 220;

        const sidebarPanel = document.createElement("div");
        sidebarPanel.id = "ts-dash-sidebar-panel";
        sidebarPanel.style.cssText = (
            `width:${sidebarCollapsed ? 32 : sidebarW}px;flex-shrink:0;display:flex;` +
            `flex-direction:column;position:relative;` +
            `background:${t.sidebar};border-right:1px solid ${t.border};`
        );
        this._themeEls.sidebarPanel = sidebarPanel;

        const sidebarHeader = document.createElement("div");
        sidebarHeader.style.cssText = (
            `display:flex;align-items:center;flex-shrink:0;padding:8px 6px 6px;` +
            `border-bottom:1px solid ${t.border};`
        );
        this._themeEls.sidebarHeader = sidebarHeader;

        const sidebarTitle = document.createElement("div");
        sidebarTitle.textContent   = "SERIES";
        sidebarTitle.style.cssText = (
            `font-size:14px;color:${t.dimText};letter-spacing:1px;flex:1;` +
            (sidebarCollapsed ? "display:none;" : "")
        );
        this._themeEls.sidebarTitle = sidebarTitle;

        const sidebarCollapseBtn = document.createElement("button");
        sidebarCollapseBtn.textContent    = sidebarCollapsed ? "▶" : "◀";
        sidebarCollapseBtn.title          = "Toggle series panel";
        sidebarCollapseBtn.style.cssText  = (
            `background:none;border:none;cursor:pointer;padding:0 2px;` +
            `font-size:16px;color:${t.dimText};line-height:1;flex-shrink:0;`
        );
        sidebarCollapseBtn.addEventListener("click", () => {
            this.config.sidebar_collapsed = !(this.config.sidebar_collapsed ?? false);
            this._saveConfig();
            this._updateSidebarCollapse();
        });
        this._themeEls.sidebarCollapseBtn = sidebarCollapseBtn;

        sidebarHeader.append(sidebarTitle, sidebarCollapseBtn);

        const sidebar = document.createElement("div");
        sidebar.id = "ts-dash-series";
        sidebar.style.cssText = (
            `flex:1;overflow-y:auto;padding:8px;` +
            (sidebarCollapsed ? "display:none;" : "")
        );
        this._themeEls.sidebar = sidebar;

        const resizeHandle = document.createElement("div");
        resizeHandle.style.cssText = (
            `position:absolute;right:0;top:0;bottom:0;width:5px;cursor:col-resize;z-index:1;` +
            (sidebarCollapsed ? "display:none;" : "")
        );
        resizeHandle.addEventListener("mouseenter", () => {
            resizeHandle.style.background = "rgba(100,100,200,0.35)";
        });
        resizeHandle.addEventListener("mouseleave", () => {
            resizeHandle.style.background = "transparent";
        });
        resizeHandle.addEventListener("mousedown", (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = sidebarPanel.offsetWidth;
            const onMove = (ev) => {
                const w = Math.max(120, Math.min(500, startW + ev.clientX - startX));
                sidebarPanel.style.width = `${w}px`;
                this.chart?.resize();
            };
            const onUp = (ev) => {
                this.config.sidebar_width = Math.max(120, Math.min(500, startW + ev.clientX - startX));
                this._saveConfig();
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
        this._themeEls.resizeHandle = resizeHandle;

        sidebarPanel.append(sidebarHeader, sidebar, resizeHandle);

        const chartEl = document.createElement("div");
        chartEl.id = "ts-dash-chart";
        chartEl.style.cssText = "flex:1;min-width:0;";

        body.append(sidebarPanel, chartEl);
        div.append(header, body, this._buildBottomPanel());
        document.body.appendChild(div);

        div.tabIndex = 0;
        div.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
        div.focus();
        this.overlay = div;
    }

    _updateModeBtn(btn) { btn.textContent = this.config.dark_mode !== false ? "☀  Light" : "☾  Dark"; }
    _btnStyle(t) {
        return (
            `background:${t.selectBg};border:1px solid ${t.selectBorder};` +
            `color:${t.text};padding:4px 10px;border-radius:3px;cursor:pointer;font-size:16px;`
        );
    }

    _buildPlotOptions() {
        const content = document.getElementById("ts-dash-panel-content");
        if (!content || !this.data) return;
        content.innerHTML = "";
        const t              = this._theme();
        const { all_channels } = this.data;
        const chOpts         = all_channels.map((c) => [c, c === "__time__" ? "time" : c]);
        const nonTimeChs     = all_channels.filter((c) => c !== "__time__");
        const noneChOpts     = [["", "none"], ...nonTimeChs.map((c) => [c, c])];

        if (!this.config.x_ch)
            this.config.x_ch = all_channels.includes("__time__") ? "__time__" : (all_channels[0] ?? "");
        if (!this.config.y_ch)
            this.config.y_ch = all_channels[1] ?? all_channels[0] ?? "";
        if (this.config.default_color_ch === undefined) this.config.default_color_ch = "";
        if (this.config.default_size_ch  === undefined) this.config.default_size_ch  = "";

        const plotOpts    = Object.entries(PLOT_TYPES).map(([k, v]) => [k, v.label]);
        const fitOpts     = Object.entries(FIT_TYPES).map(([k, v])  => [k, v.label]);
        const paletteOpts = Object.entries(PALETTES).map(([k, v])   => [k, v.label]);

        const rerender = () => { this._saveConfig(); this._render(); };

        const { wrap: pw }  = makeSelect("Plot:",     plotOpts,    this.config.plot_type,        t, (v) => { this.config.plot_type        = v;  rerender(); });
        const { wrap: xw }  = makeSelect("X:",        chOpts,      this.config.x_ch,             t, (v) => { this.config.x_ch             = v;  rerender(); });
        const { wrap: yw }  = makeSelect("Y:",        chOpts,      this.config.y_ch,             t, (v) => { this.config.y_ch             = v;  rerender(); });
        const { wrap: fw }  = makeSelect("Fit:",      fitOpts,     this.config.fit,              t, (v) => { this.config.fit              = v;  rerender(); });
        const { wrap: lw }  = makeSelect("Palette:",  paletteOpts, this.config.palette,          t, (v) => { this.config.palette          = v;  this._saveConfig(); this._rebuildSeriesSwatches(); this._render(); });
        const { wrap: ccw } = makeSelect("Color Ch:", noneChOpts,  this.config.default_color_ch, t, (v) => { this.config.default_color_ch = v;  rerender(); });
        const { wrap: scw } = makeSelect("Size Ch:",  noneChOpts,  this.config.default_size_ch,  t, (v) => { this.config.default_size_ch  = v;  rerender(); });

        content.append(pw, xw, yw, fw, lw, ccw, scw);
    }

    _buildBottomPanel() {
        const t         = this._theme();
        const collapsed = this.config.panel_collapsed ?? false;

        this._tabs      = [{ id: "plot-options", label: "Plot Options" }];
        this._tabBtns   = {};

        const panel = document.createElement("div");
        panel.id = "ts-dash-bottom";
        panel.style.cssText = `flex-shrink:0;background:${t.header};border-top:1px solid ${t.border};`;
        this._themeEls.bottomPanel = panel;

        // Tab bar
        const tabBar = document.createElement("div");
        tabBar.style.cssText = "display:flex;align-items:stretch;height:28px;";
        this._themeEls.tabBar = tabBar;

        for (const tab of this._tabs) {
            const btn = document.createElement("button");
            btn.textContent      = tab.label;
            btn.dataset.tabId    = tab.id;
            btn.style.cssText    = this._tabBtnStyle(t, tab.id === this._activeTabId);
            btn.addEventListener("click", () => this._switchTab(tab.id));
            this._tabBtns[tab.id] = btn;
            tabBar.appendChild(btn);
        }

        const collapseBtn = document.createElement("button");
        collapseBtn.textContent = collapsed ? "▴" : "▾";
        collapseBtn.title       = "Toggle panel";
        collapseBtn.style.cssText = (
            `margin-left:auto;background:none;border:none;cursor:pointer;` +
            `padding:0 14px;font-size:18px;color:${t.dimText};`
        );
        collapseBtn.addEventListener("click", () => {
            this.config.panel_collapsed = !(this.config.panel_collapsed ?? false);
            this._saveConfig();
            this._updatePanelCollapse();
        });
        this._themeEls.collapseBtn = collapseBtn;
        tabBar.appendChild(collapseBtn);

        // Content area
        const content = document.createElement("div");
        content.id = "ts-dash-panel-content";
        content.style.cssText = (
            `padding:8px 14px;display:${collapsed ? "none" : "flex"};` +
            `align-items:center;gap:8px;flex-wrap:wrap;overflow:hidden;`
        );

        panel.append(tabBar, content);
        return panel;
    }

    _tabBtnStyle(t, active) {
        return (
            `background:none;border:none;` +
            `border-bottom:2px solid ${active ? "#8888ff" : "transparent"};` +
            `cursor:pointer;padding:0 14px;font-family:monospace;font-size:16px;` +
            `color:${active ? t.text : t.dimText};`
        );
    }

    _switchTab(tabId) {
        if (tabId === this._activeTabId) return;
        this._activeTabId = tabId;
        const t = this._theme();
        for (const [id, btn] of Object.entries(this._tabBtns)) {
            btn.style.cssText = this._tabBtnStyle(t, id === tabId);
        }
        const content = document.getElementById("ts-dash-panel-content");
        if (content) content.innerHTML = "";
        if (tabId === "plot-options") this._buildPlotOptions();
    }

    _updateSidebarCollapse() {
        const collapsed = this.config.sidebar_collapsed ?? false;
        const panel  = this._themeEls.sidebarPanel;
        const title  = this._themeEls.sidebarTitle;
        const btn    = this._themeEls.sidebarCollapseBtn;
        const series = document.getElementById("ts-dash-series");
        const handle = this._themeEls.resizeHandle;
        if (panel)  panel.style.width          = collapsed ? "32px" : `${this.config.sidebar_width ?? 220}px`;
        if (title)  title.style.display         = collapsed ? "none" : "";
        if (btn)    btn.textContent              = collapsed ? "▶" : "◀";
        if (series) series.style.display         = collapsed ? "none" : "";
        if (handle) handle.style.display         = collapsed ? "none" : "";
        this.chart?.resize();
    }

    _updatePanelCollapse() {
        const collapsed = this.config.panel_collapsed ?? false;
        const content   = document.getElementById("ts-dash-panel-content");
        const btn       = this._themeEls.collapseBtn;
        if (content) content.style.display = collapsed ? "none" : "flex";
        if (btn)     btn.textContent        = collapsed ? "▴" : "▾";
        this.chart?.resize();
    }

    _buildSeriesList() {
        const container = document.getElementById("ts-dash-series");
        if (!container || !this.data) return;
        if (!this.config.visibility) this.config.visibility = {};
        this.data.series.forEach((s, i) => {
            if (!(s.name in this.config.visibility)) this.config.visibility[s.name] = true;
            container.appendChild(this._makeSeriesRow(s, i));
        });
    }

    _makeSeriesRow(s, i) {
        const t     = this._theme();
        const color = this._getColor(i, s.name);

        const row = document.createElement("div");
        row.dataset.tsSeriesRow = s.name;
        row.style.cssText = (
            "display:flex;align-items:center;gap:6px;margin-bottom:6px;" +
            "cursor:pointer;border-radius:3px;padding:2px 4px;"
        );

        const swatch = document.createElement("div");
        swatch.dataset.tsSeriesSwatch = "1";
        swatch.style.cssText = `width:10px;height:10px;border-radius:2px;flex-shrink:0;background:${color};`;

        const cb = document.createElement("input");
        cb.type    = "checkbox";
        cb.checked = this.config.visibility[s.name] !== false;
        cb.style.cssText = "accent-color:#aac;cursor:pointer;flex-shrink:0;";

        const lbl = document.createElement("span");
        const display = s.name || `Series ${i + 1}`;
        lbl.textContent   = display;
        lbl.title         = display + "\n(right-click to style)";
        lbl.style.cssText = `overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:17px;color:${t.text};flex:1;`;

        cb.addEventListener("change", () => {
            this.config.visibility[s.name] = cb.checked;
            this._saveConfig(); this._render();
        });
        row.addEventListener("click", (e) => {
            if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); }
        });
        row.addEventListener("contextmenu", (e) => {
            e.preventDefault(); e.stopPropagation();
            this._openContextMenu(e, s.name, i);
        });

        row.append(swatch, cb, lbl);
        return row;
    }

    _rebuildSeriesSwatches() {
        const container = document.getElementById("ts-dash-series");
        if (!container || !this.data) return;
        this.data.series.forEach((s, i) => {
            const row    = container.querySelector(`[data-ts-series-row="${CSS.escape(s.name)}"]`);
            const swatch = row?.querySelector("[data-ts-series-swatch]");
            if (swatch) swatch.style.background = this._getColor(i, s.name);
        });
    }

    _initChart() {
        const chartEl = document.getElementById("ts-dash-chart");
        if (!chartEl || !window.echarts) return;
        this.chart = window.echarts.init(chartEl, this._theme().echartsTheme);
        this._resizeHandler = () => this.chart?.resize();
        window.addEventListener("resize", this._resizeHandler);

        this.chart.on("brushEnd", (params) => {
            if (!this._boxZoomActive) return;
            const area = params.areas?.[0];
            if (!area || area.brushType !== "rect") return;
            const [[x0, x1], [y0, y1]] = area.coordRange;
            this.chart.setOption({
                xAxis: { min: Math.min(x0, x1), max: Math.max(x0, x1) },
                yAxis: { min: Math.min(y0, y1), max: Math.max(y0, y1) },
            }, false);
            // Clear the brush overlay and deactivate the tool.
            this.chart.dispatchAction({ type: "brush", areas: [] });
            this._setBoxZoom(false);
        });
    }

    // ---- Theme switch ----

    _applyTheme() {
        const t = this._theme();
        if (this._themeEls.overlay)     this._themeEls.overlay.style.background     = t.overlay;
        if (this._themeEls.header)      { this._themeEls.header.style.background    = t.header;
                                          this._themeEls.header.style.borderColor   = t.border; }
        if (this._themeEls.sidebarPanel)  { this._themeEls.sidebarPanel.style.background  = t.sidebar;
                                            this._themeEls.sidebarPanel.style.borderColor = t.border; }
        if (this._themeEls.sidebarHeader)   this._themeEls.sidebarHeader.style.borderColor = t.border;
        if (this._themeEls.sidebarTitle)    this._themeEls.sidebarTitle.style.color         = t.dimText;
        if (this._themeEls.sidebarCollapseBtn) this._themeEls.sidebarCollapseBtn.style.color = t.dimText;
        if (this._themeEls.title)         this._themeEls.title.style.color          = t.titleColor;
        if (this._themeEls.status)        this._themeEls.status.style.color         = t.dimText;
        if (this._themeEls.modeBtn)     { this._themeEls.modeBtn.style.cssText      = this._btnStyle(t);
                                          this._updateModeBtn(this._themeEls.modeBtn); }
        if (this._themeEls.closeBtn)    this._themeEls.closeBtn.style.cssText   = this._btnStyle(t);
        if (this._themeEls.resetBtn)    this._themeEls.resetBtn.style.cssText   = this._btnStyle(t);
        if (this._themeEls.resetXBtn)   this._themeEls.resetXBtn.style.cssText  = this._btnStyle(t);
        if (this._themeEls.resetYBtn)   this._themeEls.resetYBtn.style.cssText  = this._btnStyle(t);
        if (this._themeEls.fitXBtn)     this._themeEls.fitXBtn.style.cssText    = this._btnStyle(t);
        if (this._themeEls.fitYBtn)     this._themeEls.fitYBtn.style.cssText    = this._btnStyle(t);
        if (!this._boxZoomActive && this._boxZoomBtn)
            this._boxZoomBtn.style.cssText = this._btnStyle(t);

        if (this._themeEls.bottomPanel) {
            this._themeEls.bottomPanel.style.background  = t.header;
            this._themeEls.bottomPanel.style.borderColor = t.border;
        }
        if (this._themeEls.collapseBtn)
            this._themeEls.collapseBtn.style.color = t.dimText;
        for (const [id, btn] of Object.entries(this._tabBtns ?? {}))
            btn.style.cssText = this._tabBtnStyle(t, id === this._activeTabId);

        document.getElementById("ts-dash-panel-content")
            ?.querySelectorAll("select[data-ts-dash-select]").forEach((s) => {
                s.style.background = t.selectBg; s.style.color = t.text; s.style.borderColor = t.selectBorder;
            });
        document.getElementById("ts-dash-panel-content")
            ?.querySelectorAll("label").forEach((l) => { l.style.color = t.dimText; });
        document.getElementById("ts-dash-series")
            ?.querySelectorAll("[data-ts-series-row] span").forEach((s) => { s.style.color = t.text; });

        if (this.chart) {
            const chartEl = document.getElementById("ts-dash-chart");
            this.chart.dispose();
            this.chart = window.echarts.init(chartEl, t.echartsTheme);
        }
        this._render();
    }

    // ---- Context menu ----

    _openContextMenu(event, seriesName, seriesIndex) {
        this._closeContextMenu();

        const t = this._theme();
        if (!this.config.series_styles[seriesName]) this.config.series_styles[seriesName] = {};
        const seriesStyle       = this.config.series_styles[seriesName];
        const effectivePlotType = seriesStyle.plot_type ?? this.config.plot_type;
        const palette           = this._palette();

        // Per-series channels (superset of global intersection)
        const seriesData    = this.data?.series.find((s) => s.name === seriesName);
        const seriesChannels = seriesData
            ? (seriesData.has_time ? ["__time__", ...seriesData.channels] : seriesData.channels)
            : (this.data?.all_channels ?? []);

        const ctx = {
            effectivePlotType,
            palette,
            seriesStyle,
            allChannels:   this.data?.all_channels ?? [],
            seriesChannels,
            apply: (mutateFn) => {
                mutateFn(seriesStyle);
                if (Object.keys(seriesStyle).length === 0)
                    delete this.config.series_styles[seriesName];
                this._saveConfig();
                this._rebuildSeriesSwatches();
                this._render();
                this._closeContextMenu();
            },
            applyInPlace: (mutateFn) => {
                mutateFn(seriesStyle);
                if (Object.keys(seriesStyle).length === 0)
                    delete this.config.series_styles[seriesName];
                this._saveConfig();
                this._render();
            },
            dashboard: this,
        };

        const activePlugins = SERIES_CONTEXT_MENU.filter((p) => {
            const items = p.buildItems(ctx);
            return items && items.length > 0;
        });
        if (!activePlugins.length) return;

        const menu = document.createElement("div");
        menu.id = "ts-ctx-menu";
        menu.style.cssText = (
            `position:fixed;z-index:10001;left:${event.clientX}px;top:${event.clientY}px;` +
            `background:${t.menuBg};border:1px solid ${t.border};` +
            "border-radius:4px;box-shadow:0 4px 20px rgba(0,0,0,0.55);" +
            `min-width:170px;font-family:monospace;font-size:16px;color:${t.text};padding:4px 0;`
        );

        for (const plugin of activePlugins) {
            const items   = plugin.buildItems(ctx);
            const row     = this._makeMenuRow(plugin.icon, plugin.label, t);
            const submenu = this._buildSubmenu(items, t, seriesName);
            row.appendChild(submenu);
            this._addFlyoutBehavior(row, submenu, menu, t);
            menu.appendChild(row);
        }

        document.body.appendChild(menu);

        const mr = menu.getBoundingClientRect();
        if (mr.bottom > window.innerHeight - 8) menu.style.top = `${event.clientY - mr.height}px`;

        const onOutside = (e) => {
            if (!menu.contains(e.target) && !e.target.closest(".ts-flyout"))
                this._closeContextMenu();
        };
        const onEscape  = (e) => { if (e.key === "Escape") this._closeContextMenu(); };
        document.addEventListener("mousedown", onOutside);
        document.addEventListener("keydown",   onEscape);
        menu._cleanup = () => {
            document.removeEventListener("mousedown", onOutside);
            document.removeEventListener("keydown",   onEscape);
        };
    }

    /** Build a submenu element. Items carry their own callbacks — no currentValue/onSelect param. */
    _buildSubmenu(items, t, seriesName) {
        const sub = document.createElement("div");
        sub.className     = "ts-ctx-submenu";
        sub.style.cssText = (
            "display:none;position:absolute;left:100%;top:-4px;" +
            `background:${t.menuBg};border:1px solid ${t.border};color:${t.text};` +
            "border-radius:4px;box-shadow:0 4px 20px rgba(0,0,0,0.55);" +
            `min-width:160px;padding:4px 0;z-index:10002;max-height:80vh;overflow-y:auto;` +
            "font-family:monospace;font-size:16px;"
        );

        for (const item of items) {

            // Separator
            if (item.separator) {
                const sep = document.createElement("div");
                sep.style.cssText = `height:1px;background:${t.border};margin:4px 8px;`;
                sub.appendChild(sep);
                continue;
            }

            // Section header
            if (item.header) {
                const h = document.createElement("div");
                h.textContent   = item.label;
                h.style.cssText = (
                    `padding:4px 10px 2px;font-size:18px;color:${t.dimText};` +
                    "letter-spacing:0.5px;text-transform:uppercase;user-select:none;"
                );
                sub.appendChild(h);
                continue;
            }

            // Group flyout
            if (item.group) {
                const row      = this._makeMenuRow(null, item.label, t, true);
                const childSub = this._buildSubmenu(item.children, t, seriesName);
                row.appendChild(childSub);
                this._addFlyoutBehavior(row, childSub, sub, t);
                sub.appendChild(row);
                continue;
            }

            // Toggle (stays open)
            if (item.toggle) {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;padding:5px 10px;cursor:pointer;gap:8px;user-select:none;";
                const checkEl = document.createElement("span");
                checkEl.textContent   = item.checked ? "✓" : "";
                checkEl.style.cssText = `width:12px;flex-shrink:0;color:${t.titleColor};font-size:19px;`;
                const lbl = document.createElement("span");
                lbl.textContent = item.label;
                lbl.style.color = t.text;
                row.append(checkEl, lbl);
                row.addEventListener("mouseenter", () => { row.style.background = t.menuHover; });
                row.addEventListener("mouseleave", () => { row.style.background = ""; });
                row.addEventListener("click", (e) => {
                    e.stopPropagation();
                    item.checked = !item.checked;
                    checkEl.textContent = item.checked ? "✓" : "";
                    lbl.textContent     = item.label.replace(/ON|OFF/, item.checked ? "ON" : "OFF");
                    item.onToggle(item.checked);
                });
                sub.appendChild(row);
                continue;
            }

            // Stepper (stays open)
            if (item.stepper) {
                const row = document.createElement("div");
                row.style.cssText = "display:flex;align-items:center;padding:5px 10px;gap:6px;user-select:none;";
                const lbl = document.createElement("span");
                lbl.textContent   = item.getLabel ? item.getLabel() : String(item.value);
                lbl.style.cssText = `flex:1;color:${t.text};font-size:19px;`;
                const btnStyle = (
                    `background:${t.selectBg};border:1px solid ${t.selectBorder};color:${t.text};` +
                    "width:22px;height:22px;border-radius:3px;cursor:pointer;font-size:18px;line-height:1;padding:0;flex-shrink:0;"
                );
                const dec = document.createElement("button");
                dec.textContent   = "−";
                dec.style.cssText = btnStyle;
                const inc = document.createElement("button");
                inc.textContent   = "+";
                inc.style.cssText = btnStyle;
                const step = (delta) => {
                    item.value = Math.max(item.min, Math.min(item.max, item.value + delta));
                    item.onStep(item.value);
                    lbl.textContent = item.getLabel ? item.getLabel() : String(item.value);
                };
                dec.addEventListener("click", (e) => { e.stopPropagation(); step(-item.step); });
                inc.addEventListener("click", (e) => { e.stopPropagation(); step(+item.step); });
                row.append(lbl, dec, inc);
                sub.appendChild(row);
                continue;
            }

            // HSV Color Picker launcher
            if (item.picker) {
                const row = this._makeMenuRow("🎨", item.label, t, false);
                row.addEventListener("mouseenter", () => { row.style.background = t.menuHover; });
                row.addEventListener("mouseleave", () => { row.style.background = ""; });
                row.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this._closeContextMenu();
                    this._openColorPicker(e.clientX, e.clientY, item.currentHex ?? "#5470c6", item.onPick);
                });
                sub.appendChild(row);
                continue;
            }

            // Leaf item (selectable, closes menu)
            const row   = document.createElement("div");
            row.style.cssText = "display:flex;align-items:center;padding:5px 10px;cursor:pointer;gap:8px;user-select:none;";
            const check = document.createElement("span");
            check.textContent   = item.check ? "✓" : "";
            check.style.cssText = `width:12px;flex-shrink:0;color:${t.titleColor};font-size:19px;`;
            if (item.swatch) {
                const sw = document.createElement("div");
                sw.style.cssText = (
                    `width:14px;height:14px;border-radius:2px;flex-shrink:0;` +
                    `background:${item.swatch};border:1px solid ${t.border};`
                );
                row.append(check, sw);
            } else {
                row.append(check);
            }
            const lbl2 = document.createElement("span");
            lbl2.textContent = item.label;
            lbl2.style.color = t.text;
            row.appendChild(lbl2);
            row.addEventListener("mouseenter", () => { row.style.background = t.menuHover; });
            row.addEventListener("mouseleave", () => { row.style.background = ""; });
            row.addEventListener("click", (e) => { e.stopPropagation(); item.onSelect?.(); });
            sub.appendChild(row);
        }

        sub.addEventListener("mouseleave", (e) => {
            if (!sub.contains(e.relatedTarget)) sub.style.display = "none";
        });
        return sub;
    }

    /** Create a standard menu row with optional icon and arrow indicator. */
    _makeMenuRow(icon, label, t, hasArrow = true) {
        const row = document.createElement("div");
        row.style.cssText = (
            "display:flex;align-items:center;padding:6px 10px;" +
            "cursor:pointer;position:relative;gap:6px;user-select:none;"
        );
        if (icon) {
            const ic = document.createElement("span");
            ic.textContent   = icon;
            ic.style.cssText = `width:16px;text-align:center;flex-shrink:0;color:${t.dimText};`;
            row.appendChild(ic);
        }
        const lbl = document.createElement("span");
        lbl.textContent   = label;
        lbl.style.cssText = "flex:1;";
        row.appendChild(lbl);
        if (hasArrow) {
            const arrow = document.createElement("span");
            arrow.textContent   = "▶";
            arrow.style.cssText = `font-size:17px;color:${t.dimText};flex-shrink:0;`;
            row.appendChild(arrow);
        }
        return row;
    }

    /**
     * Wire hover show/hide flyout behavior between a menu row and its submenu.
     *
     * Submenus are teleported to document.body as position:fixed so they are
     * never clipped by an ancestor overflow:auto container (e.g. the parent
     * submenu, which needs overflow-y:auto for long item lists but implicitly
     * also clips horizontal overflow per the CSS spec).
     */
    _addFlyoutBehavior(row, submenu, parentMenu, t) {
        // Mark for bulk cleanup when the context menu closes.
        submenu.classList.add("ts-flyout");

        // Register with parent so sibling flyouts can be hidden on mouseenter.
        if (!parentMenu._flyoutRows) parentMenu._flyoutRows = [];
        parentMenu._flyoutRows.push({ row, submenu });

        let hideTimer = null;

        const _hideTree = (s) => {
            s.style.display = "none";
            (s._flyoutRows || []).forEach(({ row: r, submenu: cs }) => {
                r.style.background = "";
                _hideTree(cs);
            });
        };

        const doHide = () => {
            _hideTree(submenu);
            row.style.background = "";
        };

        const doShow = () => {
            clearTimeout(hideTimer);

            // Hide sibling flyouts.
            (parentMenu._flyoutRows || []).forEach(({ row: r, submenu: s }) => {
                if (r !== row) { _hideTree(s); r.style.background = ""; }
            });

            // Teleport to body as fixed on first show, escaping overflow containers.
            if (submenu.parentElement !== document.body) {
                document.body.appendChild(submenu);
                submenu.style.position = "fixed";
            }

            const rowRect = row.getBoundingClientRect();
            submenu.style.left   = `${rowRect.right}px`;
            submenu.style.top    = `${rowRect.top - 4}px`;
            submenu.style.right  = "auto";
            submenu.style.bottom = "auto";
            submenu.style.display = "block";
            row.style.background  = t.menuHover;

            const sr = submenu.getBoundingClientRect();

            // Horizontal: flip left if right edge overflows.
            if (sr.right > window.innerWidth - 8)
                submenu.style.left = `${rowRect.left - sr.width}px`;

            // Vertical: shift up if bottom edge overflows.
            if (sr.bottom > window.innerHeight - 8)
                submenu.style.top = `${rowRect.top - 4 - (sr.bottom - (window.innerHeight - 8))}px`;
        };

        row.addEventListener("mouseenter", doShow);
        row.addEventListener("mouseleave", (e) => {
            if (!submenu.contains(e.relatedTarget))
                hideTimer = setTimeout(doHide, 80);
        });
        submenu.addEventListener("mouseenter", () => clearTimeout(hideTimer));
        submenu.addEventListener("mouseleave", (e) => {
            if (!row.contains(e.relatedTarget))
                hideTimer = setTimeout(doHide, 80);
        });
    }

    _closeContextMenu() {
        const el = document.getElementById("ts-ctx-menu");
        if (el) { el._cleanup?.(); el.remove(); }
        document.querySelectorAll(".ts-flyout").forEach((s) => s.remove());
    }

    // ---- HSV Color Picker ----

    _openColorPicker(anchorX, anchorY, initialHex, onApply) {
        document.getElementById("ts-color-picker")?.remove();
        const t = this._theme();
        let { h, s, v } = _hexToHsv(initialHex);

        const panel = document.createElement("div");
        panel.id = "ts-color-picker";
        panel.style.cssText = (
            `position:fixed;z-index:10002;background:${t.menuBg};border:1px solid ${t.border};` +
            "border-radius:6px;box-shadow:0 8px 28px rgba(0,0,0,0.65);" +
            `padding:12px;font-family:monospace;font-size:16px;color:${t.text};user-select:none;width:224px;`
        );

        const titleEl = document.createElement("div");
        titleEl.textContent   = "Color Picker";
        titleEl.style.cssText = `font-size:17px;font-weight:bold;color:${t.titleColor};margin-bottom:10px;`;
        panel.appendChild(titleEl);

        const svCanvas = document.createElement("canvas");
        svCanvas.width = 200; svCanvas.height = 170;
        svCanvas.style.cssText = `display:block;cursor:crosshair;border-radius:3px;border:1px solid ${t.border};`;

        const hueCanvas = document.createElement("canvas");
        hueCanvas.width = 200; hueCanvas.height = 16;
        hueCanvas.style.cssText = `display:block;cursor:crosshair;margin-top:8px;border-radius:3px;border:1px solid ${t.border};`;

        const drawSV = () => {
            const ctx2 = svCanvas.getContext("2d");
            const [hr, hg, hb] = _hsvToRgb(h, 1, 1);
            const satGrad = ctx2.createLinearGradient(0, 0, svCanvas.width, 0);
            satGrad.addColorStop(0, "#fff"); satGrad.addColorStop(1, _rgbToHex(hr, hg, hb));
            ctx2.fillStyle = satGrad; ctx2.fillRect(0, 0, svCanvas.width, svCanvas.height);
            const valGrad = ctx2.createLinearGradient(0, 0, 0, svCanvas.height);
            valGrad.addColorStop(0, "rgba(0,0,0,0)"); valGrad.addColorStop(1, "#000");
            ctx2.fillStyle = valGrad; ctx2.fillRect(0, 0, svCanvas.width, svCanvas.height);
            const cx = s * svCanvas.width, cy = (1 - v) * svCanvas.height;
            ctx2.beginPath(); ctx2.arc(cx, cy, 6, 0, Math.PI * 2);
            ctx2.strokeStyle = v > 0.5 ? "#000" : "#fff"; ctx2.lineWidth = 2; ctx2.stroke();
        };

        const drawHue = () => {
            const ctx2 = hueCanvas.getContext("2d");
            const grad = ctx2.createLinearGradient(0, 0, hueCanvas.width, 0);
            for (let i = 0; i <= 6; i++) grad.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
            ctx2.fillStyle = grad; ctx2.fillRect(0, 0, hueCanvas.width, hueCanvas.height);
            const mx = (h / 360) * hueCanvas.width;
            ctx2.strokeStyle = "#fff"; ctx2.lineWidth = 2;
            ctx2.beginPath(); ctx2.moveTo(mx, 0); ctx2.lineTo(mx, hueCanvas.height); ctx2.stroke();
        };

        const preview  = document.createElement("div");
        const hexInput = document.createElement("input");

        const updatePreview = () => {
            const hex = _rgbToHex(..._hsvToRgb(h, s, v));
            preview.style.background = hex; hexInput.value = hex;
        };
        const redraw = () => { drawSV(); drawHue(); updatePreview(); };

        let svDragging = false;
        const svDrag = (e) => {
            const rect = svCanvas.getBoundingClientRect();
            s = Math.max(0, Math.min(1, (e.clientX - rect.left)  / rect.width));
            v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
            redraw();
        };
        const onSvMove = (e) => { if (svDragging) svDrag(e); };
        const onSvUp   = ()  => { svDragging = false; };
        svCanvas.addEventListener("mousedown", (e) => { svDragging = true; svDrag(e); });
        document.addEventListener("mousemove", onSvMove);
        document.addEventListener("mouseup",   onSvUp);

        let hueDragging = false;
        const hueDrag = (e) => {
            const rect = hueCanvas.getBoundingClientRect();
            h = Math.max(0, Math.min(360, ((e.clientX - rect.left) / rect.width) * 360));
            redraw();
        };
        const onHueMove = (e) => { if (hueDragging) hueDrag(e); };
        const onHueUp   = ()  => { hueDragging = false; };
        hueCanvas.addEventListener("mousedown", (e) => { hueDragging = true; hueDrag(e); });
        document.addEventListener("mousemove", onHueMove);
        document.addEventListener("mouseup",   onHueUp);

        const previewRow = document.createElement("div");
        previewRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:8px;";
        preview.style.cssText = `width:32px;height:24px;border-radius:3px;border:1px solid ${t.border};flex-shrink:0;`;
        hexInput.type      = "text"; hexInput.maxLength = 7; hexInput.placeholder = "#rrggbb";
        hexInput.style.cssText = (
            `background:${t.selectBg};color:${t.text};border:1px solid ${t.selectBorder};` +
            "border-radius:3px;padding:3px 6px;font-family:monospace;font-size:16px;width:80px;outline:none;"
        );
        hexInput.addEventListener("change", () => {
            const val = hexInput.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(val)) { ({ h, s, v } = _hexToHsv(val)); redraw(); }
        });
        previewRow.append(preview, hexInput);

        const btnRow = document.createElement("div");
        btnRow.style.cssText = "display:flex;gap:8px;margin-top:10px;";

        const cleanup = () => {
            document.removeEventListener("mousemove", onSvMove);
            document.removeEventListener("mouseup",   onSvUp);
            document.removeEventListener("mousemove", onHueMove);
            document.removeEventListener("mouseup",   onHueUp);
            document.removeEventListener("mousedown", onOutside);
            panel.remove();
        };

        const applyBtn = document.createElement("button");
        applyBtn.textContent   = "Apply";
        applyBtn.style.cssText = "background:#5470c6;color:#fff;border:none;border-radius:3px;padding:5px 0;cursor:pointer;font-size:16px;flex:1;";
        applyBtn.addEventListener("click", () => { onApply(_rgbToHex(..._hsvToRgb(h, s, v))); cleanup(); });

        const cancelBtn = document.createElement("button");
        cancelBtn.textContent   = "Cancel";
        cancelBtn.style.cssText = `background:${t.selectBg};color:${t.text};border:1px solid ${t.selectBorder};border-radius:3px;padding:5px 0;cursor:pointer;font-size:16px;flex:1;`;
        cancelBtn.addEventListener("click", cleanup);

        btnRow.append(cancelBtn, applyBtn);
        panel.append(titleEl, svCanvas, hueCanvas, previewRow, btnRow);
        document.body.appendChild(panel);

        const PW = 248, PH = 310;
        let px = anchorX + 8, py = anchorY;
        if (px + PW > window.innerWidth  - 8) px = anchorX - PW - 8;
        if (py + PH > window.innerHeight - 8) py = window.innerHeight - PH - 8;
        panel.style.left = `${Math.max(4, px)}px`;
        panel.style.top  = `${Math.max(4, py)}px`;

        const onOutside = (e) => { if (!panel.contains(e.target)) cleanup(); };
        setTimeout(() => document.addEventListener("mousedown", onOutside), 0);
        redraw();
    }

    // ---- Chart rendering ----

    _render() {
        if (!this.chart || !this.data) return;

        const t             = this._theme();
        const globalXCh     = this.config.x_ch ?? "";
        const globalYCh     = this.config.y_ch ?? "";
        const globalPlotType = this.config.plot_type;
        const fitDef        = FIT_TYPES[this.config.fit] ?? FIT_TYPES.none;
        const defaultColorCh = this.config.default_color_ch ?? "";
        const defaultSizeCh  = this.config.default_size_ch  ?? "";
        const visibility    = this.config.visibility;

        const ecSeries   = [];
        const visualMaps = [];
        const legendData = [];

        this.data.series.forEach((s, dataIdx) => {
            if (visibility?.[s.name] === false) return;

            const ov            = (this.config.series_styles ?? {})[s.name] ?? {};
            const xCh           = ov.x_ch || globalXCh;
            const yCh           = ov.y_ch || globalYCh;
            const xData         = s.data[xCh];
            const yData         = s.data[yCh];
            if (!xData || !yData) return;

            const n      = Math.min(xData.length, yData.length);
            const xSlice = xData.slice(0, n);
            const ySlice = yData.slice(0, n);
            const color  = this._getColor(dataIdx, s.name);
            const label  = s.name || `Series ${dataIdx + 1}`;

            const seriesPlotType = ov.plot_type ?? globalPlotType;
            const plotDef        = PLOT_TYPES[seriesPlotType] ?? PLOT_TYPES.line;

            // Determine active extra dimensions
            const colormapCh = ov.colormap_channel || defaultColorCh;
            const hasColormap = !!ov.colormap_enabled && !!colormapCh && !!s.data[colormapCh];
            const bubbleCh   = ov.bubble_channel || defaultSizeCh;
            const hasBubble  = !!ov.bubble_enabled && !!bubbleCh && !!s.data[bubbleCh]
                               && seriesPlotType === "scatter";

            let colorDim = null, sizeDim = null;
            let colIdx   = 2;
            if (hasColormap) colorDim = colIdx++;
            if (hasBubble)   sizeDim  = colIdx++;

            const colorRaw = hasColormap ? s.data[colormapCh].slice(0, n) : null;
            const sizeRaw  = hasBubble   ? s.data[bubbleCh].slice(0, n)   : null;

            // Build multi-column data points
            let points = [];
            for (let i = 0; i < n; i++) {
                const pt = [xSlice[i], ySlice[i]];
                if (hasColormap) pt.push(colorRaw[i]);
                if (hasBubble)   pt.push(sizeRaw[i]);
                points.push(pt);
            }

            // List break: insert null rows at large X gaps (line / area only)
            if (ov.list_break && (seriesPlotType === "line" || seriesPlotType === "area")) {
                points = _insertLineBreaks(points, 3.0);
            }

            // Build base series then replace data with multi-column version
            const ser = { ...plotDef.buildSeries(label, xSlice, ySlice, color), data: points };

            // Bubble symbolSize function
            if (hasBubble && sizeRaw) {
                const sMin  = Math.min(...sizeRaw);
                const sMax  = Math.max(...sizeRaw);
                const maxPx = ov.bubble_max_px ?? 30;
                const sdim  = sizeDim;
                ser.symbolSize = (val) => _normalizeBubble(val[sdim], sMin, sMax, 4, maxPx);
            }

            // Style overrides
            if ((seriesPlotType === "line" || seriesPlotType === "area") && ov.line_style)
                ser.lineStyle = { ...(ser.lineStyle ?? {}), type: ov.line_style };
            if (seriesPlotType === "scatter" && ov.symbol && !hasBubble)
                ser.symbol = ov.symbol;

            // Colormap: strip static color so visualMap drives the color
            if (hasColormap) {
                if (ser.itemStyle) delete ser.itemStyle.color;
                ser.encode = { x: 0, y: 1 };
                const cMin   = Math.min(...colorRaw);
                const cMax   = Math.max(...colorRaw);
                const scheme = COLORMAP_SCHEMES[ov.colormap_scheme ?? "viridis"] ?? COLORMAP_SCHEMES.viridis;
                visualMaps.push({
                    type:       "continuous",
                    seriesIndex: ecSeries.length,
                    dimension:   colorDim,
                    min:         cMin,
                    max:         cMax,
                    inRange:    { color: scheme.colors },
                    show:        false,
                });
            }

            ecSeries.push(ser);
            legendData.push(label);

            // Fit overlay
            if (fitDef.compute) {
                const fitData = fitDef.compute(xSlice, ySlice);
                if (fitData) {
                    const fitLabel = `${label} (${fitDef.label})`;
                    ecSeries.push({
                        name: fitLabel, type: "line", data: fitData, symbol: "none",
                        lineStyle: { type: "dashed", width: 1.5, color },
                        itemStyle: { color }, tooltip: { show: false },
                    });
                    legendData.push(fitLabel);
                }
            }
        });

        const xLabel = globalXCh === "__time__" ? "time" : globalXCh;
        const yLabel = globalYCh === "__time__" ? "time" : globalYCh;

        const axisCommon = {
            axisLabel: { color: t.labelColor, formatter: fmtNum },
            axisLine:  { lineStyle: { color: t.border } },
        };

        const xAxisCfg = { type: "value", name: xLabel, nameLocation: "middle", nameGap: 30,
            ...axisCommon, splitLine: { lineStyle: { color: t.splitLine } } };

        this.chart.setOption({
            backgroundColor: t.chartBg,
            animation:       false,
            visualMap:       visualMaps.length ? visualMaps : undefined,
            tooltip: {
                trigger: "axis", axisPointer: { type: "cross" },
                formatter(params) {
                    if (!params.length) return "";
                    const x    = params[0].value[0] ?? params[0].axisValue;
                    let   html = `<b>${xLabel}: ${typeof x === "number" ? fmtNum(x) : x}</b><br/>`;
                    for (const p of params) {
                        const y = Array.isArray(p.value) ? p.value[1] : p.value;
                        html += `${p.marker}${p.seriesName}: ${typeof y === "number" ? fmtNum(y) : y}<br/>`;
                    }
                    return html;
                },
            },
            legend:   { data: legendData, textStyle: { color: t.text }, type: "scroll", bottom: 30 },
            grid:     { top: 40, left: 110, right: 20, bottom: 70, containLabel: false },
            xAxis:    xAxisCfg,
            yAxis:    {
                type: "value", name: yLabel, nameLocation: "middle", nameGap: 50,
                ...axisCommon, splitLine: { lineStyle: { color: t.splitLine } },
            },
            dataZoom: [
                { type: "inside", xAxisIndex: 0, filterMode: "none" },
                { type: "inside", yAxisIndex: 0, filterMode: "none" },
                { type: "slider", xAxisIndex: 0, bottom: 5, height: 27,
                  borderColor: t.border, fillerColor: "rgba(100,100,180,0.2)",
                  handleStyle: { color: t.titleColor } },
                { type: "slider", yAxisIndex: 0, left: 5, width: 27,
                  borderColor: t.border, fillerColor: "rgba(100,100,180,0.2)",
                  handleStyle: { color: t.titleColor } },
            ],
            brush: { xAxisIndex: 0, yAxisIndex: 0, brushStyle: {
                borderWidth: 1, color: "rgba(100,100,200,0.15)", borderColor: "rgba(150,150,255,0.8)"
            }},
            series: ecSeries,
        }, true);
    }

    _toggleBoxZoom() {
        this._setBoxZoom(!this._boxZoomActive);
    }

    _setBoxZoom(active) {
        this._boxZoomActive = active;
        const b = this._boxZoomBtn;
        if (b) {
            b.style.cssText = active
                ? `background:#5555aa;border:1px solid #8888cc;color:#fff;padding:4px 10px;border-radius:3px;cursor:pointer;font-size:16px;`
                : this._btnStyle(this._theme());
        }
        if (!this.chart) return;
        if (active) {
            this.chart.dispatchAction({
                type: "takeGlobalCursor", key: "brush",
                brushOption: { brushType: "rect", brushMode: "single" },
            });
        } else {
            this.chart.dispatchAction({ type: "takeGlobalCursor", key: "brush", brushOption: false });
        }
    }

    _zoomReset() {
        // Full re-render clears any explicit axis bounds and restores auto-scale.
        this._render();
    }

    _zoomResetX() {
        if (!this.chart) return;
        this.chart.setOption({ xAxis: { min: undefined, max: undefined } }, false);
        this.chart.dispatchAction({ type: "dataZoom", xAxisIndex: 0, start: 0, end: 100 });
    }

    _zoomResetY() {
        if (!this.chart) return;
        this.chart.setOption({ yAxis: { min: undefined, max: undefined } }, false);
        this.chart.dispatchAction({ type: "dataZoom", yAxisIndex: 0, start: 0, end: 100 });
    }

    _zoomFitX() {
        if (!this.chart || !this.data) return;
        const [yLo, yHi] = this._getZoomedRange("y") ?? [-Infinity, Infinity];
        let xMin = Infinity, xMax = -Infinity;
        this._forVisiblePoints((x, y) => {
            if (y >= yLo && y <= yHi) { if (x < xMin) xMin = x; if (x > xMax) xMax = x; }
        });
        if (!isFinite(xMin)) return;
        const pad = (xMax - xMin) * 0.02 || Math.abs(xMax) * 0.02 || 1;
        this.chart.setOption({ xAxis: { min: xMin - pad, max: xMax + pad } }, false);
    }

    _zoomFitY() {
        if (!this.chart || !this.data) return;
        const [xLo, xHi] = this._getZoomedRange("x") ?? [-Infinity, Infinity];
        let yMin = Infinity, yMax = -Infinity;
        this._forVisiblePoints((x, y) => {
            if (x >= xLo && x <= xHi) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
        });
        if (!isFinite(yMin)) return;
        const pad = (yMax - yMin) * 0.02 || Math.abs(yMax) * 0.02 || 1;
        this.chart.setOption({ yAxis: { min: yMin - pad, max: yMax + pad } }, false);
    }

    /**
     * Returns [lo, hi] actual data values for the current zoom window on the
     * given axis ("x" or "y"). Reads startValue/endValue from the slider
     * dataZoom component (set by ECharts after user interaction), falling back
     * to percentage-based computation against the full data range.
     */
    _getZoomedRange(axis) {
        const opt   = this.chart.getOption();
        const field = axis === "x" ? "xAxisIndex" : "yAxisIndex";
        // Prefer the slider component — it reflects the handle position.
        const dz = (opt.dataZoom ?? []).find(d => d[field] != null && d.type === "slider")
                ?? (opt.dataZoom ?? []).find(d => d[field] != null);
        if (!dz) return null;
        if (dz.startValue != null && dz.endValue != null)
            return [+dz.startValue, +dz.endValue];
        // Percentage fallback: map start/end (0-100) onto the full data extent.
        const vals = [];
        this._forVisiblePoints(axis === "x" ? (x) => vals.push(x) : (_, y) => vals.push(y));
        if (!vals.length) return null;
        const lo = Math.min(...vals), hi = Math.max(...vals), range = hi - lo;
        return [lo + (dz.start ?? 0) / 100 * range, lo + (dz.end ?? 100) / 100 * range];
    }

    /** Calls cb(x, y) for every point in every visible series. */
    _forVisiblePoints(cb) {
        if (!this.data) return;
        const globalXCh = this.config.x_ch ?? "";
        const globalYCh = this.config.y_ch ?? "";
        for (const s of this.data.series) {
            if (this.config.visibility?.[s.name] === false) continue;
            const ov   = (this.config.series_styles ?? {})[s.name] ?? {};
            const xArr = s.data[ov.x_ch || globalXCh];
            const yArr = s.data[ov.y_ch || globalYCh];
            if (!xArr || !yArr) continue;
            const n = Math.min(xArr.length, yArr.length);
            for (let i = 0; i < n; i++) cb(xArr[i], yArr[i]);
        }
    }

    _setStatus(msg) {
        const el = document.getElementById("ts-dash-status");
        if (el) el.textContent = msg;
    }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
    name: "timeseries.Dashboard",

    nodeCreated(node) {
        if (node.comfyClass !== "TimeseriesDashboard") return;
        console.log(LOG, "nodeCreated", node.id);
        const configWidget = node.widgets?.find((w) => w.name === "_dashboard_config");
        hideWidget(configWidget);
        node._ts_configWidget = configWidget;
        node.addWidget("button", "Open Dashboard", null, () => {
            new Dashboard(String(node.id), node._ts_configWidget).open();
        });
    },

    loadedGraphNode(node) {
        if (node.comfyClass !== "TimeseriesDashboard") return;
        node._ts_configWidget = node.widgets?.find((w) => w.name === "_dashboard_config");
    },
});
