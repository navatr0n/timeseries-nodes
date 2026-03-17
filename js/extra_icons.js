/**
 * extra_icons.js
 * Injects extra_icons.css into <head> so that additional Lucide icon classes
 * (not bundled in comfyui-frontend-package) are available to the template gallery.
 *
 * Also registers per-type connector and link colors for all custom data types
 * across timeseries_nodes and python_calc_node.
 *
 * Add new icons with:
 *   python3 user_templates/add_icons.py <icon-name>
 * Then refresh the browser — no server restart needed.
 */
import { app } from "../../scripts/app.js";

// ---------------------------------------------------------------------------
// Custom data-type colors
// Covers: timeseries_nodes (TIMESERIES, CHANNEL, LIST) and
//         python_calc_node  (FLOWPATH, BOOLEAN)
// ---------------------------------------------------------------------------
const TYPE_COLORS = {
  TIMESERIES:      "#fc035e",  // hot pink  — single TIMESERIES dict
  CHANNEL:         "#fc7703",  // orange    — single CHANNEL signal
  TIMESERIES_LIST: "#9003fc",  // purple    — LIST of TIMESERIES (bundle)
  METADATA:        "#fcf403",  // yellow    — metadata tuple list
  FLOWPATH:        "#6203fc",  // violet    — for-loop flow token
  BOOLEAN:         "#03c2fc",  // sky blue  — boolean logic
};

/**
 * Apply TYPE_COLORS to both LiteGraph maps and as CSS custom properties.
 *
 * Three targets:
 *  1. LGraphCanvas.link_type_colors       — wire line color (classic renderer)
 *  2. app.canvas.default_connection_color_byType — wire line color (Nodes 2.0)
 *  3. --color-datatype-<TYPE> CSS vars    — slot connector dot color (Nodes 2.0)
 *
 * ComfyUI's color-palette service runs after setup() and resets all known
 * types to ''.  We re-apply here via a short setTimeout so we run after it.
 */
function applyTypeColors() {
  const LGraphCanvas = app.canvas.constructor;
  for (const [type, color] of Object.entries(TYPE_COLORS)) {
    LGraphCanvas.link_type_colors[type]                    = color;
    app.canvas.default_connection_color_byType[type]       = color;
    document.documentElement.style.setProperty(
      `--color-datatype-${type}`, color
    );
  }
}

app.registerExtension({
  name: "timeseries_nodes.extra_icons",

  async setup() {
    // Inject icon stylesheet.
    const link = document.createElement("link");
    link.rel  = "stylesheet";
    link.href = "/extensions/timeseries_nodes/extra_icons.css";
    document.head.appendChild(link);

    // Apply immediately, then re-apply after the color-palette service has
    // had a chance to run (it wipes unknown types back to '' on init).
    applyTypeColors();
    setTimeout(applyTypeColors, 200);
  },

  // Re-apply when a workflow is loaded — configure() can trigger another
  // palette refresh that would wipe the colors again.
  afterConfigureGraph() {
    applyTypeColors();
  },
});
