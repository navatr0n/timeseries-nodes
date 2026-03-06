"""
channel_mapper.py — ChannelMapper node.

Maps columns from a TIMESERIES into individual CHANNEL outputs via a dynamic
table UI managed by the JS extension (js/channel_mapper.js).

Transform order per channel:
    result = polarity × gain × raw_value + offset
where polarity ∈ {+1, -1}, gain is a raw→engineering multiplier, and
offset is applied after gain (in target units).

DYNAMIC OUTPUT SLOT — TWO BUGS, TWO FIXES
ChannelMapper's output count is determined at runtime by the JSON mapping
(anywhere from 1 to N channels).  Two separate issues affected correctness:

BUG 1 — VALIDATION (execution.py ~line 841):
     received_type = cls.RETURN_TYPES[val[1]]   # val[1] = link slot index
  A plain ("TIMESERIES", "CHANNEL") raises IndexError for any slot_index > 1.
  Fix: _ChannelMapperReturnTypes.__getitem__ returns "TIMESERIES" for 0,
  "CHANNEL" for any integer index >= 1.

BUG 2 — EXECUTION OUTPUT STORAGE (execution.py merge_result_data):
     output_is_list = [False] * len(results[0])   # default: N Falses
     if hasattr(obj, "OUTPUT_IS_LIST"):
         output_is_list = obj.OUTPUT_IS_LIST       # overwrites with (False,)
     for i, is_list in zip(range(len(results[0])), output_is_list):
         ...                                        # zip truncates to shorter!
  If OUTPUT_IS_LIST = (False,) (length 1), zip truncates to 1 iteration —
  only slot 0 is stored; all other slots silently receive None downstream.
  Fix: do NOT define OUTPUT_IS_LIST on ChannelMapper.  The default path
  uses [False]*N (where N = actual return-tuple length), so all N outputs
  are stored correctly.

NOTE on __len__: RETURN_TYPES.__len__ is NOT used by output storage — only
__getitem__ matters for validation.  JSON serialisation (json.dumps) uses
CPython's C-level tuple iterator (Py_SIZE = 2), not __len__, so the
/object_info response shows ["TIMESERIES", "CHANNEL"] — the two initial slots.
"""
from __future__ import annotations

import numpy as np

from .common import (
    TimeseriesDict,
    ChannelDict,
    _EMPTY_MAPPING,
    _parse_channel_mapping,
)


class _ChannelMapperReturnTypes(tuple):
    """
    Tuple subclass for ChannelMapper.RETURN_TYPES.

    - __getitem__(0) → "TIMESERIES"  (annotated timeseries with units populated)
    - __getitem__(N) → "CHANNEL" for any integer N >= 1  (validation fix: BUG 1)
    - JSON serialisation / list() use C-level tuple iteration (Py_SIZE = 2),
      so /object_info yields ["TIMESERIES", "CHANNEL"] — the 2 initial slots.
    - DO NOT add OUTPUT_IS_LIST to ChannelMapper (see BUG 2 note above).
    """

    def __getitem__(self, index):
        if isinstance(index, slice):
            return super().__getitem__(index)
        if index == 0:
            return "TIMESERIES"
        return "CHANNEL"


class ChannelMapper:
    """
    Maps columns from a TIMESERIES into CHANNEL outputs via a table UI.
    Each row configures: source column, display name, polarity, source unit,
    target unit, gain, and offset.
    The number of outputs matches the number of rows in the mapping table,
    updated dynamically by the frontend when a TIMESERIES is connected.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "timeseries": ("TIMESERIES",),
                # JSON array serialised by the frontend table widget.
                # Each element: {source, name, polarity, source_unit, unit, gain, offset}
                # (source_unit is a display hint in the table; unit is stored in CHANNEL.units)
                "channel_mapping": ("STRING", {"default": _EMPTY_MAPPING}),
            },
            "optional": {
                # Free-form annotation for this node instance.  Hidden on the canvas
                # by the JS extension; editable via the Parameters inspector tab.
                "notes": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": True,
                        "tooltip": "Free-form notes for this ChannelMapper node (metadata only).",
                    },
                ),
            },
        }

    # _ChannelMapperReturnTypes: slot 0 → "TIMESERIES", slot N>=1 → "CHANNEL"
    # (fixes validation IndexError).  See the comment block above for details.
    # DO NOT add OUTPUT_IS_LIST here — see BUG 2 in the comment block above.
    RETURN_TYPES = _ChannelMapperReturnTypes(("TIMESERIES", "CHANNEL"))
    RETURN_NAMES = ("timeseries", "channel_0")
    FUNCTION = "map_channels"
    CATEGORY = "timeseries"
    DESCRIPTION = (
        "Maps TIMESERIES columns into named, scaled CHANNEL outputs. "
        "Connect a TIMESERIES to populate the channel table automatically."
    )

    def map_channels(self, timeseries: TimeseriesDict, channel_mapping: str, notes: str = ""):
        # notes is metadata only — not used in computation
        ts_data: dict     = timeseries["data"]
        ts_sr: float | None = timeseries["sample_rate"]
        ts_channels: list = timeseries.get("channels", [])
        ts_units: list    = timeseries.get("units", [""] * len(ts_channels))

        rows = _parse_channel_mapping(channel_mapping)
        results = []
        # Track target unit per source column for the output timeseries annotation.
        unit_map: dict[str, str] = {}

        for row in rows:
            source_col = (row.get("source") or "").strip()
            if not source_col or source_col not in ts_data:
                results.append(None)
                continue

            name:     str   = row.get("name", source_col)
            polarity: int   = int(row.get("polarity", 1))
            unit:     str   = row.get("unit", "")
            gain:     float = float(row.get("gain", 1.0))
            offset:   float = float(row.get("offset", 0.0))

            # Clamp polarity to ±1
            polarity = 1 if polarity >= 0 else -1

            unit_map[source_col] = unit

            arr = ts_data[source_col].copy().astype(np.float64)
            arr = polarity * gain * arr + offset

            channel: ChannelDict = {
                "data":        arr,
                "source_file": timeseries.get("source_file", ""),
                "source_name": source_col,
                "name":        name,
                "units":       unit,
                "sample_rate": ts_sr,
            }
            results.append(channel)

        # Build output timeseries: apply transforms to data and write target units.
        # Channels not in the mapping retain their raw data and existing unit.
        new_data = dict(ts_data)
        for ch in results:
            if ch is not None:
                new_data[ch["source_name"]] = ch["data"]  # transformed array

        new_units = [
            unit_map.get(col, ts_units[i] if i < len(ts_units) else "")
            for i, col in enumerate(ts_channels)
        ]
        annotated_ts: TimeseriesDict = {**timeseries, "data": new_data, "units": new_units}

        # Output: (annotated_timeseries, channel_0, channel_1, …)
        channel_tuple = tuple(results) if results else (None,)
        return (annotated_ts,) + channel_tuple

    @classmethod
    def VALIDATE_INPUTS(cls, timeseries, channel_mapping: str = ""):
        if timeseries is None:
            return True
        rows = _parse_channel_mapping(channel_mapping)
        ts_channels: list = timeseries.get("channels", [])
        for i, row in enumerate(rows):
            source_col = (row.get("source") or "").strip()
            if source_col and source_col not in ts_channels:
                return (
                    f"Row {i}: source column '{source_col}' not found. "
                    f"Available: {ts_channels}"
                )
        return True
