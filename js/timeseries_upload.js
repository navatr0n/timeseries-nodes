/**
 * timeseries_upload.js
 *
 * Provides a proper file-upload button for timeseries loader nodes using the
 * same pattern as ComfyUI's built-in audio upload widget:
 *   beforeRegisterNodeDef  — injects a DATAUPLOAD widget into the node spec
 *   getCustomWidgets       — provides the DATAUPLOAD widget implementation
 *
 * Any node that has an `accepted_extensions` hidden input gets an upload button
 * whose file-picker is filtered to those extensions only.
 * To support a new file format, update ACCEPTED_EXTENSIONS in Python — no JS
 * changes required.
 */

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

app.registerExtension({
  name: "timeseries.DataUpload",

  /**
   * Called for every node type before it is registered.
   * If the node spec has an `accepted_extensions` hidden input, inject a
   * DATAUPLOAD widget alongside the `file` combo widget.
   */
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const hidden = nodeData?.input?.hidden;
    if (!hidden?.accepted_extensions) return;

    // Inject the upload button widget into required inputs.
    // This is what triggers getCustomWidgets to create the actual widget.
    if (!nodeData.input.required) nodeData.input.required = {};
    nodeData.input.required["data_upload"] = ["DATAUPLOAD", {}];
  },

  /**
   * Provide the implementation of the DATAUPLOAD widget type.
   * Returns a map of widget-type-name → constructor function.
   */
  getCustomWidgets() {
    return {
      DATAUPLOAD(node, inputName) {
        // Find the file combo widget on this node.
        const fileWidget = node.widgets?.find((w) => w.name === "file");

        // Read accepted extensions from the node's hidden input spec.
        const extEntry = node.constructor?.nodeData?.input?.hidden?.["accepted_extensions"];
        const acceptStr = Array.isArray(extEntry) ? (extEntry[1]?.default ?? "*") : "*";

        // Create a hidden native file input restricted to accepted extensions.
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = acceptStr;
        fileInput.style.display = "none";
        document.body.appendChild(fileInput);

        fileInput.onchange = async () => {
          const file = fileInput.files?.[0];
          if (!file) return;

          // Upload to ComfyUI's input directory via /upload/image.
          // Despite the name, this endpoint accepts any file type.
          const body = new FormData();
          body.append("image", file, file.name);
          body.append("type", "input");
          body.append("overwrite", "true");

          try {
            const resp = await api.fetchApi("/upload/image", {
              method: "POST",
              body,
            });

            if (resp.status !== 200) {
              console.error(`[timeseries] Upload failed: ${resp.status} ${resp.statusText}`);
              return;
            }

            const result = await resp.json();
            const uploaded = result.subfolder
              ? `${result.subfolder}/${result.name}`
              : result.name;

            // Add to the combo's option list if not already there, then select it.
            if (fileWidget) {
              if (!fileWidget.options.values.includes(uploaded)) {
                fileWidget.options.values.push(uploaded);
              }
              fileWidget.value = uploaded;
              fileWidget.callback?.(uploaded);
            }

            node.graph?.setDirtyCanvas(true);
          } catch (err) {
            console.error("[timeseries] Upload error:", err);
          } finally {
            fileInput.value = "";
          }
        };

        // Add the upload button widget to the node canvas.
        const uploadWidget = node.addWidget(
          "button",
          inputName,
          "Upload file",
          () => fileInput.click(),
          { serialize: false }
        );
        uploadWidget.label = "Choose file to upload";

        // Clean up DOM element when node is removed.
        const origOnRemoved = node.onRemoved?.bind(node);
        node.onRemoved = function () {
          fileInput.remove();
          origOnRemoved?.();
        };

        return { widget: uploadWidget };
      },
    };
  },
});
