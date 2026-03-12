// js/channel_bundle.js
// Frontend extension for ChannelBundle node.
//
// Implements the dynamic-input pattern used by ComfyUI's built-in Merge nodes:
//   - Always keep exactly one unconnected CHANNEL slot at the end.
//   - When that slot is connected, append another empty one.
//   - When a slot is disconnected, trim any trailing empty slots back to one.
//
// Slot naming: "channel_1", "channel_2", … (1-based, matches the Python kwarg names).
// Both .name and .localized_name are written together — LiteGraph renders
// `label || localized_name || name`, so writing only .name has no visible effect.

import { app } from "../../scripts/app.js";

const NODE_TYPE = "ChannelBundle";

/** Rebuild the trailing-empty-slot invariant after any connection change. */
function updateInputSlots(node) {
    const inputs = node.inputs ?? [];

    // ── Trim: remove trailing unconnected slots until only one remains ──────
    while (inputs.length > 1 && !inputs[inputs.length - 1].link) {
        node.removeInput(inputs.length - 1);
    }

    // ── Grow: if every slot is now connected, append one more empty slot ────
    if (inputs.length === 0 || inputs[inputs.length - 1].link) {
        const label = `channel_${inputs.length + 1}`;
        node.addInput(label, "CHANNEL", { localized_name: label });
    }
}

app.registerExtension({
    name: "timeseries.channelbundle",

    nodeCreated(node) {
        if (node.comfyClass !== NODE_TYPE) return;

        // Seed with one empty slot on a freshly-added node.
        // configure() will restore saved slot state on workflow load,
        // so we only add if there are currently no inputs.
        if (!node.inputs?.length) {
            node.addInput("channel_1", "CHANNEL", { localized_name: "channel_1" });
        }

        // Watch for connection changes and maintain the rolling empty slot.
        const origOnConnectionsChange = node.onConnectionsChange?.bind(node);
        node.onConnectionsChange = function (type, slotIndex, connected, link, ioSlot) {
            origOnConnectionsChange?.(type, slotIndex, connected, link, ioSlot);
            if (type === LiteGraph.INPUT) updateInputSlots(this);
        };
    },

    /**
     * loadedGraphNode fires after configure() restores saved slot state.
     * Re-run updateInputSlots so the invariant holds even if the saved
     * workflow had a different number of trailing empties.
     */
    loadedGraphNode(node) {
        if (node.comfyClass !== NODE_TYPE) return;
        updateInputSlots(node);
    },
});