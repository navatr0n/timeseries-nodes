/**
 * xy_plot_overlay.js
 *
 * Frontend extension for the XYPlotOverlay node.
 *
 * Nodes 2.0 compatibility
 * -----------------------
 * In ComfyUI's Vue-based renderer ("Nodes 2.0"), combo widgets are mounted as
 * Vue components that read widget.options.values ONCE at mount time.  Mutating
 * the property in-place afterward doesn't trigger a re-render.
 *
 * Fix: instead of setting widget.options = { values: [...] } on an existing
 * combo, we REMOVE the old combo widget and RE-ADD it with the new options.
 * This forces Vue to unmount the old component and mount a fresh one.
 *
 * To make this safe across multiple calls, combo references are stored on the
 * node object (node._xy_xCombo / node._xy_yCombo) rather than in a closure.
 * Combos have serialize=false — their value is persisted via the hidden
 * x_channel / y_channel STRING widgets instead.
 */

import { app } from "../../scripts/app.js";

const LOG = "[XYPlotOverlay]";

// ---------------------------------------------------------------------------
// Widget helpers
// ---------------------------------------------------------------------------

function hideWidget(w) {
  if (!w) return;
  w.type        = "hidden";
  w.computeSize = () => [0, -4];
  w.draw        = () => {};
  w.serialize   = true;
}

/**
 * Remove the old X/Y Channel combo widgets and re-add them with the new
 * channel list.  Re-adding forces the Vue component to remount with correct
 * options in Nodes 2.0 mode.
 */
function setChannelOptions(node, channels) {
  const xWidget = node._xy_xWidget;
  const yWidget = node._xy_yWidget;
  const opts    = channels.length > 0 ? channels : [""];

  // Preserve current selection if it still exists in the new list.
  const savedX = node._xy_xCombo?.value || xWidget?.value || "";
  const savedY = node._xy_yCombo?.value || yWidget?.value || "";
  const initX  = opts.includes(savedX) ? savedX : opts[0];
  const initY  = opts.includes(savedY) ? savedY : opts[0];

  // Remove old combos via splice so Vue detects the mutation.
  const xIdx = (node.widgets ?? []).indexOf(node._xy_xCombo);
  if (xIdx >= 0) node.widgets.splice(xIdx, 1);
  const yIdx = (node.widgets ?? []).indexOf(node._xy_yCombo);
  if (yIdx >= 0) node.widgets.splice(yIdx, 1);

  // Re-add with the new options list (Vue mounts a fresh component).
  const xCombo = node.addWidget(
    "combo", "X Channel", initX,
    (v) => { if (xWidget) xWidget.value = v; },
    { values: opts }
  );
  const yCombo = node.addWidget(
    "combo", "Y Channel", initY,
    (v) => { if (yWidget) yWidget.value = v; },
    { values: opts }
  );

  // Value is stored in the hidden widgets — no need to serialize the combos.
  xCombo.serialize = false;
  yCombo.serialize = false;

  node._xy_xCombo = xCombo;
  node._xy_yCombo = yCombo;

  if (xWidget) xWidget.value = initX;
  if (yWidget) yWidget.value = initY;

  node.setDirtyCanvas(true);
}

// ---------------------------------------------------------------------------
// Synchronous upstream channel discovery
// ---------------------------------------------------------------------------

function channelMapperNames(mapperNode) {
  const w = mapperNode.widgets?.find((w) => w.name === "channel_mapping");
  if (!w?.value) return null;
  try {
    const rows = JSON.parse(w.value);
    return rows
      .filter((r) => r.enabled !== false)
      .map((r) => (r.source || "").trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function resolveChannelsSync(node, visited = new Set()) {
  if (!node || visited.has(node.id)) return null;
  visited.add(node.id);

  if (node.comfyClass === "ChannelMapper") return channelMapperNames(node);

  const tsInput = (node.inputs ?? []).find(
    (inp) => inp.type === "TIMESERIES" && inp.link != null
  );
  if (!tsInput) return null;

  const edge = app.graph.links[tsInput.link];
  if (!edge) return null;

  return resolveChannelsSync(app.graph.getNodeById(edge.origin_id), visited);
}

function channelsFromBundleSync(bundleNode) {
  const tsInputs = (bundleNode.inputs ?? []).filter(
    (inp) => inp.type === "TIMESERIES" && inp.link != null
  );
  if (tsInputs.length === 0) return [];

  const sets = [];
  for (const inp of tsInputs) {
    const edge = app.graph.links[inp.link];
    if (!edge) continue;
    const names = resolveChannelsSync(app.graph.getNodeById(edge.origin_id));
    if (names !== null && names.length > 0) sets.push(new Set(names));
  }

  if (sets.length === 0) return [];

  let common = sets[0];
  for (let i = 1; i < sets.length; i++) {
    common = new Set([...common].filter((x) => sets[i].has(x)));
  }
  return [...common];
}

// ---------------------------------------------------------------------------
// LIST-side pass-through resolution
// ---------------------------------------------------------------------------

function resolveListSourceSync(node, visited = new Set()) {
  if (!node || visited.has(node.id)) return null;
  visited.add(node.id);

  if (node.comfyClass === "TimeseriesListBundle") return node;
  if (node.comfyClass === "LoadHDF5List")         return node;

  const first = (node.inputs ?? []).find((inp) => inp.link != null);
  if (!first) return null;

  const edge = app.graph.links[first.link];
  if (!edge) return null;

  return resolveListSourceSync(app.graph.getNodeById(edge.origin_id), visited);
}

// ---------------------------------------------------------------------------
// Async fallback (LoadHDF5List only)
// ---------------------------------------------------------------------------

async function channelsFromLoadHDF5List(loadNode) {
  const w = loadNode.widgets?.find((w) => w.name === "filename");
  if (!w?.value) return [];
  try {
    const resp = await fetch(
      `/timeseries/list_channels?file=${encodeURIComponent(w.value)}`
    );
    const data = await resp.json();
    return Array.isArray(data.channels) ? data.channels : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Shared channel-update entry point
// ---------------------------------------------------------------------------

function applyFromSrc(node, src) {
  if (src.comfyClass === "TimeseriesListBundle") {
    const channels = channelsFromBundleSync(src);
    console.log(LOG, "channels found:", channels);
    if (channels.length > 0) {
      setChannelOptions(node, channels);
      return true;
    }
  }
  return false;
}

function applyFromSrcAsync(node, src) {
  if (src.comfyClass === "LoadHDF5List") {
    channelsFromLoadHDF5List(src).then((channels) => {
      if (channels.length > 0) setChannelOptions(node, channels);
    });
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "timeseries.XYPlotOverlay",

  nodeCreated(node) {
    if (node.comfyClass !== "XYPlotOverlay") return;
    console.log(LOG, "nodeCreated");

    const xWidget = node.widgets?.find((w) => w.name === "x_channel");
    const yWidget = node.widgets?.find((w) => w.name === "y_channel");
    hideWidget(xWidget);
    hideWidget(yWidget);

    // Store on node so setChannelOptions can always find them.
    node._xy_xWidget = xWidget;
    node._xy_yWidget = yWidget;

    // Initial combos (empty options — populated when wire is connected).
    const xCombo = node.addWidget(
      "combo", "X Channel", xWidget?.value ?? "",
      (v) => { if (xWidget) xWidget.value = v; },
      { values: [""] }
    );
    const yCombo = node.addWidget(
      "combo", "Y Channel", yWidget?.value ?? "",
      (v) => { if (yWidget) yWidget.value = v; },
      { values: [""] }
    );
    xCombo.serialize = false;
    yCombo.serialize = false;
    node._xy_xCombo = xCombo;
    node._xy_yCombo = yCombo;

    // ---- Connection handler (synchronous) ----
    const orig = node.onConnectionsChange?.bind(node);
    node.onConnectionsChange = function (type, slotIndex, connected, linkInfo, ioSlot) {
      orig?.(type, slotIndex, connected, linkInfo, ioSlot);
      if (type !== 1) return;

      const slot = node.inputs?.[slotIndex];
      if (slot?.name !== "timeseries_list") return;

      if (!connected) {
        setChannelOptions(node, []);
        return;
      }

      const srcId = linkInfo?.origin_id;
      if (srcId == null) return;

      const immediate = app.graph.getNodeById(srcId);
      const src = resolveListSourceSync(immediate);
      console.log(LOG, "connected →", src?.comfyClass, src?.id);
      if (!src) return;

      if (!applyFromSrc(node, src)) {
        applyFromSrcAsync(node, src);
      }
    };
  },

  loadedGraphNode(node) {
    if (node.comfyClass !== "XYPlotOverlay") return;

    const xWidget = node.widgets?.find((w) => w.name === "x_channel");
    const yWidget = node.widgets?.find((w) => w.name === "y_channel");

    // Re-store references in case configure() touched the widgets array.
    node._xy_xWidget = xWidget;
    node._xy_yWidget = yWidget;

    // Restore combo display values from the saved hidden widgets.
    if (node._xy_xCombo && xWidget) node._xy_xCombo.value = xWidget.value ?? "";
    if (node._xy_yCombo && yWidget) node._xy_yCombo.value = yWidget.value ?? "";

    // Wait for configure() to finish restoring links, then do a sync walk.
    setTimeout(() => {
      const inp = node.inputs?.find((i) => i.name === "timeseries_list");
      if (!inp?.link) return;

      const edge = app.graph.links[inp.link];
      if (!edge) return;

      const src = resolveListSourceSync(app.graph.getNodeById(edge.origin_id));
      console.log(LOG, "loadedGraphNode →", src?.comfyClass, src?.id);
      if (!src) return;

      if (!applyFromSrc(node, src)) {
        applyFromSrcAsync(node, src);
      }
    }, 100);
  },
});
