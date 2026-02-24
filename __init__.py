"""
timeseries_nodes: ComfyUI nodes for loading and mapping timeseries data.

Nodes
-----
LoadTimeseries  -- Load a CSV file and output a TIMESERIES dict.
ChannelMapper   -- Map CSV columns into named, scaled CHANNEL outputs.

Dependencies:
  - numpy  (required, already in ComfyUI requirements.txt)
  - pandas (optional, improves CSV parsing; install with: pip install pandas)

Without pandas, uses Python's built-in csv module which handles standard CSV.
With pandas, supports auto-detection of mixed types, non-comma separators, etc.

Future format support (Parquet, HDF5) will require: pip install pandas pyarrow h5py
"""
from __future__ import annotations

import csv
import hashlib
import logging
import os
from typing import TypedDict

import json
import numpy as np
import folder_paths

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
    data: dict            # column_name (str) -> numpy.ndarray (1-D float64)
    columns: list         # ordered list of column name strings
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


# ---------------------------------------------------------------------------
# Node: LoadTimeseries
# ---------------------------------------------------------------------------
# The JS extension (timeseries_upload.js) uses the beforeRegisterNodeDef hook
# to inject a DATAUPLOAD widget into this node's required inputs, then
# provides that widget type via getCustomWidgets with the correct accept filter.
# The accepted_extensions hidden field is the only contract between Python and JS.

class LoadTimeseries:
    """
    Load a CSV timeseries file and output a TIMESERIES dict containing all
    columns as numpy float64 arrays.

    If a column named 'time', 't', 'timestamp', etc. is present, the sample
    rate will be auto-detected from the uniform spacing of that column.
    """

    # File extensions this loader accepts.
    # To add a new format, update this tuple — the JS reads it automatically.
    ACCEPTED_EXTENSIONS: tuple[str, ...] = (".csv",)

    @classmethod
    def INPUT_TYPES(cls):
        input_dir = folder_paths.get_input_directory()
        files = [
            f for f in os.listdir(input_dir)
            if os.path.isfile(os.path.join(input_dir, f))
            and f.lower().endswith(cls.ACCEPTED_EXTENSIONS)
        ]
        return {
            "required": {
                # Plain combo — no image_upload. The JS injects the upload
                # button as a separate DATAUPLOAD widget alongside this combo.
                "file": (sorted(files),),
            },
            "hidden": {
                # Comma-separated extension list read by timeseries_upload.js
                # to configure the file-picker's accept attribute.
                "accepted_extensions": (
                    "STRING",
                    {"default": ",".join(cls.ACCEPTED_EXTENSIONS)},
                ),
            },
        }

    RETURN_TYPES = ("TIMESERIES",)
    RETURN_NAMES = ("timeseries",)
    OUTPUT_TOOLTIPS = (
        "Dict containing all CSV columns as numpy float64 arrays, "
        "plus metadata (columns list, sample_rate, time axis).",
    )
    FUNCTION = "load"
    CATEGORY = "timeseries"
    DESCRIPTION = (
        "Load a CSV timeseries file. The file must have a header row. "
        "If a column named 'time', 't', 'timestamp', etc. is present, "
        "sample rate will be auto-detected from the time spacing."
    )
    SEARCH_ALIASES = ["csv", "load data", "timeseries", "signal", "import"]

    def load(self, file: str, accepted_extensions: str = ""):
        filepath = folder_paths.get_annotated_filepath(file)
        columns, data = _load_csv(filepath)

        time_col = _detect_time_column(columns)
        time_array = data.get(time_col) if time_col else None
        sample_rate = _infer_sample_rate(time_array) if time_array is not None else None

        timeseries: TimeseriesDict = {
            "data": data,
            "columns": columns,
            "sample_rate": sample_rate,
            "time": time_array,
            "source_file": os.path.basename(file),
        }
        return (timeseries,)

    @classmethod
    def IS_CHANGED(cls, file: str, accepted_extensions: str = "") -> str:
        """Re-execute when file content changes (SHA-256 fingerprint)."""
        filepath = folder_paths.get_annotated_filepath(file)
        m = hashlib.sha256()
        with open(filepath, "rb") as f:
            m.update(f.read())
        return m.digest().hex()

    @classmethod
    def VALIDATE_INPUTS(cls, file: str, accepted_extensions: str = ""):
        if not folder_paths.exists_annotated_filepath(file):
            return f"Invalid timeseries file: {file}"
        filepath = folder_paths.get_annotated_filepath(file)
        exts = tuple(accepted_extensions.split(",")) if accepted_extensions else cls.ACCEPTED_EXTENSIONS
        if not filepath.lower().endswith(exts):
            return (
                f"Unsupported file type: {file}. "
                f"Accepted extensions: {', '.join(cls.ACCEPTED_EXTENSIONS)}"
            )
        return True


# ---------------------------------------------------------------------------
# Node: ChannelMapper
# ---------------------------------------------------------------------------
# The channel table UI and dynamic output slots are managed entirely in JS
# (channel_mapper.js).  Python receives a JSON string ("channel_mapping")
# describing each row and returns one CHANNEL dict per row.
#
# Transform order per channel:
#   result = polarity × gain × raw_value + offset
# where polarity ∈ {+1, -1}, gain is a raw→engineering multiplier, and
# offset is applied after gain (in target units).

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
        }

    # RETURN_TYPES is set to a single placeholder; the JS extension expands
    # the actual output slots dynamically based on the mapping table.
    RETURN_TYPES = ("CHANNEL",)
    RETURN_NAMES = ("channel_0",)
    FUNCTION = "map_channels"
    CATEGORY = "timeseries"
    DESCRIPTION = (
        "Maps TIMESERIES columns into named, scaled CHANNEL outputs. "
        "Connect a TIMESERIES to populate the channel table automatically."
    )
    SEARCH_ALIASES = ["channel mapper", "split signals", "channel", "rename signals"]
    OUTPUT_IS_LIST = (False,)

    def map_channels(self, timeseries: TimeseriesDict, channel_mapping: str):
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


# ---------------------------------------------------------------------------
# Extension registration  (V1 legacy style — both nodes in NODE_CLASS_MAPPINGS)
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "LoadTimeseries": LoadTimeseries,
    "ChannelMapper":  ChannelMapper,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadTimeseries": "Load Timeseries",
    "ChannelMapper":  "Channel Mapper",
}

# JS extensions are served from the ./js directory.
WEB_DIRECTORY = "./js"

# ---------------------------------------------------------------------------
# Custom API route: GET /timeseries/columns?file=<filename>
# Returns the column list for a given file so the JS table widget can
# auto-populate rows when a TIMESERIES is connected, without running the graph.
# ---------------------------------------------------------------------------
from aiohttp import web
from server import PromptServer

@PromptServer.instance.routes.get("/timeseries/columns")
async def get_timeseries_columns(request: web.Request) -> web.Response:
    filename = request.rel_url.query.get("file", "")
    if not filename:
        return web.json_response({"error": "no file specified"}, status=400)

    if not folder_paths.exists_annotated_filepath(filename):
        return web.json_response({"error": f"file not found: {filename}"}, status=404)

    filepath = folder_paths.get_annotated_filepath(filename)
    try:
        columns, _ = _load_csv(filepath)
        return web.json_response({"columns": columns})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)
