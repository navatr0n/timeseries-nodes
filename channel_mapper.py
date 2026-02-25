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
  A plain ("CHANNEL",) raises IndexError for any slot_index > 0.
  Fix: _UnboundedChannelTypes.__getitem__ always returns "CHANNEL".

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
CPython's C-level tuple iterator (Py_SIZE = 1), not __len__, so the
/object_info response still shows ["CHANNEL"] regardless.
"""
from __future__ import annotations

import numpy as np

from .common import (
    TimeseriesDict,
    ChannelDict,
    _EMPTY_MAPPING,
    _parse_channel_mapping,
)


class _UnboundedChannelTypes(tuple):
    """
    Tuple subclass for ChannelMapper.RETURN_TYPES.

    - __getitem__(N) → "CHANNEL" for any integer N  (validation fix: BUG 1)
    - JSON serialisation / list() use C-level tuple iteration (Py_SIZE = 1),
      not __len__, so /object_info still yields ["CHANNEL"] — 1 initial slot.
    - DO NOT add OUTPUT_IS_LIST to ChannelMapper (see BUG 2 note above).
    """

    def __getitem__(self, index):
        if isinstance(index, slice):
            return super().__getitem__(index)
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

    # _UnboundedChannelTypes: __getitem__ returns "CHANNEL" for any slot index
    # (fixes validation IndexError).  See the comment block above for details.
    # DO NOT add OUTPUT_IS_LIST here — see BUG 2 in the comment block above.
    RETURN_TYPES = _UnboundedChannelTypes(("CHANNEL",))
    RETURN_NAMES = ("channel_0",)
    FUNCTION = "map_channels"
    CATEGORY = "timeseries"
    DESCRIPTION = (
        "Maps TIMESERIES columns into named, scaled CHANNEL outputs. "
        "Connect a TIMESERIES to populate the channel table automatically."
    )

    def map_channels(self, timeseries: TimeseriesDict, channel_mapping: str, notes: str = ""):
        # notes is metadata only — not used in computation
        ts_data: dict = timeseries["data"]
        ts_sr: float | None = timeseries["sample_rate"]

        rows = _parse_channel_mapping(channel_mapping)
        results = []

        for row in rows:
            source_col = (row.get("source") or "").strip()
            if not source_col or source_col not in ts_data:
                results.append(None)
                continue

            name:        str   = row.get("name", source_col)
            polarity:    int   = int(row.get("polarity", 1))
            source_unit: str   = row.get("source_unit", "")
            unit:        str   = row.get("unit", "")
            gain:        float = float(row.get("gain", 1.0))
            offset:      float = float(row.get("offset", 0.0))

            # Clamp polarity to ±1
            polarity = 1 if polarity >= 0 else -1

            arr = ts_data[source_col].copy().astype(np.float64)
            arr = polarity * gain * arr + offset

            channel: ChannelDict = {
                "data":        arr,
                "source_name": source_col,
                "name":        name,
                "polarity":    polarity,
                "source_unit": source_unit,
                "unit":        unit,
                "gain":        gain,
                "offset":      offset,
                "sample_rate": ts_sr,
            }
            results.append(channel)

        # Return as a tuple; the JS extension sets up the correct number of
        # output slots to match len(results).
        return tuple(results) if results else (None,)

    @classmethod
    def VALIDATE_INPUTS(cls, timeseries, channel_mapping: str = ""):
        if timeseries is None:
            return True
        rows = _parse_channel_mapping(channel_mapping)
        ts_columns: list = timeseries.get("columns", [])
        for i, row in enumerate(rows):
            source_col = (row.get("source") or "").strip()
            if source_col and source_col not in ts_columns:
                return (
                    f"Row {i}: source column '{source_col}' not found. "
                    f"Available: {ts_columns}"
                )
        return True
