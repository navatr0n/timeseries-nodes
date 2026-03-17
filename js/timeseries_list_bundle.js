/**
 * timeseries_list_bundle.js
 *
 * Frontend extension for the TimeseriesListBundle node.
 *
 * Features:
 *  - Dynamic TIMESERIES input slots: always keeps one unconnected trailing
 *    slot so new connections can be made without any button press.
 *    Slots are renumbered sequentially (timeseries_1, timeseries_2, …) on
 *    every connect/disconnect.
 *  - Reference combo: replaces the hidden "reference" STRING widget with a
 *    live combo that lists current slot names. Defaults to "timeseries_1".
 *    Updates whenever slots change; syncs back to the hidden widget so the
 *    value is saved/restored with the workflow.
 *
 * NOTE: all slot management filters by inp.type === "TIMESERIES" so that
 * any non-TIMESERIES inputs (e.g. the "reference" STRING connector that
 * ComfyUI may add for optional parameters) are never touched or renamed.
 */

import { app } from "../../scripts/app.js";

app.registerExtension({
  name: "timeseries.TimeseriesListBundle",

  nodeCreated(node) {
    if (node.comfyClass !== "TimeseriesListBundle") return;

    // ---- Hide the raw "reference" STRING widget ----
    // The combo below is the user-facing control; the STRING widget is the
    // serialisation vehicle so the value round-trips through save/load.
    const refWidget = node.widgets?.find((w) => w.name === "reference");
    if (refWidget) {
      refWidget.type        = "hidden";
      refWidget.computeSize = () => [0, -4];
      refWidget.draw        = () => {};
      refWidget.serialize   = true;
    }

    // ---- Add the reference combo widget ----
    const refCombo = node.addWidget(
      "combo",
      "Reference",
      refWidget?.value ?? "timeseries_1",
      (v) => { if (refWidget) refWidget.value = v; },
      { values: ["timeseries_1"] }
    );

    // ---- Helpers ----

    /** Return only the TIMESERIES-type input slots. */
    function tsInputs() {
      return (node.inputs ?? []).filter((inp) => inp.type === "TIMESERIES");
    }

    /** Rebuild combo options from the current TIMESERIES input slot names. */
    function syncReferenceCombo() {
      const names   = tsInputs().map((inp) => inp.name);
      const options = names.length > 0 ? names : ["timeseries_1"];

      refCombo.options = { values: options };

      // If the previously selected value no longer exists, reset to first.
      if (!options.includes(refCombo.value)) {
        refCombo.value = options[0];
        if (refWidget) refWidget.value = options[0];
      }
    }

    /**
     * Ensure exactly one unconnected trailing TIMESERIES slot exists, then
     * renumber all TIMESERIES slots sequentially.
     * Non-TIMESERIES inputs (e.g. the "reference" STRING connector) are
     * never touched.
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
          // Remove the last TIMESERIES slot by its index in node.inputs.
          const lastTsIdx = (node.inputs ?? []).reduce(
            (last, inp, i) => (inp.type === "TIMESERIES" ? i : last), -1
          );
          if (lastTsIdx >= 0) node.removeInput(lastTsIdx);
          trailingEmpty--;
        }
      }

      // Renumber TIMESERIES slots sequentially so Python kwargs are predictable.
      // Non-TIMESERIES inputs are left untouched.
      let tsIdx = 1;
      for (const inp of (node.inputs ?? [])) {
        if (inp.type !== "TIMESERIES") continue;
        inp.name           = `timeseries_${tsIdx}`;
        inp.localized_name = `timeseries_${tsIdx}`;
        tsIdx++;
      }

      syncReferenceCombo();
      node.setDirtyCanvas(true);
    }

    // ---- Initial slot setup ----
    // Check specifically for TIMESERIES inputs — other input types (e.g. the
    // "reference" STRING connector) must not count as the initial slot.
    if (!tsInputs().length) {
      node.addInput("timeseries_1", "TIMESERIES");
    }
    syncReferenceCombo();

    // ---- Watch for connection changes ----
    const origOnConnectionsChange = node.onConnectionsChange?.bind(node);
    node.onConnectionsChange = function (type, slotIndex, connected, link, ioSlot) {
      origOnConnectionsChange?.(type, slotIndex, connected, link, ioSlot);
      if (type !== 1 /* LiteGraph.INPUT */) return;
      // Only react to changes on TIMESERIES slots.
      const slot = node.inputs?.[slotIndex];
      if (slot?.type !== "TIMESERIES") return;
      ensureTrailingEmpty();
    };
  },

  /**
   * After workflow load: configure() has restored the saved widget values
   * and slot connections. Sync the combo to the restored "reference" value
   * and ensure the trailing-empty invariant holds.
   */
  loadedGraphNode(node) {
    if (node.comfyClass !== "TimeseriesListBundle") return;

    const refWidget = node.widgets?.find((w) => w.name === "reference");
    const refCombo  = node.widgets?.find((w) => w.name === "Reference");

    // Sync combo display value to whatever was saved in the hidden widget.
    if (refCombo && refWidget) {
      refCombo.value = refWidget.value ?? "timeseries_1";
    }

    // Rebuild combo options from the restored TIMESERIES slots.
    const tsNames = (node.inputs ?? [])
      .filter((inp) => inp.type === "TIMESERIES")
      .map((inp) => inp.name);
    const options = tsNames.length > 0 ? tsNames : ["timeseries_1"];
    if (refCombo) refCombo.options = { values: options };

    // Ensure the trailing-empty invariant after load (TIMESERIES slots only).
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
