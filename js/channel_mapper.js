/**
 * channel_mapper.js
 *
 * Frontend extension for the ChannelMapper node.
 *
 * Features:
 *  - Renders a compact table widget (one row per channel) replacing the raw
 *    channel_mapping string input.
 *  - When a TIMESERIES is connected, reads the column list from the upstream
 *    LoadTimeseries node and auto-populates one row per column.
 *  - Dynamically adds/removes output slots to match the number of table rows.
 *  - Serialises the table state to JSON in the hidden channel_mapping widget
 *    so it round-trips through ComfyUI's graph save/load.
 *
 * Each row columns:
 *   Source | Name | Pol | Src Unit | Tgt Unit | Gain | Offset | (remove)
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ===========================================================================
// DOM OVERLAY ARCHITECTURE — READ THIS BEFORE MODIFYING POSITIONING CODE
// ===========================================================================
//
// This file renders an HTML table as a DOM overlay on top of the LiteGraph
// canvas.  Getting this right required extensive iteration (8+ attempts).
// The lessons below are hard-won — please read before making changes.
//
// ─── THE POSITIONING PATTERN ───────────────────────────────────────────
//
// We follow the EXACT pattern from ComfyUI's own useAbsolutePosition.ts:
//
//   position: fixed
//   transform-origin: 0 0
//   transform: scale(canvasScale)
//   left/top in screen (viewport) pixels
//   width/height in canvas-space pixels
//
// Coordinate conversion (from useCanvasPositionConversion.ts):
//
//   screenX = (canvasX + ds.offset[0]) * ds.scale + canvasRect.left
//   screenY = (canvasY + ds.offset[1]) * ds.scale + canvasRect.top
//
// Where ds = app.canvas.ds (LiteGraph's DragAndScale object).
//
// ─── THE CONTAINER RULE (MOST IMPORTANT) ───────────────────────────────
//
// The table element MUST be a child of #graph-canvas-container — NOT
// document.body.  This container has `overflow: clip` in its CSS, which
// is the ONLY overflow mode that clips position:fixed descendants.
//
// Without this, the browser's GPU compositor can paint a "ghost" copy of
// the element at viewport (0,0) when transform: scale(N) with N > ~1.5.
// This ghost is a well-known class of Safari compositing artifacts with
// position:fixed + CSS transforms.
//
// ─── THE _visible FLAG ─────────────────────────────────────────────────
//
// positionTableDOM() runs on every draw frame and sets display:block.
// Graph-navigation events (litegraph:set-graph, graphCleared) set
// display:none.  Without a flag, the per-frame display:block would
// immediately override display:none, causing the table to appear when
// the node's graph is not active.
//
// Solution: syncTableVisibility sets widget._visible = false; then
// positionTableDOM checks _visible before setting display:block.
//
// ─── LAZY DOM MOUNTING ─────────────────────────────────────────────────
//
// Don't appendChild in nodeCreated — the canvas container may not exist
// yet.  Instead, mount lazily on the first onDrawForeground call, where
// the canvas is guaranteed to be initialised.
//
// ─── WHAT NOT TO DO (FAILED APPROACHES) ────────────────────────────────
//
// All of these were tried and produce visual bugs:
//
//   document.body.appendChild(el)
//     -> No clipping ancestor for position:fixed. Ghost at >150% zoom.
//
//   CSS zoom: ${scale} instead of transform: scale()
//     -> zoom affects how left/top are interpreted. Table detaches from node.
//
//   transform: matrix(a,0,0,d,tx,ty) (fold translation into matrix)
//     -> Still produces ghost. Two ghosts on main canvas, one in subgraph.
//
//   Clip wrapper div on document.body with overflow:hidden
//     -> overflow:hidden does NOT clip position:fixed children. Ghost at
//        ALL zoom levels instead of just >150%.
//
//   overflow:hidden on the element itself
//     -> Only clips the element's own content, not compositor artifacts.
//
// ===========================================================================

// ---------------------------------------------------------------------------
// LiteGraph layout constants (must match what LiteGraph uses internally)
// ---------------------------------------------------------------------------
const LG_TITLE_HEIGHT  = 30;  // px – node title bar
const LG_SLOT_HEIGHT   = 20;  // px – height of each input/output slot row
const LG_WIDGET_HEIGHT = 22;  // px – height of a standard widget row
const LG_NODE_PADDING  = 50;  // px – bottom padding inside node body (keeps table from touching node edge)
const TABLE_ROW_PX     = 26;  // px – actual rendered row height (12px font + cell padding + border)
const TABLE_HEADER_PX  = 22;  // px – approximate height of the table header row
const TABLE_PAD_PX     = 10;  // px – breathing room above/below table content
const NODE_MIN_WIDTH       = 400; // px – minimum node width in canvas space
const OUTPUT_SLOT_MARGIN   = 100; // px – right-side gap for output slot labels (1/4 of NODE_MIN_WIDTH)

// ---------------------------------------------------------------------------
// Pinia nodeDefStore access — Info panel sync
// ---------------------------------------------------------------------------
//
// ComfyUI's Info inspector tab (TabInfo.vue) calls nodeDefStore.fromLGraphNode()
// to render a node's output list.  The store is populated once from /object_info,
// so ChannelMapper always shows ["channel_0"] regardless of runtime channel names.
//
// Fix: call store.addNodeDef({...nodeDef, output_name:[...], ...}) which does
//   t.value['ChannelMapper'] = new ComfyNodeDefImpl(updatedV1Data)
// This KEY REASSIGNMENT in the Pinia reactive map invalidates the nodeInfo
// computed (which tracks t.value['ChannelMapper']), triggering a full re-render.
//
// NOTE: Mutating nodeDef.outputs in-place (splice) does NOT work — Vue's computed
// tracks the KEY READ, not nested property mutations.  Key reassignment is required.
//
// Store ID 'nodeDef' was verified from the compiled ComfyUI frontend bundle
// (F('nodeDef', ...) call pattern in dialogService-*.js).
//
// Access path: document.getElementById('vue-app').__vue_app__
//                .config.globalProperties.$pinia._s.get('nodeDef')
// NOTE: ComfyUI mounts on #vue-app, NOT #app. Using #app silently returns null
//       via optional chaining — no exception, but _nodeDefStore stays null.
//
// Graceful degradation: if getNodeDefStore() returns null (Pinia internals changed
// in a future ComfyUI release), syncInfoPanelOutputs() silently no-ops and the
// Info tab falls back to static "channel_0" — no crash, no broken functionality.

let _nodeDefStore = null;

/** Lazily access the Pinia nodeDefStore (id='nodeDef') via Vue app internals. */
function getNodeDefStore() {
  if (_nodeDefStore) return _nodeDefStore;
  try {
    // ComfyUI mounts on #vue-app (confirmed: index.html + compiled Q.mount('#vue-app')).
    // Fallback searches all id'd elements in case the mount point changes in a future release.
    const el    = document.getElementById('vue-app')
                ?? [...document.querySelectorAll('[id]')].find((e) => e.__vue_app__);
    const pinia = el?.__vue_app__?.config?.globalProperties?.$pinia;
    _nodeDefStore = pinia?._s?.get('nodeDef') ?? null;
    if (!_nodeDefStore) {
      console.warn('[ChannelMapper] nodeDefStore (id="nodeDef") not found — Info tab will show static names');
    }
  } catch {
    // Fail silently — Info tab degrades to static "channel_0"
  }
  return _nodeDefStore;
}

/**
 * Re-register the ChannelMapper NodeDef in the Pinia store with updated output
 * names so the Info inspector tab shows the current live channel names.
 *
 * WHY addNodeDef (not splice):
 *   Vue's nodeInfo computed tracks the KEY READ t.value['ChannelMapper'].
 *   Mutating nodeDef.outputs in-place (splice) does NOT invalidate the computed
 *   because the key reference doesn't change.  store.addNodeDef() does:
 *     t.value['ChannelMapper'] = new ComfyNodeDefImpl(updatedV1Data)
 *   This KEY REASSIGNMENT invalidates nodeInfo → full Info tab re-render.
 *
 * The NodeDef is shared across all ChannelMapper instances; node.onSelected
 * re-syncs on each selection so multi-ChannelMapper workflows always show
 * the selected node's channels.
 *
 * @param {LGraphNode} node  - The ChannelMapper node instance.
 * @param {object[]}   rows  - Current table rows from widget._rows.
 */
function syncInfoPanelOutputs(node, rows) {
  const store = getNodeDefStore();
  if (!store) return;

  const nodeDef = store.fromLGraphNode(node);
  if (!nodeDef) return;

  // Build V1-format arrays that ComfyNodeDefImpl's constructor reads from
  // (it calls transformNodeDefV1ToV2 internally to build the V2 .outputs array).
  // Output 0 is always the annotated TIMESERIES; outputs 1..N are CHANNELs.
  const channelNames = rows.length > 0
    ? rows.map((row, i) => row.name || row.source || `channel_${i}`)
    : ['channel_0'];
  const names    = ['timeseries', ...channelNames];
  const types    = ['TIMESERIES', ...channelNames.map(() => 'CHANNEL')];
  const isList   = names.map(() => false);
  const tooltips = ['', ...(rows.length > 0
    ? rows.map((row) => row.source_unit ? `[${row.source_unit}]` : '')
    : [''])];

  // Re-register with updated V1 output fields.
  // addNodeDef() does: t.value['ChannelMapper'] = newSv  ← KEY REASSIGNMENT
  // This invalidates nodeInfo computed → NodeHelpContent re-renders with live names.
  // Spreading {...nodeDef} preserves all other V1 fields (name, display_name, input, etc.)
  store.addNodeDef({
    ...nodeDef,
    output:          types,
    output_name:     names,
    output_is_list:  isList,
    output_tooltips: tooltips,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default row values for a newly discovered column. */
function defaultRow(sourceCol) {
  return {
    source:      sourceCol,
    name:        sourceCol,
    polarity:    1,
    source_unit: "",
    unit:        "",
    gain:        1.0,
    offset:      0.0,
  };
}

/** Parse the JSON stored in the channel_mapping widget. */
function parseMapping(str) {
  try {
    const v = JSON.parse(str || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Serialise mapping rows to JSON and push into the hidden widget. */
function saveMappingToWidget(node, rows) {
  const w = node.widgets?.find((w) => w.name === "channel_mapping");
  if (w) w.value = JSON.stringify(rows);
}

/**
 * Compute the ideal node height given the current row count.
 *
 * Key insight: LiteGraph draws slot dots starting at Y=0 from the node body
 * top. Output slot i is at Y = (i + 0.7) * LG_SLOT_HEIGHT. The DOM table
 * overlay ALSO starts at Y=0. They OVERLAP vertically — they are NOT stacked.
 *
 * The correct node body height is whichever is taller: the table or the slot
 * area (so all slot dots and the full table are visible), plus bottom padding.
 */
function computeNodeHeight(rowCount) {
  const N = Math.max(rowCount, 1);
  const tableHeight = TABLE_HEADER_PX + rowCount * TABLE_ROW_PX + TABLE_PAD_PX;
  // +1 accounts for the fixed TIMESERIES output slot at index 0.
  const slotAreaHeight = (N + 1) * LG_SLOT_HEIGHT;
  return Math.max(tableHeight, slotAreaHeight) + LG_NODE_PADDING;
}

/** Sync output slots to match the current mapping rows and resize the node. */
function syncOutputSlots(node, rows) {
  const channelCount = rows.length || 1; // always keep at least 1 CHANNEL slot
  const totalDesired = channelCount + 1; // +1 for the TIMESERIES slot at index 0

  // Ensure output[0] is always the annotated TIMESERIES output.
  if (node.outputs.length === 0) {
    node.addOutput("timeseries", "TIMESERIES");
  } else if (node.outputs[0].type !== "TIMESERIES") {
    node.outputs[0].type          = "TIMESERIES";
    node.outputs[0].name          = "timeseries";
    node.outputs[0].localized_name = "timeseries";
  }

  // Add missing CHANNEL slots (indices 1..channelCount)
  while (node.outputs.length < totalDesired) {
    const idx = node.outputs.length - 1; // channel index (0-based among channels)
    node.addOutput(`channel_${idx}`, "CHANNEL");
  }
  // Remove excess CHANNEL slots (from the end, only if unconnected)
  while (node.outputs.length > totalDesired) {
    const last = node.outputs[node.outputs.length - 1];
    if (last.links && last.links.length > 0) break; // don't remove connected slots
    node.removeOutput(node.outputs.length - 1);
  }

  // Rename CHANNEL slots to match the user-assigned channel names.
  // CHANNEL outputs start at index 1 (index 0 is always TIMESERIES).
  // Must write BOTH name and localized_name: LiteGraph renders
  // `label || localized_name || name`, and ComfyUI's addOutputs() sets
  // localized_name before nodeCreated fires.
  rows.forEach((row, i) => {
    const outIdx = i + 1; // offset by 1 for the TIMESERIES slot
    if (node.outputs[outIdx]) {
      const label = row.name || row.source || `channel_${i}`;
      node.outputs[outIdx].name = label;
      node.outputs[outIdx].localized_name = label;
    }
  });

  // Enforce correct height but preserve the user's current width.
  // Never clamp width upward — that prevents the user from shrinking the node.
  const h = computeNodeHeight(rows.length);
  node.setSize([node.size[0], h]);

  // Keep the Info inspector tab in sync with the current live channel names.
  // This replaces the static "channel_0" from /object_info with the actual rows.
  syncInfoPanelOutputs(node, rows);
}

// ---------------------------------------------------------------------------
// Table widget builder
// ---------------------------------------------------------------------------

/**
 * Build (or rebuild) the HTML table widget on a ChannelMapper node.
 * Returns the rows array so callers can initialise it from saved state.
 */
function buildTableWidget(node) {
  // ---- Remove any existing table widget ----
  const existing = node.widgets?.find((w) => w.name === "_channel_table");
  if (existing) {
    node.widgets = node.widgets.filter((w) => w !== existing);
    existing._tableEl?.remove();
  }

  // ---- Read current saved mapping (for round-trip) ----
  const mappingWidget = node.widgets?.find((w) => w.name === "channel_mapping");
  let rows = parseMapping(mappingWidget?.value);

  // When the node is freshly added (no saved mapping) seed one placeholder
  // row so the table isn't empty and the output slot gets a meaningful name.
  // source: "" is a sentinel — it won't match any real column name, so
  // setColumns() will drop it and replace it with actual timeseries columns
  // the moment a TIMESERIES is connected.
  if (rows.length === 0) {
    rows = [{ source: "", name: "channel output", polarity: 1,
               source_unit: "", unit: "", gain: 1.0, offset: 0.0 }];
  }

  // ---- Inject stylesheet once to suppress number-input spinners ----
  // Inline styles cannot target pseudo-elements, so Chrome's ::webkit-inner-spin-button
  // (rendered in a separate compositor layer) is only suppressible via a stylesheet rule.
  if (!document.getElementById("comfy-channel-mapper-styles")) {
    const style = document.createElement("style");
    style.id = "comfy-channel-mapper-styles";
    style.textContent = `
      .channel-mapper-table input[type=number]::-webkit-inner-spin-button,
      .channel-mapper-table input[type=number]::-webkit-outer-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .channel-mapper-table input[type=number] {
        -moz-appearance: textfield;
      }
    `;
    document.head.appendChild(style);
  }

  // ---- Build DOM ----
  const container = document.createElement("div");
  container.className = "channel-mapper-table";
  container.style.cssText = `
    font-family: Arial, sans-serif;
    font-size: 12px;
    color: #ccc;
    padding: 4px 0;
    width: 100%;
    overflow: hidden;
    box-sizing: border-box;
    background: rgba(30, 30, 30, 0.92);
    border-radius: 4px;
    pointer-events: none;
  `;

  const table = document.createElement("table");
  table.style.cssText = "border-collapse: collapse; width: 100%; table-layout: fixed;";

  // Column widths as % of table width (must sum to ~100%).
  // Source | Name | Pol | SrcUnit | TgtUnit | Gain | Offset | ✕
  const colWidths = ["18%", "20%", "8%", "10%", "10%", "10%", "10%", "4%"];
  const colgroup = document.createElement("colgroup");
  colWidths.forEach((w) => {
    const col = document.createElement("col");
    col.style.width = w;
    colgroup.appendChild(col);
  });
  table.appendChild(colgroup);

  // Header row
  const thead = table.createTHead();
  const hrow = thead.insertRow();
  const headers = ["Source", "Name", "Pol", "Source Units", "Target Units", "Gain", "Offset", ""];
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    th.style.cssText = `
      padding: 2px 4px;
      text-align: left;
      border-bottom: 1px solid #555;
      white-space: nowrap;
      color: #aaa;
      font-size: 12px;
      font-family: Arial, sans-serif;
    `;
    hrow.appendChild(th);
  });

  const tbody = table.createTBody();
  container.appendChild(table);

  // ---- Row management ----
  function cellInput(value, width, type = "text") {
    const inp = document.createElement("input");
    inp.type = type;
    inp.value = value ?? "";
    inp.style.cssText = `
      width: ${width};
      background: #1a1a1a;
      border: 1px solid #444;
      color: #ddd;
      padding: 2px 4px;
      font-size: 12px;
      font-family: Arial, sans-serif;
      border-radius: 2px;
      box-sizing: border-box;
      pointer-events: auto;
    `;
    return inp;
  }

  function polaritySelect(value) {
    const sel = document.createElement("select");
    sel.style.cssText = `
      background: #1a1a1a;
      border: 1px solid #444;
      color: #ddd;
      padding: 2px 2px;
      font-size: 12px;
      font-family: Arial, sans-serif;
      border-radius: 2px;
      width: 52px;
      pointer-events: auto;
    `;
    ["+1", "-1"].forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v === "+1" ? "1" : "-1";
      opt.textContent = v;
      if (parseInt(value) === parseInt(opt.value)) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  function addRow(rowData, index) {
    const tr = tbody.insertRow();
    tr.style.borderBottom = "1px solid #333";
    tr._rowData = rowData;

    const cells = [
      { el: cellInput(rowData.source,      "100%"),  key: "source"      },
      { el: cellInput(rowData.name,        "100%"),  key: "name"        },
      { el: polaritySelect(rowData.polarity),        key: "polarity"    },
      { el: cellInput(rowData.source_unit, "100%"),  key: "source_unit" },
      { el: cellInput(rowData.unit,        "100%"),  key: "unit"        },
      { el: cellInput(rowData.gain,        "100%", "number"), key: "gain"   },
      { el: cellInput(rowData.offset,      "100%", "number"), key: "offset" },
    ];

    cells.forEach(({ el, key }) => {
      const td = tr.insertCell();
      td.style.padding = "2px 3px";
      td.appendChild(el);

      el.addEventListener("change", () => {
        rowData[key] = (key === "gain" || key === "offset")
          ? parseFloat(el.value) || 0
          : key === "polarity"
          ? parseInt(el.value)
          : el.value;
        saveMappingToWidget(node, rows);
        syncOutputSlots(node, rows);
      });
      el.addEventListener("input", () => {
        if (key === "name") {
          const rowIdx = rows.indexOf(rowData);
          const outIdx = rowIdx + 1; // +1 because output[0] is the TIMESERIES slot
          if (node.outputs[outIdx]) {
            // Write both name and localized_name — LiteGraph renders
            // `label || localized_name || name`, so updating only name
            // leaves the stale localized_name ("channel_0") as the winner.
            const label = el.value || rowData.source || `channel_${rowIdx}`;
            node.outputs[outIdx].name = label;
            node.outputs[outIdx].localized_name = label;
            node.setDirtyCanvas(true);
          }
        }
      });
    });

    // Remove button
    const tdDel = tr.insertCell();
    tdDel.style.padding = "2px 3px";
    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.title = "Remove channel";
    btn.style.cssText = `
      background: #3a1a1a;
      border: 1px solid #622;
      color: #f88;
      cursor: pointer;
      padding: 1px 5px;
      font-size: 12px;
      border-radius: 2px;
      pointer-events: auto;
    `;
    btn.addEventListener("click", () => {
      const idx = rows.indexOf(rowData);
      if (idx >= 0) rows.splice(idx, 1);
      saveMappingToWidget(node, rows);
      syncOutputSlots(node, rows);
      tr.remove();
      app.graph?.setDirtyCanvas(true);
    });
    tdDel.appendChild(btn);

    return tr;
  }

  // Render existing rows
  rows.forEach((row, i) => addRow(row, i));

  // ---- Custom widget object ----
  // computeSize returns [width, 0] so LiteGraph allocates no vertical space
  // for this widget — the DOM overlay is positioned absolutely instead.
  const widget = {
    name: "_channel_table",
    type: "DOM",
    _tableEl: container,
    _rows: rows,
    _visible: true,   // visibility flag — controlled by syncTableVisibility / onGraphCleared

    computeSize: () => [node.size[0], 0],

    // Expose a method to rebuild rows from a channel list and optional units.
    // units[i] is the source unit for channels[i] (from upstream timeseries).
    // For new rows: source_unit is pre-filled from units[i]; target unit
    // defaults to match source_unit when target is otherwise empty.
    setColumns(channels, units = []) {
      // Keep rows that still exist in the new channel list
      const existing = new Map(rows.map((r) => [r.source, r]));
      const next = channels.map((col, i) => {
        if (existing.has(col)) return existing.get(col);
        const srcUnit = units[i] || "";
        const row = defaultRow(col);
        row.source_unit = srcUnit;
        row.unit = srcUnit; // default target = source when adding a new row
        return row;
      });
      rows.length = 0;
      next.forEach((r) => rows.push(r));

      // Rebuild tbody
      while (tbody.rows.length) tbody.deleteRow(0);
      rows.forEach((row, i) => addRow(row, i));

      saveMappingToWidget(node, rows);
      syncOutputSlots(node, rows);
      app.graph?.setDirtyCanvas(true);
    },
  };

  node.widgets = node.widgets || [];
  node.widgets.push(widget);

  return { widget, rows };
}

// ---------------------------------------------------------------------------
// DOM overlay positioning
// ---------------------------------------------------------------------------

/**
 * Measure the canvas-space pixel width needed to display the longest output
 * slot label (the Name column).  Uses ctx.measureText() so the measurement
 * matches the exact font LiteGraph renders for slot labels.
 *
 * Returns the text width in canvas-space pixels, or 0 if there are no rows.
 * Callers should add padding for the slot connector dot (~20 px).
 */
function measureOutputLabelWidth(ctx, rows) {
  if (!rows?.length) return 0;

  // Find the longest display name across all rows.
  const longest = rows.reduce((max, row) => {
    const label = row.name || row.source || "";
    return label.length > max.length ? label : max;
  }, "");

  if (!longest) return 0;

  // Measure using the same font LiteGraph uses for output slot labels.
  const prevFont = ctx.font;
  ctx.font = "11px Arial";
  const width = ctx.measureText(longest).width;
  ctx.font = prevFont;

  return width;
}

/**
 * Position and scale the table DOM element over the node on the canvas.
 * Called on every draw frame via onDrawForeground (which passes the 2D ctx).
 *
 * Uses the canonical ComfyUI DOM widget positioning pattern from
 * useAbsolutePosition.ts in the ComfyUI_frontend repo:
 *
 *   position: fixed
 *   transform-origin: 0 0
 *   transform: scale(canvasScale)
 *   left/top: screen (viewport) pixels
 *   width/height: canvas-space pixels (transform handles visual scaling)
 *
 * Coordinate conversion matches useCanvasPositionConversion.ts:
 *   screenX = (canvasX + ds.offset[0]) * ds.scale + canvasRect.left
 *   screenY = (canvasY + ds.offset[1]) * ds.scale + canvasRect.top
 *
 * CRITICAL: The table element MUST be a child of #graph-canvas-container
 * (not document.body).  That container has `overflow: clip` which clips ALL
 * descendants — including position:fixed elements.  Without this, the
 * browser compositor can paint a "ghost" of the element at viewport (0,0)
 * when scale > ~1.5.  See DEVELOPER_NOTES.md for the full explanation.
 *
 * IMPORTANT: This function ONLY sets display:block when _visible is true.
 * The _visible flag is managed by syncTableVisibility (graph-switch events)
 * and onGraphCleared.  Without this guard, positionTableDOM would override
 * display:none on every frame and cause a stale table when the node is in
 * a graph that is not currently displayed.
 */
function positionTableDOM(node, ctx) {
  const tableWidget = node.widgets?.find((w) => w.name === "_channel_table");
  if (!tableWidget?._tableEl) return;

  const el = tableWidget._tableEl;

  // Respect the visibility flag set by syncTableVisibility / onGraphCleared.
  if (!tableWidget._visible) {
    el.style.display = "none";
    return;
  }

  // Hide when zoomed out too far (table would be unreadably tiny) or collapsed.
  const ds    = app.canvas.ds;
  const scale = ds.scale;
  if (scale < 0.35 || node.flags?.collapsed) {
    el.style.display = "none";
    return;
  }

  const canvasEl = ctx.canvas;
  const elRect   = canvasEl.getBoundingClientRect();
  const margin   = 15; // px – left inset so table doesn't touch node border

  // Canvas-to-client coordinate conversion.
  // Matches ComfyUI's useCanvasPositionConversion.ts:
  //   clientX = (canvasX + offset[0]) * scale + canvasElement.left
  // node.pos is the title bar top-left; body starts LG_TITLE_HEIGHT below.
  const bodyX      = node.pos[0] + margin;
  const bodyY      = node.pos[1] + LG_TITLE_HEIGHT;
  const screenLeft = (bodyX + ds.offset[0]) * scale + elRect.left;
  const screenTop  = (bodyY + ds.offset[1]) * scale + elRect.top;

  const rowCount          = tableWidget._rows?.length ?? 0;
  const tableHeightCanvas = TABLE_HEADER_PX + rowCount * TABLE_ROW_PX + TABLE_PAD_PX;

  // Dynamic right margin: at least OUTPUT_SLOT_MARGIN (100px), expanding to
  // fit the longest Name label.  measureOutputLabelWidth returns the raw
  // canvas-2D text width; the 1.6 scalar accounts for LiteGraph rendering
  // at a slightly different effective font size than ctx.measureText, plus
  // breathing room around the text.  20px is added for the slot connector
  // dot and the gap between the dot and the label text.
  const labelPx      = measureOutputLabelWidth(ctx, tableWidget._rows);
  const outputMargin = Math.max(OUTPUT_SLOT_MARGIN, labelPx * 1.6 + 20);
  const tableWidthCanvas  = node.size[0] - margin - outputMargin;

  // Canonical ComfyUI DOM widget positioning (from useAbsolutePosition.ts):
  //   position: fixed + transform-origin: 0 0 + transform: scale(S)
  //   left/top in screen (viewport) pixels; width/height in canvas-space pixels.
  // The element lives inside #graph-canvas-container which has overflow:clip,
  // preventing any compositor ghost artifacts from escaping.
  Object.assign(el.style, {
    position:        "fixed",
    transformOrigin: "0 0",
    transform:       `scale(${scale})`,
    left:            `${screenLeft}px`,
    top:             `${screenTop}px`,
    width:           `${tableWidthCanvas}px`,
    height:          `${tableHeightCanvas}px`,
    zIndex:          "10",
    display:         "block",
    pointerEvents:   "none",
    overflow:        "hidden",
  });
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

app.registerExtension({
  name: "timeseries.ChannelMapper",

  nodeCreated(node) {
    if (node.comfyClass !== "ChannelMapper") return;

    // ---- Completely hide the raw channel_mapping string widget ----
    // Must be done before buildTableWidget so the widget list is already trimmed.
    const mappingWidget = node.widgets?.find((w) => w.name === "channel_mapping");
    if (mappingWidget) {
      mappingWidget.type         = "hidden";
      mappingWidget.computeSize  = () => [0, -4]; // negative height removes gap
      mappingWidget.draw         = () => {};       // skip drawing entirely
      mappingWidget.serialize    = true;           // still save the JSON value
    }

    // ---- Suppress the notes widget on the canvas ----
    // Notes are edited via the Parameters inspector tab; the canvas stays clean.
    // IMPORTANT: do NOT set type="hidden" — that flag is what the Parameters tab
    // checks to decide whether to render the widget as an interactive input.
    // Instead, suppress canvas rendering only via draw() and computeSize().
    // The native type (e.g. "customtext") is preserved so the Parameters tab
    // renders a proper editable textarea.
    const notesWidget = node.widgets?.find((w) => w.name === "notes");
    if (notesWidget) {
      notesWidget.computeSize = () => [0, -4]; // zero canvas height — no space allocated
      notesWidget.draw        = () => {};       // no-op draw — invisible on canvas
      notesWidget.serialize   = true;           // round-trips through save/load
    }

    // Build the table widget.  DOM attachment is deferred to the first
    // onDrawForeground call (lazy mount) so the canvas container is
    // guaranteed to exist.  See the onDrawForeground hook below.
    const { widget, rows } = buildTableWidget(node);
    const tableEl = widget._tableEl;

    // Show/hide the table based on whether this node's graph is the active one.
    // This covers: entering/leaving subgraphs, switching workflows, clearing.
    //
    // These handlers set the widget._visible FLAG rather than directly toggling
    // display.  positionTableDOM (called every draw frame) checks _visible and
    // skips positioning + hides the element when false.  This prevents the
    // "ghost table" bug where positionTableDOM's unconditional display:block
    // would override the display:none set here on the very next frame.

    // graphCleared fires when "Clear Workflow" is clicked (api event).
    const onGraphCleared = () => {
      widget._visible = false;
      tableEl.style.display = "none";
    };
    api.addEventListener("graphCleared", onGraphCleared);

    // litegraph:set-graph fires on every graph transition (workflow load,
    // entering a subgraph, returning to parent graph). The event detail
    // contains `newGraph` — the graph that is now active.
    //
    // We check if THIS node is in newGraph: show if yes, hide if no.
    // This mirrors how ComfyUI's own DOMWidgetImpl manager works:
    //   for each widget: id in newGraph.widgets ? active=true : active=false
    //
    // NOTE: do NOT use "graphChanged" (server WebSocket event, not UI navigation)
    //       or "subgraph-opening" alone (only fires on enter, not on return).
    const syncTableVisibility = (e) => {
      const newGraph = e?.detail?.newGraph;
      if (!newGraph) {
        widget._visible = false;
        tableEl.style.display = "none";
        return;
      }
      const nodeInGraph = !!(
        newGraph._nodes?.includes(node) ||
        newGraph.getNodeById?.(node.id)
      );
      widget._visible = nodeInGraph;
      // When hidden, set display:none immediately so there's no single-frame flash.
      // When visible, let positionTableDOM handle display:block on the next frame
      // (it needs to compute the correct position first).
      if (!nodeInGraph) tableEl.style.display = "none";
    };
    app.canvas.canvas.addEventListener("litegraph:set-graph", syncTableVisibility);

    // Initial sync of output slots + node size (also calls syncInfoPanelOutputs).
    syncOutputSlots(node, rows);

    // Expand to a comfortable initial width for freshly-added nodes.
    // The table has 8 columns; 800 px gives each column ~85 px of space.
    // Loaded nodes: configure() restores the JSON-saved width after nodeCreated,
    // so this only affects nodes added fresh from the node browser.
    node.setSize([800, node.size[1]]);

    // Re-sync the Info panel whenever this node is selected.  Handles multi-
    // ChannelMapper workflows where the shared NodeDef may have been overwritten
    // by a different instance since this node was last active.
    node.onSelected = function () {
      const tw = this.widgets?.find((w) => w.name === '_channel_table');
      syncInfoPanelOutputs(this, tw?._rows ?? []);
    };

    // Override computeSize — LiteGraph uses this as the minimum size floor
    // when the user drags to resize. Return NODE_MIN_WIDTH so the user can
    // drag width freely above that, and always enforce the exact required height.
    node.computeSize = function () {
      const tableWidget = this.widgets?.find((w) => w.name === "_channel_table");
      const rowCount = tableWidget?._rows?.length ?? 0;
      const h = computeNodeHeight(rowCount);
      return [NODE_MIN_WIDTH, h];
    };

    // Lock vertical height — allow the user to resize width freely, but
    // snap height back to the table-dictated value on every resize.
    // LiteGraph calls onResize(this.size) inside setSize(), and since
    // `size` is the same reference as `this.size`, mutating size[1] here
    // directly writes back to the node's actual size.
    node.onResize = function (size) {
      const tw = this.widgets?.find((w) => w.name === "_channel_table");
      const rowCount = tw?._rows?.length ?? 0;
      size[1] = computeNodeHeight(rowCount);
    };

    // ---- Watch for TIMESERIES connections ----
    const origOnConnectionsChange = node.onConnectionsChange?.bind(node);
    node.onConnectionsChange = function (type, slotIndex, connected, link, ioSlot) {
      origOnConnectionsChange?.(type, slotIndex, connected, link, ioSlot);

      // Input slot 0 is the TIMESERIES input
      if (type !== 1 /* INPUT */ || slotIndex !== 0) return;
      if (!connected) return;

      const upstreamNode = findUpstreamNode(node, 0);
      if (!upstreamNode) return;

      fetchColumnsFromNode(upstreamNode).then((result) => {
        if (result?.channels?.length) {
          const tableWidget = node.widgets?.find((w) => w.name === "_channel_table");
          tableWidget?.setColumns(result.channels, result.units ?? []);
        }
      });
    };

    // ---- Draw hook: reposition DOM table each frame ----
    const origOnDrawForeground = node.onDrawForeground?.bind(node);
    node.onDrawForeground = function (ctx) {
      origOnDrawForeground?.(ctx);

      // Lazy DOM mount: append to #graph-canvas-container on first draw.
      //
      // WHY this container?  It has `overflow: clip` — the only CSS overflow
      // mode that clips position:fixed descendants.  This prevents the GPU
      // compositor from painting a "ghost" of our element at viewport (0,0)
      // when transform: scale(N) with N > ~1.5.  Appending to document.body
      // would produce this ghost.  See the architecture block at the top of
      // this file for the full explanation.
      //
      // WHY lazy?  At nodeCreated time the canvas container may not exist
      // yet.  On the first onDrawForeground call it is guaranteed mounted.
      const tw = node.widgets?.find((w) => w.name === "_channel_table");
      if (tw?._tableEl && !tw._tableEl.parentElement) {
        const container = document.getElementById("graph-canvas-container")
                          || ctx.canvas.parentElement
                          || document.body;  // fallback (should never happen)
        container.appendChild(tw._tableEl);
      }

      positionTableDOM(node, ctx);
    };

    // ---- Cleanup on remove ----
    const origOnRemoved = node.onRemoved?.bind(node);
    node.onRemoved = function () {
      // Remove DOM element from document
      const tw = node.widgets?.find((w) => w.name === "_channel_table");
      tw?._tableEl?.remove();
      // Remove global listeners to prevent memory leaks
      api.removeEventListener("graphCleared", onGraphCleared);
      app.canvas.canvas.removeEventListener("litegraph:set-graph", syncTableVisibility);
      origOnRemoved?.();
    };
  },
});

// ---------------------------------------------------------------------------
// Upstream node helpers
// ---------------------------------------------------------------------------

/** Find the node connected to input slot `slotIdx` of `node`. */
function findUpstreamNode(node, slotIdx) {
  const input = node.inputs?.[slotIdx];
  if (!input?.link) return null;
  const link = app.graph.links[input.link];
  if (!link) return null;
  return app.graph.getNodeById(link.origin_id);
}

/**
 * Fetch channels and units from an upstream node.
 *
 * LoadTimeseries: reads the file widget and queries the /timeseries/columns
 * endpoint which returns {channels, units} (units are empty for raw CSV files).
 *
 * ChannelMapper: reads the upstream node's table widget directly to get the
 * channel names (source column) and their configured target units — these
 * become the source units for the downstream mapper.
 *
 * Returns {channels: string[], units: string[]} or null.
 */
async function fetchColumnsFromNode(upstreamNode) {
  // Case 1: LoadTimeseries — fetch from the CSV file endpoint
  const fileWidget = upstreamNode.widgets?.find((w) => w.name === "file");
  if (fileWidget?.value) {
    try {
      const resp = await fetch(
        `/timeseries/columns?file=${encodeURIComponent(fileWidget.value)}`
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return { channels: data.channels ?? [], units: data.units ?? [] };
    } catch {
      return null;
    }
  }

  // Case 2: ChannelMapper upstream — read its table rows directly.
  // The upstream mapper's target units become the source units here.
  if (upstreamNode.comfyClass === "ChannelMapper") {
    const tableWidget = upstreamNode.widgets?.find((w) => w.name === "_channel_table");
    const upstreamRows = tableWidget?._rows ?? [];
    const channels = upstreamRows.map((r) => r.source).filter(Boolean);
    const units    = upstreamRows.map((r) => r.unit || "");
    return channels.length ? { channels, units } : null;
  }

  return null;
}
