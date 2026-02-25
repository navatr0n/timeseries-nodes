# Timeseries Nodes — Developer Notes

## Project Overview

ComfyUI custom nodes for loading and mapping time-series data (CSV, Parquet).

| Node | Purpose |
|------|---------|
| **LoadTimeseries** | Loads a CSV/Parquet file, detects the time column, infers sample rate, and outputs a `TIMESERIES` dict. |
| **ChannelMapper** | Takes a `TIMESERIES` input and lets the user configure per-channel transforms (gain, offset, polarity, unit conversion) via an interactive HTML table widget. Outputs individual `CHANNEL` dicts. |
| **ChannelXYPlot** | Plots two `CHANNEL` signals as an XY line chart using matplotlib. Outputs a standard ComfyUI `IMAGE` tensor. Requires `pip install matplotlib`. |

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
| `node.onResize(size)` | Lock vertical height to table-dictated value; allow free horizontal resize |
| `node.onSelected()` | Re-sync the Info panel with this node's channel names (handles multi-instance workflows) |

### Events

| Event | Source | Purpose |
|-------|--------|---------|
| `litegraph:set-graph` | `app.canvas.canvas` (CustomEvent) | Fires on subgraph enter/exit, workflow load. `e.detail.newGraph` is the new active graph. |
| `graphCleared` | `api` (ComfyUI API event) | Fires on "Clear Workflow". |

**Caution:**
- Do NOT use `graphChanged` — that's a server WebSocket event, not a UI event.
- Do NOT rely on `subgraph-opening` alone — it only fires on enter, not on return.

---

## Output Slot Naming Guide

> **Read this before touching any code that renames output slots on the
> ChannelMapper node.**

### The Problem

Output slots always showed "channel_0" regardless of:
- The column name fetched from the upstream LoadTimeseries node
- The name the user typed into the Name cell of the table

### Root Cause: LiteGraph slot label priority

LiteGraph renders a slot's visible label using this priority order (from the
bundled LiteGraph source):

```js
get renderingLabel() { return this.label || this.localized_name || this.name || ``; }
```

ComfyUI's `addOutputs()` utility (in `dialogService-*.js`) sets `localized_name`
from Python's `RETURN_NAMES` **before** the `nodeCreated` extension hook fires:

```js
// Inside addOutputs(), called during node instantiation:
e.addOutput(t, i, { localized_name: q(..., t) });  // e.g. "channel_0"
```

Because `localized_name` has higher priority than `name`, and because it is set
to "channel_0" before our extension code runs, any subsequent write to only
`node.outputs[i].name` is silently ignored in the rendered label.

### The Fix

**Always write both `name` and `localized_name` together** when renaming a slot:

```javascript
// WRONG — localized_name still wins, label stays "channel_0"
node.outputs[i].name = "my_channel";

// CORRECT — overwrites both fields so both are in sync
const label = "my_channel";
node.outputs[i].name = label;
node.outputs[i].localized_name = label;
node.setDirtyCanvas(true);
```

This applies in every location that renames a slot:
1. `syncOutputSlots()` — called when columns are loaded or rows change
2. The `input` event listener on the Name cell in `addRow()` — called on every keystroke

### Timing note

`configure()` is called **after** `nodeCreated` when loading a saved workflow.
It restores serialised slot properties including `localized_name`. So a workflow
saved after the fix will have the correct `localized_name` in the JSON and will
round-trip correctly.

---

## Dynamic RETURN_TYPES Guide

> **Read this before modifying `ChannelMapper.RETURN_TYPES`.**

### The Challenge

ComfyUI uses `RETURN_TYPES` in three different ways, with conflicting requirements
for a node whose output count is determined at runtime:

| Use | Code | Requirement |
|-----|------|-------------|
| Prompt validation | `RETURN_TYPES[slot_index]` (execution.py ~841) | Must not raise `IndexError` for any slot |
| Execution output storage | `range(len(RETURN_TYPES))` | Must be ≥ actual number of outputs |
| `/object_info` serialisation | `json.dumps(RETURN_TYPES)` | Must yield `["CHANNEL"]` — 1 initial slot |

### Why a plain `("CHANNEL",)` breaks things — two separate bugs

**Bug 1 — Validation** (`execution.py` ~line 841):
```python
received_type = cls.RETURN_TYPES[val[1]]   # val[1] = output slot index
```
`("CHANNEL",)[1]` → `IndexError: tuple index out of range`

**Bug 2 — Output storage** (`execution.py` `merge_result_data`):
```python
output_is_list = [False] * len(results[0])  # default: N Falses (correct)
if hasattr(obj, "OUTPUT_IS_LIST"):
    output_is_list = obj.OUTPUT_IS_LIST      # overwrites with (False,)

for i, is_list in zip(range(len(results[0])), output_is_list):
    # zip truncates to the SHORTER iterable!
    # zip(range(16), (False,)) → only ONE iteration → only slot 0 stored
    output.append([o[i] for o in results])
```
If `OUTPUT_IS_LIST = (False,)` is declared (length 1), `zip` truncates to 1
iteration and **only slot 0 gets stored**. All downstream nodes reading slots
1–N receive `None`.

### The solution

**For Bug 1** — `_UnboundedChannelTypes`:
```python
class _UnboundedChannelTypes(tuple):
    def __getitem__(self, index):
        if isinstance(index, slice): return super().__getitem__(index)
        return "CHANNEL"   # any integer index → never IndexError
```
Note: `__len__` is NOT overridden. `len(RETURN_TYPES)` is never used by the
output-storage code path — only by ExecutionBlocker expansion, which is
irrelevant here.

**For Bug 2** — **do not declare `OUTPUT_IS_LIST` on `ChannelMapper`**.
Without it, `merge_result_data` uses the default `[False] * len(results[0])`
which has N entries (one per actual output), and all N slots are stored.

Constructed as `_UnboundedChannelTypes(("CHANNEL",))`:
- `t[N]` = `"CHANNEL"` for any N → Bug 1 fixed ✓
- JSON serialisation (`json.dumps`) uses CPython's C-level tuple iterator
  (`Py_SIZE = 1`), not `__len__`, so `/object_info` still yields `["CHANNEL"]`
  — 1 initial output slot in the frontend ✓

### The Info panel (dynamic output names)

The ComfyUI Info inspector tab (`TabInfo.vue`) reads from the Pinia `nodeDefStore`
to render a node's output list. By default, `/object_info` serialises `RETURN_TYPES`
via `json.dumps`, which yields `["CHANNEL"]` — so the Info panel would show only
a single static "channel_0" output.

We fix this at runtime with `syncInfoPanelOutputs()` in `channel_mapper.js`. See
the **Info Panel Sync Guide** section below for the full mechanism and lessons learned.

---

## Info Panel Sync Guide

> **Read this before modifying any code that updates the Info inspector tab for
> ChannelMapper.  This section documents lessons from multiple failed approaches.**

### The Problem

The Info inspector tab always displayed a single output "channel_0" regardless of
how many channels the user configured or what names they assigned. The canvas slots
showed correct names, but the Info panel was static.

### Root Cause: Vue reactivity and Pinia store

`TabInfo.vue` calls `nodeDefStore.fromLGraphNode(selectedNode)` which internally
reads `nodeDefsByName.value['ChannelMapper']` — a reactive key lookup in a Pinia
`ref({})` map. Vue's `computed` tracks **the key read**, not mutations to the
object stored at that key.

```
nodeInfo = computed(() => nodeDefsByName.value['ChannelMapper'])
                                               ^^^^^^^^^^^^^^
                                Vue tracks THIS key read
```

### Failed Approach: In-place `splice` on `nodeDef.outputs`

The first fix attempted to call `nodeDef.outputs.splice(0, len, ...newOutputs)`.
This mutates the array **inside** the object at `t.value['ChannelMapper']`, but
the key still points to the same object reference. Vue's computed never
re-evaluates because the tracked key read has not changed.

**Result:** No effect. Info panel stayed on "channel_0".

### Failed Approach: Wrong Vue app element ID (`#app` vs `#vue-app`)

Even after switching to `addNodeDef()` (the correct reactive trigger), the fix
still had no effect. The root cause was `document.getElementById('app')`, which
returns `null` because ComfyUI mounts its Vue 3 app on `#vue-app`.

With optional chaining, the null propagated silently:
```js
// Returns undefined (no exception, no visible error):
null?.__vue_app__?.config?.globalProperties?.$pinia?._s?.get('nodeDef')
```

`_nodeDefStore` was set to `null`, and `syncInfoPanelOutputs()` returned early
on every call. The `console.warn` fired but was invisible without devtools open.

**Lesson:** When using optional chaining for defensive access to DOM/framework
internals, a wrong starting element will silently propagate `null/undefined`
through the entire chain. Always verify the actual mount point ID.

**Verified:** `index.html` has `<div id="vue-app">` and the compiled entry JS
has `Q.mount('#vue-app')`.

### The Working Solution: `store.addNodeDef()` + correct element ID

`store.addNodeDef(v1Data)` does:
```js
t.value['ChannelMapper'] = new ComfyNodeDefImpl(updatedV1Data)
```

This is a **key reassignment** in the reactive map, which invalidates `nodeInfo`
computed and triggers a full Info tab re-render.

The V1 data fields that `ComfyNodeDefImpl` reads for outputs:
- `output` — array of type strings (e.g. `['CHANNEL', 'CHANNEL', ...]`)
- `output_name` — array of display names (e.g. `['time', 'accel_x', ...]`)
- `output_is_list` — array of booleans
- `output_tooltips` — array of tooltip strings

Spreading `{...nodeDef}` preserves all other fields (name, display_name, input,
python_module, etc.) that the constructor needs.

### Reactivity chain

```
syncInfoPanelOutputs(node, rows)
  └─ store.addNodeDef({...nodeDef, output_name: ['time','accel_x',...], ...})
       └─ new ComfyNodeDefImpl(updatedV1Data)
            └─ transformNodeDefV1ToV2 → new .outputs array
                 └─ t.value['ChannelMapper'] = newSv   ← KEY REASSIGNMENT
                      ↑
                      nodeInfo computed tracks this key
                      → invalidated → re-evaluates
                           └─ NodeHelpContent receives new :node prop
                                └─ Info tab re-renders with live names
```

### Pinia store access path

```js
document.getElementById('vue-app')        // Vue 3 app mount point (NOT #app!)
  .__vue_app__                            // Vue app instance
  .config.globalProperties.$pinia         // Pinia instance
  ._s                                     // Map of registered stores
  .get('nodeDef')                         // Store ID confirmed from compiled bundle
```

The store ID `'nodeDef'` was verified from the `F('nodeDef', ...)` call pattern
in the compiled `dialogService-*.js` bundle.

### Multi-instance handling

The NodeDef is **shared** across all ChannelMapper instances (there's one
definition per node type, not per node). When the user switches between two
ChannelMapper nodes with different channel configurations, we re-sync via
`node.onSelected`:

```js
node.onSelected = function () {
  const tw = this.widgets?.find((w) => w.name === '_channel_table');
  syncInfoPanelOutputs(this, tw?._rows ?? []);
};
```

### Graceful degradation

If `getNodeDefStore()` fails (Pinia internals change in a future ComfyUI version):
- `_nodeDefStore` stays `null`
- `syncInfoPanelOutputs()` returns early (no-op)
- Info tab falls back to static "channel_0" — no crash, no broken functionality
- A `console.warn` is emitted for debugging

### Key takeaways

1. **Vue computed tracks key reads, not nested mutations.** To trigger a re-render
   when the data changes, you must reassign the key in the reactive map — not
   mutate properties inside the stored object.
2. **Optional chaining hides wrong starting points.** `null?.a?.b?.c` evaluates
   to `undefined` with no exception. Always verify the DOM element ID.
3. **ComfyUI mounts on `#vue-app`, not `#app`.** There IS a `#app` div but it's
   NOT where Vue is mounted.
4. **`store.addNodeDef()` is the correct API** for updating a node definition
   reactively. It creates a new `ComfyNodeDefImpl` and reassigns the key.
5. **Pinia `_s` is an internal Map** (`Map<string, Store>`) in Pinia 2.x.
   Accessing it directly is fragile but works; the fallback ensures graceful
   degradation if internals change.

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

### Info panel still shows "channel_0"

1. **Open DevTools Console** — look for `[ChannelMapper] nodeDefStore (id="nodeDef")
   not found`. If present, `getNodeDefStore()` failed to locate the Pinia store.
   Check that `document.getElementById('vue-app').__vue_app__` is not null.
2. **Check the element ID** — ComfyUI mounts on `#vue-app`, NOT `#app`. If the
   code uses a wrong ID, optional chaining silently propagates null with no error.
3. **Is `syncInfoPanelOutputs` being called?** Add a temporary `console.log` at
   the top of the function. It should fire on every `syncOutputSlots` call and
   every `node.onSelected`.
4. **Is `store.addNodeDef` available?** In devtools:
   ```js
   const el = document.getElementById('vue-app');
   const store = el.__vue_app__.config.globalProperties.$pinia._s.get('nodeDef');
   console.log(typeof store.addNodeDef);  // should be "function"
   ```
5. **Multi-instance issue** — If you have two ChannelMapper nodes, clicking between
   them should re-sync. If not, check that `node.onSelected` is assigned.

### ChannelXYPlot: matplotlib errors

1. **"ChannelXYPlot requires matplotlib"** — Install: `pip install matplotlib`
2. **Backend errors / "cannot open display"** — Ensure `matplotlib.use("Agg")` is
   called before `import matplotlib.pyplot`. The code does this in the try/except
   block at the top of `__init__.py`.
3. **Memory growth on repeated executions** — `plt.close(fig)` is called after
   `savefig()`. If removed, matplotlib retains figure objects and leaks memory.

### Safari-specific debugging

Open Safari's Web Inspector (Develop > Show Web Inspector):
- **Elements tab**: Find `.channel-mapper-table`, check its computed styles
  and parent element.
- **Layers tab** (Develop > Show Compositing Borders): Visualize GPU
  compositor layers. The ghost appears as a separate compositing layer at
  viewport (0,0).
- **Console**: Log `app.canvas.ds` to see current offset/scale values.
