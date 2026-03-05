"""
common.py — shared types, constants, and helper functions for timeseries_nodes.

Imported by load_timeseries.py, channel_mapper.py, channel_xy_plot.py, and __init__.py.
No internal dependencies — only standard library and optional third-party packages.
"""
from __future__ import annotations

import csv
import json
import logging
import numpy as np
import folder_paths
from typing import TypedDict

try:
    import pandas as pd
    _PANDAS_AVAILABLE = True
except ImportError:
    _PANDAS_AVAILABLE = False
    logging.info("timeseries_nodes: pandas not available, using built-in csv reader")


# ---------------------------------------------------------------------------
# Custom type data contracts (for documentation; ComfyUI only sees the strings)
# ---------------------------------------------------------------------------

class TimeseriesDict(TypedDict):
    """The TIMESERIES custom type that flows between nodes."""
    data: dict            # channel_name (str) -> numpy.ndarray (1-D float64)
    channels: list        # ordered list of channel name strings
    units: list           # unit label per channel, parallel to channels ("" if unknown)
    sample_rate: float | None  # samples/sec if detected from time column, else None
    time: np.ndarray | None    # time axis values, or None
    source_file: str           # original filename (basename only)


class ChannelDict(TypedDict):
    """The CHANNEL custom type; one per output slot of ChannelMapper."""
    data: np.ndarray          # 1-D float64 array with transforms applied
    source_name: str          # original column name from the source file
    name: str                 # user-assigned display name
    polarity: int             # +1 or -1
    source_unit: str          # unit label of the raw signal
    unit: str                 # unit label after conversion
    gain: float               # raw→engineering multiplier
    offset: float             # additive offset applied after gain
    sample_rate: float | None


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Substrings that identify a time axis column (case-insensitive exact match).
_TIME_COLUMN_HINTS = {"time", "t", "timestamp", "ts", "seconds", "sec", "elapsed"}

# Sentinel JSON used when no mapping has been configured yet.
_EMPTY_MAPPING = "[]"


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _detect_time_column(columns: list[str]) -> str | None:
    """Return the name of the first column that looks like a time axis, or None."""
    for col in columns:
        if col.strip().lower() in _TIME_COLUMN_HINTS:
            return col
    return None


def _infer_sample_rate(time_array: np.ndarray) -> float | None:
    """
    Estimate sample rate from a uniformly-spaced time vector.
    Returns None if fewer than 2 samples or spacing is non-uniform (CV > 5%).
    """
    if time_array is None or len(time_array) < 2:
        return None
    diffs = np.diff(time_array.astype(float))
    mean_dt = float(np.mean(diffs))
    if mean_dt <= 0:
        return None
    cv = float(np.std(diffs) / mean_dt)
    if cv > 0.05:
        return None
    return 1.0 / mean_dt


def _load_csv(filepath: str) -> tuple[list[str], dict[str, np.ndarray]]:
    """
    Load a CSV file and return (columns, data_dict).

    Uses pandas if available for better type inference (mixed headers, quoted
    fields, non-comma separators). Falls back to stdlib csv + numpy.
    """
    if _PANDAS_AVAILABLE:
        df = pd.read_csv(filepath)
        columns = list(df.columns)
        data: dict[str, np.ndarray] = {}
        for col in columns:
            try:
                data[col] = df[col].to_numpy(dtype=np.float64)
            except (ValueError, TypeError):
                data[col] = np.full(len(df), np.nan, dtype=np.float64)
        return columns, data

    # Built-in fallback
    with open(filepath, newline="", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        rows = list(reader)

    if not rows:
        raise ValueError(f"CSV file is empty: {filepath}")

    headers = [h.strip() for h in rows[0]]
    n_cols = len(headers)

    arrays: list[list[float]] = [[] for _ in range(n_cols)]
    for row in rows[1:]:
        for i, cell in enumerate(row[:n_cols]):
            try:
                arrays[i].append(float(cell.strip()))
            except (ValueError, IndexError):
                arrays[i].append(float("nan"))

    data_dict: dict[str, np.ndarray] = {
        headers[i]: np.array(arrays[i], dtype=np.float64)
        for i in range(n_cols)
    }
    return headers, data_dict


def _parse_channel_mapping(mapping_json: str) -> list[dict]:
    """
    Parse the JSON channel mapping produced by the frontend table widget.

    Each entry looks like:
      {
        "source":      "accel_x",   # column name in the TIMESERIES
        "name":        "Accel X",   # user-assigned display name
        "polarity":    1,           # +1 or -1
        "source_unit": "g",         # raw signal unit (label only)
        "unit":        "m/s2",      # target unit (label only)
        "gain":        9.81,        # raw→engineering multiplier
        "offset":      0.0          # additive offset after gain
      }
    Returns an empty list on parse error.
    """
    try:
        parsed = json.loads(mapping_json or _EMPTY_MAPPING)
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        return []
