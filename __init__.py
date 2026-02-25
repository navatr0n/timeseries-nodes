"""
timeseries_nodes: ComfyUI nodes for loading and mapping timeseries data.

Nodes
-----
LoadTimeseries  -- Load a CSV file and output a TIMESERIES dict.
ChannelMapper   -- Map CSV columns into named, scaled CHANNEL outputs.
ChannelXYPlot   -- Plot two CHANNEL signals as an XY chart (IMAGE output).

Dependencies:
  - numpy      (required, already in ComfyUI requirements.txt)
  - torch      (required, already in ComfyUI requirements.txt)
  - Pillow     (required, already in ComfyUI requirements.txt)
  - pandas     (optional, improves CSV parsing;  pip install pandas)
  - matplotlib (optional, required for ChannelXYPlot; pip install matplotlib)

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

import io as _io              # BytesIO — in-memory PNG encoding for ChannelXYPlot
import torch
from PIL import Image as _PIL_Image

try:
    import matplotlib
    matplotlib.use("Agg")    # Non-interactive backend — MUST precede pyplot import.
                             # ComfyUI has no display server; without Agg, matplotlib
                             # may attempt to open a GUI window and crash.
    import matplotlib.pyplot as plt
    _MATPLOTLIB_AVAILABLE = True
except ImportError:
    _MATPLOTLIB_AVAILABLE = False
    logging.info(
        "timeseries_nodes: matplotlib not available — "
        "ChannelXYPlot disabled. Install with: pip install matplotlib"
    )


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
#
# DYNAMIC OUTPUT SLOT — TWO BUGS, TWO FIXES
# ChannelMapper's output count is determined at runtime by the JSON mapping
# (anywhere from 1 to N channels).  Two separate issues affected correctness:
#
# BUG 1 — VALIDATION (execution.py ~line 841):
#      received_type = cls.RETURN_TYPES[val[1]]   # val[1] = link slot index
#   A plain ("CHANNEL",) raises IndexError for any slot_index > 0.
#   Fix: _UnboundedChannelTypes.__getitem__ always returns "CHANNEL".
#
# BUG 2 — EXECUTION OUTPUT STORAGE (execution.py merge_result_data):
#      output_is_list = [False] * len(results[0])   # default: N Falses
#      if hasattr(obj, "OUTPUT_IS_LIST"):
#          output_is_list = obj.OUTPUT_IS_LIST       # overwrites with (False,)
#      for i, is_list in zip(range(len(results[0])), output_is_list):
#          ...                                        # zip truncates to shorter!
#   If OUTPUT_IS_LIST = (False,) (length 1), zip truncates to 1 iteration —
#   only slot 0 is stored; all other slots silently receive None downstream.
#   Fix: do NOT define OUTPUT_IS_LIST on ChannelMapper.  The default path
#   uses [False]*N (where N = actual return-tuple length), so all N outputs
#   are stored correctly.
#
# NOTE on __len__: RETURN_TYPES.__len__ is NOT used by output storage — only
# __getitem__ matters for validation.  JSON serialisation (json.dumps) uses
# CPython's C-level tuple iterator (Py_SIZE = 1), not __len__, so the
# /object_info response still shows ["CHANNEL"] regardless.

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
# Node: ChannelXYPlot
# ---------------------------------------------------------------------------
# Renders two CHANNEL signals as an XY line chart via matplotlib and returns
# the result as a standard ComfyUI IMAGE tensor (1, H, W, 3) float32 [0, 1].
# No JS extension is needed — ComfyUI previews IMAGE outputs natively.
#
# Conversion pipeline:
#   matplotlib Figure  →  savefig(BytesIO, 'png')  →  PIL Image  →  numpy
#   float32 array / 255  →  torch.Tensor (1, H, W, 3)

class ChannelXYPlot:
    """
    Plot two CHANNEL signals as an XY line chart using matplotlib.
    The x_channel drives the horizontal axis; y_channel drives the vertical axis.
    Outputs a standard ComfyUI IMAGE tensor: shape (1, H, W, 3), float32, range [0, 1].

    If the two channels have different lengths, the shorter one determines the
    number of plotted points (silent, safe truncation — no crash).

    Requires matplotlib: pip install matplotlib
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "x_channel": ("CHANNEL",),
                "y_channel": ("CHANNEL",),
                "width":  ("INT", {"default": 800, "min": 100, "max": 4096, "step": 1}),
                "height": ("INT", {"default": 600, "min": 100, "max": 4096, "step": 1}),
                "dpi":    ("INT", {"default": 100, "min": 50,  "max": 300,  "step": 1}),
            }
        }

    RETURN_TYPES   = ("IMAGE",)
    RETURN_NAMES   = ("plot",)
    FUNCTION       = "plot"
    CATEGORY       = "timeseries"
    DESCRIPTION    = (
        "Plot two CHANNEL signals as an XY chart using matplotlib. "
        "x_channel → horizontal axis, y_channel → vertical axis. "
        "Requires: pip install matplotlib"
    )
    SEARCH_ALIASES = ["plot", "xy plot", "chart", "graph", "visualize", "signal"]

    def plot(self, x_channel, y_channel, width: int, height: int, dpi: int):
        if not _MATPLOTLIB_AVAILABLE:
            raise RuntimeError(
                "ChannelXYPlot requires matplotlib. "
                "Install it with: pip install matplotlib"
            )

        x_data = np.asarray(x_channel["data"], dtype=np.float64)
        y_data = np.asarray(y_channel["data"], dtype=np.float64)

        # Trim to the shorter series — lengths must match for a well-formed plot
        n = min(len(x_data), len(y_data))
        x_data = x_data[:n]
        y_data = y_data[:n]

        # Build axis labels from channel metadata (name + unit)
        x_name  = x_channel.get("name") or x_channel.get("source_name", "X")
        y_name  = y_channel.get("name") or y_channel.get("source_name", "Y")
        x_unit  = x_channel.get("unit") or x_channel.get("source_unit", "")
        y_unit  = y_channel.get("unit") or y_channel.get("source_unit", "")
        x_label = f"{x_name} [{x_unit}]" if x_unit else x_name
        y_label = f"{y_name} [{y_unit}]" if y_unit else y_name

        # Create figure at the requested pixel size (matplotlib works in inches)
        fig, ax = plt.subplots(figsize=(width / dpi, height / dpi), dpi=dpi)
        ax.plot(x_data, y_data, linewidth=1.0)
        ax.set_xlabel(x_label)
        ax.set_ylabel(y_label)
        ax.grid(True, alpha=0.3)
        fig.tight_layout()

        # Render to in-memory PNG → PIL Image → numpy → torch tensor
        buf = _io.BytesIO()
        fig.savefig(buf, format="png", dpi=dpi)
        plt.close(fig)    # Release matplotlib memory — important for repeated executions
        buf.seek(0)

        pil_img = _PIL_Image.open(buf).convert("RGB")
        arr     = np.array(pil_img).astype(np.float32) / 255.0  # (H, W, 3), range [0, 1]
        tensor  = torch.from_numpy(arr)[None,]                   # (1, H, W, 3)

        return (tensor,)


# ---------------------------------------------------------------------------
# Extension registration  (V1 legacy style — both nodes in NODE_CLASS_MAPPINGS)
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "LoadTimeseries": LoadTimeseries,
    "ChannelMapper":  ChannelMapper,
    "ChannelXYPlot":  ChannelXYPlot,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadTimeseries": "Load Timeseries",
    "ChannelMapper":  "Channel Mapper",
    "ChannelXYPlot":  "Channel XY Plot",
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
