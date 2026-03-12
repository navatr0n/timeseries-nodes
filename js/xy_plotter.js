// js/xy_plotter.js
// Frontend extension for ChannelXYPlot (XY-Plotter-Simple) node.
//
// Range pre-population
// --------------------
// After each execution Python reads data_min/data_max from the CHANNEL dicts
// and returns them in ui.x_data_range / ui.y_data_range.  onExecuted() stores
// those values on the node.  When the user switches a dropdown to "manual" the
// stored range is written into the MIN/MAX widgets so they start with the
// actual data extents rather than the static 0 / 1 placeholders.
//
// Widget visibility
// -----------------
//   "auto"   → MIN/MAX widgets hidden (three-flag pattern, Node 2.0 aware)
//   "manual" → MIN/MAX widgets shown; pre-populated with last-known range

import { app } from "../../scripts/app.js";

const NODE_TYPE = "ChannelXYPlot";

// ---------------------------------------------------------------------------
// Widget show / hide helpers (three-flag pattern)
// ---------------------------------------------------------------------------

const HIDDEN_H = -4;

function saveOriginal(widget) {
    if (!widget._xyOrig) {
        widget._xyOrig = {
            type:        widget.type,
            computeSize: widget.computeSize,
            draw:        widget.draw,
        };
    }
}

function hideWidget(widget) {
    saveOriginal(widget);
    widget.type        = "hidden";
    widget.computeSize = () => [0, HIDDEN_H];
    widget.draw        = () => {};
    widget.serialize   = true;
}

function showWidget(widget) {
    if (!widget._xyOrig) return;
    widget.type        = widget._xyOrig.type;
    widget.computeSize = widget._xyOrig.computeSize;
    widget.draw        = widget._xyOrig.draw;
}

// ---------------------------------------------------------------------------
// Node size sync (classic + Node 2.0 layout store)
// ---------------------------------------------------------------------------

function syncNodeSize(node) {
    const [w, h] = node.computeSize();
    node.setSize([Math.max(node.size[0], w), h]);
    app.canvas.initLayoutMutations?.()?.resizeNode(node.id, {
        width:  node.size[0],
        height: node.size[1],
    });
    node.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------------------
// Axis mode toggle
// ---------------------------------------------------------------------------

function applyAxisMode(modeValue, minWidget, maxWidget, dataRange) {
    if (!minWidget || !maxWidget) return;
    if (modeValue === "manual") {
        showWidget(minWidget);
        showWidget(maxWidget);
        if (dataRange) {
            minWidget.value = dataRange[0];
            maxWidget.value = dataRange[1];
        }
    } else {
        hideWidget(minWidget);
        hideWidget(maxWidget);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function widgetsByName(node) {
    const map = {};
    for (const w of node.widgets ?? []) map[w.name] = w;
    return map;
}

function applyStoredRange(node, axis) {
    const byn = widgetsByName(node);
    if (axis === "x") {
        if (byn["x_range_mode"]?.value === "manual" && node._xyRangeX) {
            if (byn["x_min"]) byn["x_min"].value = node._xyRangeX[0];
            if (byn["x_max"]) byn["x_max"].value = node._xyRangeX[1];
        }
    } else {
        if (byn["y_range_mode"]?.value === "manual" && node._xyRangeY) {
            if (byn["y_min"]) byn["y_min"].value = node._xyRangeY[0];
            if (byn["y_max"]) byn["y_max"].value = node._xyRangeY[1];
        }
    }
}

// ---------------------------------------------------------------------------
// Initial visibility + callback setup
// ---------------------------------------------------------------------------

function setupNode(node) {
    const byn = widgetsByName(node);

    const xMode = byn["x_range_mode"];
    const xMin  = byn["x_min"];
    const xMax  = byn["x_max"];
    const yMode = byn["y_range_mode"];
    const yMin  = byn["y_min"];
    const yMax  = byn["y_max"];

    if (!xMode || !yMode) return;

    xMode.callback = (value) => {
        applyAxisMode(value, xMin, xMax, node._xyRangeX ?? null);
        syncNodeSize(node);
    };
    yMode.callback = (value) => {
        applyAxisMode(value, yMin, yMax, node._xyRangeY ?? null);
        syncNodeSize(node);
    };

    applyAxisMode(xMode.value, xMin, xMax, node._xyRangeX ?? null);
    applyAxisMode(yMode.value, yMin, yMax, node._xyRangeY ?? null);
    syncNodeSize(node);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

app.registerExtension({
    name: "timeseries.xyplotter",

    nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;

        // Capture data ranges returned by Python after each execution.
        // Python reads data_min/data_max from the CHANNEL dicts and passes them
        // out as ui.x_data_range / ui.y_data_range.
        const origOnExecuted = node.onExecuted?.bind(node);
        node.onExecuted = function (message) {
            origOnExecuted?.(message);
            if (Array.isArray(message?.x_data_range) && message.x_data_range.length === 2)
                this._xyRangeX = message.x_data_range;
            if (Array.isArray(message?.y_data_range) && message.y_data_range.length === 2)
                this._xyRangeY = message.y_data_range;
            // If already in manual mode, refresh the widget values immediately.
            applyStoredRange(this, "x");
            applyStoredRange(this, "y");
        };

        setupNode(node);
    },

    loadedGraphNode(node) {
        if (node.comfyClass !== NODE_TYPE) return;
        setupNode(node);
    },
});
