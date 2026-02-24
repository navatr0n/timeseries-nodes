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

// ---------------------------------------------------------------------------
// LiteGraph layout constants (must match what LiteGraph uses internally)
// ---------------------------------------------------------------------------
const LG_TITLE_HEIGHT  = 30;  // px – node title bar
const LG_SLOT_HEIGHT   = 20;  // px – height of each input/output slot row
const LG_WIDGET_HEIGHT = 22;  // px – height of a standard widget row
const LG_NODE_PADDING  = 6;   // px – bottom padding inside node body
const TABLE_ROW_PX     = 26;  // px – actual rendered row height (12px font + cell padding + border)
const TABLE_HEADER_PX  = 22;  // px – approximate height of the table header row
const TABLE_PAD_PX     = 10;  // px – breathing room above/below table content
const NODE_MIN_WIDTH       = 400; // px – minimum node width in canvas space
const OUTPUT_SLOT_MARGIN   = 32;  // px – right-side gap kept clear for output slot hit targets

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
  // Last output slot center is at Y = (N - 0.3) * LG_SLOT_HEIGHT; approximate
  // the slot area height as N * LG_SLOT_HEIGHT (adds a bit of breathing room).
  const slotAreaHeight = N * LG_SLOT_HEIGHT;
  return Math.max(tableHeight, slotAreaHeight) + LG_NODE_PADDING;
}

/** Sync output slots to match the current mapping rows and resize the node. */
function syncOutputSlots(node, rows) {
  const desired = rows.length || 1; // always keep at least 1 slot

  // Add missing slots
  while (node.outputs.length < desired) {
    const idx = node.outputs.length;
    node.addOutput(`channel_${idx}`, "CHANNEL");
  }
  // Remove excess slots (from the end, only if unconnected)
  while (node.outputs.length > desired) {
    const last = node.outputs[node.outputs.length - 1];
    if (last.links && last.links.length > 0) break; // don't remove connected slots
    node.removeOutput(node.outputs.length - 1);
  }

  // Rename slots to match the user-assigned channel names
  rows.forEach((row, i) => {
    if (node.outputs[i]) {
      node.outputs[i].name = row.name || row.source || `channel_${i}`;
    }
  });

  // Enforce correct height but preserve the user's current width.
  // Never clamp width upward — that prevents the user from shrinking the node.
  const h = computeNodeHeight(rows.length);
  node.setSize([node.size[0], h]);
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
  const headers = ["Source", "Name", "Pol", "Src Unit", "Tgt Unit", "Gain", "Offset", ""];
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
          if (node.outputs[rowIdx]) {
            node.outputs[rowIdx].name = el.value || rowData.source || `channel_${rowIdx}`;
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

    // Expose a method to rebuild rows from a column list
    setColumns(columns) {
      // Keep rows that still exist in the new column list
      const existing = new Map(rows.map((r) => [r.source, r]));
      const next = columns.map((col) => existing.get(col) || defaultRow(col));
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
 * Position and scale the table DOM element over the node on the canvas.
 * Called on every draw frame via onDrawForeground (which passes the 2D ctx).
 *
 * Uses app.canvas.ds (LiteGraph's DragAndScale) for positioning and CSS `zoom`
 * for scaling.  This avoids `transform: scale()` entirely — Safari has a
 * compositing bug where position:fixed + transform:scale at high values (>~1.5)
 * paints a "ghost" of the element at the top of the viewport.
 *
 * CSS `zoom` scales both content AND the layout box (like browser page zoom),
 * so there is no compositor layer overflow and no ghost artifact at any zoom.
 *
 * IMPORTANT: This function ONLY sets display:block when _visible is true.
 * The _visible flag is managed by syncTableVisibility (graph-switch events)
 * and onGraphCleared.  Without this guard, positionTableDOM would override
 * display:none on every frame and cause a "ghost table" when the node is in
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
  const margin   = 4;  // small horizontal inset so table doesn't touch node border

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
  const tableWidthCanvas  = node.size[0] - margin - OUTPUT_SLOT_MARGIN;

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

    // Initial sync of output slots + node size.
    syncOutputSlots(node, rows);

    // Override computeSize — LiteGraph uses this as the minimum size floor
    // when the user drags to resize. Return NODE_MIN_WIDTH so the user can
    // drag width freely above that, and always enforce the exact required height.
    node.computeSize = function () {
      const tableWidget = this.widgets?.find((w) => w.name === "_channel_table");
      const rowCount = tableWidget?._rows?.length ?? 0;
      const h = computeNodeHeight(rowCount);
      return [NODE_MIN_WIDTH, h];
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

      fetchColumnsFromNode(upstreamNode).then((columns) => {
        if (columns?.length) {
          const tableWidget = node.widgets?.find((w) => w.name === "_channel_table");
          tableWidget?.setColumns(columns);
        }
      });
    };

    // ---- Draw hook: reposition DOM table each frame ----
    const origOnDrawForeground = node.onDrawForeground?.bind(node);
    node.onDrawForeground = function (ctx) {
      origOnDrawForeground?.(ctx);

      // Lazily append to #graph-canvas-container on first draw.
      // This container has `overflow: clip` which clips ALL descendants
      // (including position:fixed), preventing the ghost compositor artifact
      // that occurs when the element is a child of document.body.
      const tw = node.widgets?.find((w) => w.name === "_channel_table");
      if (tw?._tableEl && !tw._tableEl.parentElement) {
        const container = document.getElementById("graph-canvas-container")
                          || ctx.canvas.parentElement
                          || document.body;  // fallback
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
 * Fetch the column list for a LoadTimeseries node by reading its "file" widget
 * and querying a lightweight server endpoint.
 */
async function fetchColumnsFromNode(loaderNode) {
  const fileWidget = loaderNode.widgets?.find((w) => w.name === "file");
  if (!fileWidget?.value) return null;

  try {
    const resp = await fetch(
      `/timeseries/columns?file=${encodeURIComponent(fileWidget.value)}`
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.columns ?? null;
  } catch {
    return null;
  }
}
