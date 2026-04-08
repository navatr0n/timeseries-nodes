"""
timeseries_list_bundle.py — TimeseriesListBundle node.

Bundles multiple TIMESERIES inputs into a LIST of TIMESERIES.

Only channels present in ALL inputs are kept (intersection). Channels are
ordered alphabetically in the output.

Each output TIMESERIES retains its own time, sample_rate, source_file,
metadata, data_min, and data_max (filtered to the common channel set).

Omitted channels (present in some but not all inputs) are returned as a
LIST of strings for debugging.
"""
from __future__ import annotations

import re

from .common import TimeseriesDict


def _slot_order(key: str) -> int:
    """Sort key: extract trailing integer from slot name (e.g. 'timeseries_3' → 3)."""
    m = re.search(r"(\d+)$", key)
    return int(m.group(1)) if m else 0


class TimeseriesListBundle:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                # Static placeholder so ComfyUI's type-matching includes this
                # node when dragging a TIMESERIES wire (suggestion list).
                # The JS manages all TIMESERIES slots dynamically; this entry
                # seeds slot 1 on node creation so nodeCreated's tsInputs()
                # check finds it and skips adding a duplicate.
                "timeseries_1": ("TIMESERIES",),
            },
        }

    RETURN_TYPES  = ("TIMESERIES_LIST", "LIST")
    RETURN_NAMES  = ("timeseries_list", "omitted_channels")
    FUNCTION      = "bundle"
    CATEGORY      = "timeseries"
    DESCRIPTION   = (
        "Bundle multiple TIMESERIES inputs into a LIST. "
        "Only channels present in ALL inputs are kept (sorted alphabetically). "
        "Omitted channels (not in all inputs) are returned as a LIST of strings."
    )
    SEARCH_ALIASES = ["bundle", "list", "merge", "stack", "combine"]

    def bundle(self, **kwargs) -> tuple:
        # Collect all TIMESERIES inputs from dynamic slots.
        ts_inputs: dict[str, TimeseriesDict] = {
            k: v for k, v in kwargs.items()
            if isinstance(v, dict) and "channels" in v
        }

        if not ts_inputs:
            raise ValueError(
                "TimeseriesListBundle: at least one TIMESERIES input must be connected."
            )

        # Ordered list by slot number (timeseries_1 first).
        sorted_keys = sorted(ts_inputs.keys(), key=_slot_order)
        ordered_ts  = [ts_inputs[k] for k in sorted_keys]

        # Intersect channel sets across all inputs, then sort alphabetically.
        common: set[str] = set(ordered_ts[0].get("channels") or [])
        for ts in ordered_ts[1:]:
            common &= set(ts.get("channels") or [])

        # Final channel list: alphabetical order.
        final_channels = sorted(common)

        if not final_channels:
            raise ValueError(
                "TimeseriesListBundle: no channels are shared across all inputs. "
                "Check that all connected TIMESERIES contain at least one common channel."
            )

        # Omitted: in any input but not in all.
        all_channels: set[str] = set()
        for ts in ordered_ts:
            all_channels |= set(ts.get("channels") or [])
        omitted: list[str] = sorted(all_channels - common)

        # Build filtered TIMESERIES list.
        result: list[TimeseriesDict] = []
        for ts in ordered_ts:
            ts_channels: list[str] = ts.get("channels") or []
            ts_units:    list[str] = ts.get("units") or [""] * len(ts_channels)
            units_map = dict(zip(ts_channels, ts_units))

            src_min: dict = ts.get("data_min") or {}
            src_max: dict = ts.get("data_max") or {}
            src_data: dict = ts.get("data") or {}

            new_data     = {ch: src_data[ch] for ch in final_channels if ch in src_data}
            new_units    = [units_map.get(ch, "") for ch in final_channels]
            new_data_min = {ch: src_min.get(ch, float("nan")) for ch in final_channels}
            new_data_max = {ch: src_max.get(ch, float("nan")) for ch in final_channels}

            filtered: TimeseriesDict = {
                **ts,
                "data":     new_data,
                "channels": final_channels,
                "units":    new_units,
                "data_min": new_data_min,
                "data_max": new_data_max,
            }
            result.append(filtered)

        return (result, omitted)
