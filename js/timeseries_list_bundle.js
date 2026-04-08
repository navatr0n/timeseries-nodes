/**
 * timeseries_list_bundle.js
 *
 * Frontend extension for the TimeseriesListBundle node.
 *
 * Implements dynamic TIMESERIES input slots: always keeps one unconnected
 * trailing slot so new connections can be made without any button press.
 * Slots are renumbered sequentially (timeseries_1, timeseries_2, …) on
 * every connect/disconnect.
 *
 * NOTE: all slot management filters by inp.type === "TIMESERIES" so that
 * any non-TIMESERIES inputs are never touched or renamed.
 */

import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "timeseries.TimeseriesListBundle",

  nodeCreated(node) {
    if (node.comfyClass !== "TimeseriesListBundle") return;

    /** Return only the TIMESERIES-type input slots. */
    function tsInputs() {
      return (node.inputs ?? []).filter((inp) => inp.type === "TIMESERIES");
    }

    /**
     * Ensure exactly one unconnected trailing TIMESERIES slot exists, then
     * renumber all TIMESERIES slots sequentially.
     * Non-TIMESERIES inputs are never touched.
     */
    function ensureTrailingEmpty() {
      const ts = tsInputs();

      // Count trailing unconnected TIMESERIES slots.
      let trailingEmpty = 0;
      for (let i = ts.length - 1; i >= 0; i--) {
        if (!ts[i].link) trailingEmpty++;
        else break;
      }

      // Add one if none; remove extras beyond one.
      if (trailingEmpty === 0) {
        node.addInput(`timeseries_${ts.length + 1}`, "TIMESERIES");
      } else {
        while (trailingEmpty > 1) {
          const lastTsIdx = (node.inputs ?? []).reduce(
            (last, inp, i) => (inp.type === "TIMESERIES" ? i : last), -1
          );
          if (lastTsIdx >= 0) node.removeInput(lastTsIdx);
          trailingEmpty--;
        }
      }

      // Renumber TIMESERIES slots sequentially so Python kwargs are predictable.
      let tsIdx = 1;
      for (const inp of (node.inputs ?? [])) {
        if (inp.type !== "TIMESERIES") continue;
        inp.name           = `timeseries_${tsIdx}`;
        inp.localized_name = `timeseries_${tsIdx}`;
        tsIdx++;
      }

      node.setDirtyCanvas(true);
    }

    // Seed with one empty slot on a freshly-added node.
    if (!tsInputs().length) {
      node.addInput("timeseries_1", "TIMESERIES");
    }

    // Watch for connection changes and maintain the rolling empty slot.
    const origOnConnectionsChange = node.onConnectionsChange?.bind(node);
    node.onConnectionsChange = function (type, slotIndex, connected, link, ioSlot) {
      origOnConnectionsChange?.(type, slotIndex, connected, link, ioSlot);
      if (type !== 1 /* LiteGraph.INPUT */) return;
      const slot = node.inputs?.[slotIndex];
      if (slot?.type !== "TIMESERIES") return;
      ensureTrailingEmpty();
    };
  },

  /**
   * After workflow load: configure() has restored the saved slot connections.
   * Ensure the trailing-empty invariant holds.
   */
  loadedGraphNode(node) {
    if (node.comfyClass !== "TimeseriesListBundle") return;

    const tsSlots = (node.inputs ?? []).filter((inp) => inp.type === "TIMESERIES");
    let trailingEmpty = 0;
    for (let i = tsSlots.length - 1; i >= 0; i--) {
      if (!tsSlots[i].link) trailingEmpty++;
      else break;
    }
    if (trailingEmpty === 0) {
      node.addInput(`timeseries_${tsSlots.length + 1}`, "TIMESERIES");
    } else {
      while (trailingEmpty > 1) {
        const lastTsIdx = (node.inputs ?? []).reduce(
          (last, inp, i) => (inp.type === "TIMESERIES" ? i : last), -1
        );
        if (lastTsIdx >= 0) node.removeInput(lastTsIdx);
        trailingEmpty--;
      }
    }

    node.setDirtyCanvas(true);
  },
});
