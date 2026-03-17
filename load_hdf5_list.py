"""
load_hdf5_list.py — LoadHDF5List node.

Reads an HDF5 file written by SaveHDF5List and returns the stored entries as
a LIST of TIMESERIES dicts.

The filename combo is populated from .h5 files present in ComfyUI's output
directory at node-registration time.  Refresh the UI (F5) after adding new
files to see them appear in the combo.
"""
from __future__ import annotations

import os

import numpy as np
import folder_paths

try:
    import h5py
    _H5PY_AVAILABLE = True
except ImportError:
    _H5PY_AVAILABLE = False


# ---------------------------------------------------------------------------
# HDF5 read helpers
# ---------------------------------------------------------------------------

def _read_ts_from_group(grp) -> dict:
    """Read a single TIMESERIES sub-group back into a TimeseriesDict."""

    # Channel names and units
    channels: list[str] = (
        list(grp["channel_names"].asstr()[:]) if "channel_names" in grp else []
    )
    units: list[str] = (
        list(grp["units"].asstr()[:]) if "units" in grp else [""] * len(channels)
    )

    # Channel data arrays
    data: dict = {}
    if "channels" in grp:
        for name in channels:
            if name in grp["channels"]:
                data[name] = np.array(grp["channels"][name], dtype=np.float64)

    # Time axis (optional)
    time = np.array(grp["time"], dtype=np.float64) if "time" in grp else None

    # Scalar attributes
    sr_raw = grp.attrs.get("sample_rate", "null")
    sample_rate = None if sr_raw == "null" else float(sr_raw)
    source_file = str(grp.attrs.get("source_file", ""))

    # data_min / data_max
    data_min: dict = {}
    data_max: dict = {}
    if "data_min" in grp:
        for name in channels:
            if name in grp["data_min"]:
                data_min[name] = float(grp["data_min"][name][()])
    if "data_max" in grp:
        for name in channels:
            if name in grp["data_max"]:
                data_max[name] = float(grp["data_max"][name][()])

    # Metadata list of (var_name, value) tuples
    metadata: list = []
    if "metadata" in grp:
        for var_name in grp["metadata"]:
            raw = grp["metadata"][var_name][()]
            val = raw.decode() if isinstance(raw, bytes) else raw
            metadata.append((var_name, val))

    return {
        "channels":    channels,
        "units":       units,
        "data":        data,
        "time":        time,
        "sample_rate": sample_rate,
        "source_file": source_file,
        "data_min":    data_min,
        "data_max":    data_max,
        "metadata":    metadata,
    }


def _list_h5_files() -> list[str]:
    """Return .h5 filenames (not stems) from the ComfyUI output directory."""
    try:
        output_dir = folder_paths.get_output_directory()
        files = sorted(
            f for f in os.listdir(output_dir)
            if f.lower().endswith(".h5")
            and os.path.isfile(os.path.join(output_dir, f))
        )
        return files if files else [""]
    except Exception:
        return [""]


# ---------------------------------------------------------------------------
# LoadHDF5List node
# ---------------------------------------------------------------------------

class LoadHDF5List:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "filename": (_list_h5_files(),),
            },
        }

    RETURN_TYPES  = ("LIST", "STRING")
    RETURN_NAMES  = ("timeseries_list", "filepath")
    FUNCTION      = "load"
    CATEGORY      = "timeseries"
    DESCRIPTION   = (
        "Load a LIST of TIMESERIES from an HDF5 file written by SaveHDF5List.\n"
        "The combo lists .h5 files in the ComfyUI output directory.\n"
        "Refresh the browser after adding new files to update the list."
    )
    SEARCH_ALIASES = ["hdf5", "h5", "load", "read", "import", "list"]

    def load(self, filename: str) -> tuple:
        if not _H5PY_AVAILABLE:
            raise RuntimeError(
                "LoadHDF5List: h5py is not installed. Run: pip install h5py"
            )

        if not filename or filename == "":
            raise ValueError("LoadHDF5List: no filename selected.")

        output_dir = folder_paths.get_output_directory()
        path = os.path.join(output_dir, filename)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"LoadHDF5List: file not found: {path}")

        result: list = []
        with h5py.File(path, "r") as f:
            fmt = f.attrs.get("format", "")
            if fmt != "timeseries_list":
                raise ValueError(
                    f"LoadHDF5List: '{filename}' does not appear to be a "
                    f"timeseries_list HDF5 file (format attr = '{fmt}')."
                )
            count = int(f.attrs.get("count", 0))
            for i in range(count):
                key = f"timeseries_{i}"
                if key not in f:
                    break
                result.append(_read_ts_from_group(f[key]))

        if not result:
            raise ValueError(
                f"LoadHDF5List: '{filename}' contains no timeseries entries."
            )

        return (result, path)
