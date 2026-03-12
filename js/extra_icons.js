/**
 * extra_icons.js
 * Injects extra_icons.css into <head> so that additional Lucide icon classes
 * (not bundled in comfyui-frontend-package) are available to the template gallery.
 *
 * Add new icons with:
 *   python3 user_templates/add_icons.py <icon-name>
 * Then refresh the browser — no server restart needed.
 */
import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "timeseries_nodes.extra_icons",
  async setup() {
    const link = document.createElement("link");
    link.rel  = "stylesheet";
    link.href = "/extensions/timeseries_nodes/extra_icons.css";
    document.head.appendChild(link);
  },
});
