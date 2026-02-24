# Timeseries Nodes — Developer Notes

## Project Overview

ComfyUI custom nodes for loading and mapping time-series data (CSV, Parquet).

| Node | Purpose |
|------|---------|
| **LoadTimeseries** | Loads a CSV/Parquet file, detects the time column, infers sample rate, and outputs a `TIMESERIES` dict. |
| **ChannelMapper** | Takes a `TIMESERIES` input and lets the user configure per-channel transforms (gain, offset, polarity, unit conversion) via an interactive HTML table widget. Outputs individual `CHANNEL` dicts. |

## File Structure

```
timeseries_nodes/
  __init__.py              Python node definitions + /timeseries/columns API
  js/
    channel_mapper.js      DOM table widget, canvas positioning, LiteGraph hooks
    timeseries_upload.js   File upload widget (DATAUPLOAD custom widget type)
```

## Architecture

### Python ↔ JavaScript Communication

1. **JSON serialization** — The ChannelMapper table state is serialized to a JSON
   string in the hidden `channel_mapping` widget. Python parses it in
   `_parse_channel_mapping()`. This round-trips through save/load.

2. **API endpoint** — `GET /timeseries/columns?file=<name>` returns
   `{"columns": ["col1", "col2", ...]}`. The JS frontend calls this when a
   TIMESERIES connection is made, to auto-populate the table rows.

3. **Hidden widget contract** — `LoadTimeseries` exposes a hidden
   `accepted_extensions` widget that the upload JS reads to configure the
   file picker's `accept` attribute.

### Transform Order

Each channel applies transforms in this order:

```
result = polarity * gain * raw_value + offset
```

Where polarity is +1 or -1, gain is a multiplier, and offset is additive.

---

## DOM Widget Positioning Guide

> **This section documents hard-won lessons from 8+ iterations of fixing a
> "ghost table" rendering bug. Read this before modifying any positioning
> code in `channel_mapper.js`.**

### The Problem

When the ChannelMapper node is inside a subgraph and the canvas is zoomed
beyond ~150%, a semi-transparent "ghost" copy of the DOM table appears at
the top of the viewport (position 0,0). The ghost has the same content as
the real table, with the transparency of the container's `rgba(30,30,30,0.92)`
background.

### Root Cause

The ghost is a **browser compositor artifact**. When a `position: fixed`
element has `transform: scale(N)` applied with N > ~1.5, the GPU compositor
can rasterize the element's texture at the wrong viewport location. This is
a known class of rendering bugs in Safari (and occasionally Chrome).

However, **ComfyUI's own DOM widgets use the exact same CSS technique**
(`position: fixed` + `transform: scale`) and don't have this problem. The
difference is WHERE in the DOM tree the element lives:

- ComfyUI widgets → inside `#graph-canvas-container` (which has `overflow: clip`)
- Our initial implementation → directly on `document.body` (no clipping ancestor)

### The Key Insight: `overflow: clip`

The CSS property `overflow: clip` is the **only** overflow mode that clips
`position: fixed` descendants. Unlike `overflow: hidden` (which does NOT
clip fixed-position children), `overflow: clip` creates a clip boundary that
constrains all descendants regardless of positioning scheme.

The `#graph-canvas-container` element has:

```css
.graph-canvas-container {
  position: relative;
  overflow: clip;      /* THIS IS THE KEY */
  width: 100%;
  height: 100%;
}
```

When our table element is a child of this container, any compositor ghost
artifact is clipped to the container bounds and becomes invisible. When it's
on `document.body`, there's no clipping ancestor and the ghost paints freely.

### The Correct Positioning Pattern

We follow the canonical pattern from ComfyUI's `useAbsolutePosition.ts`:

```javascript
// Coordinate conversion (from useCanvasPositionConversion.ts):
const ds = app.canvas.ds;  // LiteGraph DragAndScale
const screenX = (canvasX + ds.offset[0]) * ds.scale + canvasRect.left;
const screenY = (canvasY + ds.offset[1]) * ds.scale + canvasRect.top;

// CSS properties:
el.style.position        = "fixed";
el.style.transformOrigin = "0 0";
el.style.transform       = `scale(${ds.scale})`;
el.style.left            = `${screenX}px`;   // viewport pixels
el.style.top             = `${screenY}px`;   // viewport pixels
el.style.width           = `${canvasW}px`;   // canvas-space pixels
el.style.height          = `${canvasH}px`;   // canvas-space pixels
```

- `left`/`top` are in screen (viewport) pixels — already account for scale
- `width`/`height` are in canvas-space pixels — `transform: scale()` handles
  the visual scaling
- `transform-origin: 0 0` anchors the scale at the top-left corner, matching
  the `left`/`top` position

### The `_visible` Flag Pattern

`positionTableDOM()` runs every draw frame and sets `display: block`.
Graph-navigation events (`litegraph:set-graph`, `graphCleared`) need to hide
the element with `display: none`. Without a flag, the per-frame `display: block`
immediately overrides `display: none`.

Solution: event handlers set `widget._visible = false`; `positionTableDOM`
checks `_visible` before setting `display: block`.

### Lazy DOM Mounting

Don't `appendChild` in `nodeCreated` — the canvas container may not be mounted
yet. Instead, check `!el.parentElement` on the first `onDrawForeground` call
and mount then.

### Failed Approaches (Do NOT Re-attempt)

| Approach | What Happened |
|----------|---------------|
| `document.body.appendChild(el)` | No clipping ancestor for `position: fixed`. Ghost artifact at >150% zoom. |
| CSS `zoom: ${scale}` instead of `transform: scale()` | `zoom` affects how `left`/`top` are interpreted. Table detaches from node. |
| `transform: matrix(a,0,0,d,tx,ty)` | Folding translation into the matrix still produces ghosts. Two on main canvas, one in subgraph. |
| Clip wrapper `<div>` on `document.body` with `overflow: hidden` | `overflow: hidden` does NOT clip `position: fixed` children. Ghost at ALL zoom levels. |
| `overflow: hidden` on the element itself | Only clips the element's own children, not compositor artifacts of the element itself. |
| `contain: strict` / `contain: layout paint` | Does not prevent the compositor artifact. |
| CSS `zoom` + ds-based positioning | Positioning formula breaks because `zoom` scales the layout box, changing how `left`/`top` are applied. |

---

## Key ComfyUI APIs Used

### Extension Hooks

| Hook | When It Fires | Our Use |
|------|---------------|---------|
| `nodeCreated(node)` | After a node instance is created | Build table widget, attach event listeners |
| `beforeRegisterNodeDef(nodeType, nodeData)` | Before a node type is registered | Inject DATAUPLOAD widget into LoadTimeseries |
| `getCustomWidgets()` | During widget system init | Register DATAUPLOAD widget implementation |

### LiteGraph Node Overrides

| Override | Purpose |
|----------|---------|
| `node.onDrawForeground(ctx)` | Reposition DOM table every frame; lazy mount |
| `node.onConnectionsChange(type, slot, connected, link, io)` | Detect TIMESERIES connections |
| `node.onRemoved()` | Clean up DOM element and event listeners |
| `node.computeSize()` | Enforce minimum width and calculated height |

### Events

| Event | Source | Purpose |
|-------|--------|---------|
| `litegraph:set-graph` | `app.canvas.canvas` (CustomEvent) | Fires on subgraph enter/exit, workflow load. `e.detail.newGraph` is the new active graph. |
| `graphCleared` | `api` (ComfyUI API event) | Fires on "Clear Workflow". |

**Caution:**
- Do NOT use `graphChanged` — that's a server WebSocket event, not a UI event.
- Do NOT rely on `subgraph-opening` alone — it only fires on enter, not on return.

---

## Troubleshooting

### Table not visible / disappears

1. Check `widget._visible` — is it `true`? If not, the `syncTableVisibility`
   handler may be hiding it. Verify the node is in `app.canvas.graph._nodes`.
2. Check `ds.scale` — if < 0.35, the table hides intentionally.
3. Check `el.parentElement` — is it the canvas container? If `null`, the lazy
   mount hasn't fired yet.

### Table positioned incorrectly

1. Verify `ds.offset` and `ds.scale` match what you see in the canvas.
2. Check `canvasEl.getBoundingClientRect()` — if the canvas element has an
   unexpected offset (e.g., sidebar open), `elRect.left`/`top` will shift.
3. Confirm `node.pos` is in canvas-space coordinates (it should be).

### Ghost / duplicate table

1. **Is the element in `#graph-canvas-container`?** If it fell back to
   `document.body`, the ghost will reappear. Check `el.parentElement.id`.
2. **Are there multiple DOM elements?** Each node creation adds one element.
   If `onRemoved` didn't clean up (e.g., due to an error), stale elements
   accumulate. Check `document.querySelectorAll('.channel-mapper-table').length`.

### Safari-specific debugging

Open Safari's Web Inspector (Develop > Show Web Inspector):
- **Elements tab**: Find `.channel-mapper-table`, check its computed styles
  and parent element.
- **Layers tab** (Develop > Show Compositing Borders): Visualize GPU
  compositor layers. The ghost appears as a separate compositing layer at
  viewport (0,0).
- **Console**: Log `app.canvas.ds` to see current offset/scale values.
