"""
channel_bundle.py — ChannelBundle node.

Bundles an arbitrary number of CHANNEL signals into a single TIMESERIES dict,
analogous to MATLAB's Mux / Bus Creator block.

Dynamic inputs are managed entirely by the JS frontend (channel_bundle.js).
Python accepts them via **kwargs and collects every value that looks like a
CHANNEL dict (has a "data" key).

sample_rate is always None in the output: the bundled channels may come from
different sources with different rates, so no single rate is meaningful.
time is None for the same reason — there is no shared time axis.
"""
from __future__ import annotations

import numpy as np

from .common import ChannelDict, TimeseriesDict


class ChannelBundle:
    """
    Bundle multiple CHANNEL signals into a single TIMESERIES.

    Inputs are added dynamically by the frontend: one empty slot is always
    kept at the end so new connections can be made without any button press.
    When a slot is disconnected the trailing empties are trimmed back to one.

    sample_rate and time are set to None because the bundled channels may
    originate from different sources with different sampling rates.
    """

    @classmethod
    def INPUT_TYPES(cls):
        # No static inputs — all CHANNEL slots are added dynamically by JS.
        # ComfyUI still needs at least one entry so the node registers cleanly.
        return {"required": {}, "optional": {}}

    RETURN_TYPES   = ("TIMESERIES",)
    RETURN_NAMES   = ("timeseries",)
    FUNCTION       = "bundle"
    CATEGORY       = "timeseries"
    DESCRIPTION    = (
        "Bundle multiple CHANNEL signals into a single TIMESERIES. "
        "Analogous to MATLAB's Mux / Bus Creator block. "
        "sample_rate and time are set to None when channels have mixed origins."
    )
    SEARCH_ALIASES = ["mux", "merge", "bundle", "creator", "combine", "pack"]

    def bundle(self, **kwargs):
        # Collect CHANNEL inputs in the order ComfyUI passes them (slot order).
        channel_inputs: list[ChannelDict] = [
            v for v in kwargs.values()
            if isinstance(v, dict) and "data" in v
        ]

        if not channel_inputs:
            raise ValueError(
                "ChannelBundle: at least one CHANNEL input must be connected."
            )

        data: dict[str, np.ndarray] = {}
        channels: list[str] = []
        units: list[str] = []

        for ch in channel_inputs:
            # Prefer user-assigned name, fall back to source column name.
            base_name = ch.get("name") or ch.get("source_name") or f"channel_{len(channels)}"

            # Resolve name collisions by appending an incrementing suffix.
            unique_name = base_name
            suffix = 1
            while unique_name in data:
                unique_name = f"{base_name}_{suffix}"
                suffix += 1

            data[unique_name]  = np.asarray(ch["data"], dtype=np.float64)
            channels.append(unique_name)
            units.append(ch.get("units", ""))

        timeseries: TimeseriesDict = {
            "data":        data,
            "channels":    channels,
            "units":       units,
            "sample_rate": None,   # mixed origins — no single rate is meaningful
            "time":        None,
            "source_file": "",
        }

        return (timeseries,)