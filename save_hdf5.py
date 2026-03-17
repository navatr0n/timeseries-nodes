"""
save_hdf5.py — SaveHDF5 node + shared HDF5 write helpers.

Saves a TIMESERIES dict to an HDF5 file using h5py.

File layout (single TIMESERIES)
---------------------------------
/                           (root)
├── attrs:
│     source_file           str
│     sample_rate           float  ("null" if None)
│
├── channel_names           string dataset  — ordered channel names
├── units                   string dataset  — unit label per channel
│
├── channels/               group — one float64 dataset per channel
│
├── time                    float64 dataset  (omitted if None)
│
├── data_min/               group — scalar float64 per channel
├── data_max/               group — scalar float64 per channel
│
└── metadata/               group — one scalar dataset per variable
                            (float64 for numeric values, str for string values)

Module-level helpers
---------------------
_resolve_output_path(stem, overwrite) → str
    Computes a unique .h5 path in the ComfyUI output directory.

_write_ts_to_group(ts, grp, dt_str)
    Writes a single TIMESERIES dict into an already-open h5py group (may be
    the file root or a named sub-group).  Imported by save_hdf5_list.py.
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
# Module-level helpers (shared with SaveHDF5List)
# ---------------------------------------------------------------------------

def _resolve_output_path(stem: str, overwrite: bool) -> str:
    """Return a unique .h5 path inside the ComfyUI output directory."""
    output_dir = folder_paths.get_output_directory()
    path = os.path.join(output_dir, f"{stem}.h5")
    if overwrite or not os.path.exists(path):
        return path
    counter = 1
    while True:
        candidate = os.path.join(output_dir, f"{stem}_{counter}.h5")
        if not os.path.exists(candidate):
            return candidate
        counter += 1


def _write_ts_to_group(ts: dict, grp, dt_str) -> None:
    """
    Write a single TIMESERIES dict into an h5py group.

    Parameters
    ----------
    ts     : TIMESERIES dict (channels, units, data, time, …)
    grp    : open h5py.Group (file root or named sub-group)
    dt_str : h5py variable-length string dtype  (h5py.special_dtype(vlen=str))
    """
    channels    = ts.get("channels") or []
    units       = ts.get("units") or [""] * len(channels)
    data        = ts.get("data") or {}
    time        = ts.get("time")
    sample_rate = ts.get("sample_rate")
    source_file = ts.get("source_file") or ""
    data_min    = ts.get("data_min") or {}
    data_max    = ts.get("data_max") or {}
    metadata    = ts.get("metadata") or []

    # Group-level attributes
    grp.attrs["source_file"] = source_file
    grp.attrs["sample_rate"] = float(sample_rate) if sample_rate is not None else "null"

    # channel_names and units as string datasets
    grp.create_dataset("channel_names", data=np.array(channels, dtype=object), dtype=dt_str)
    grp.create_dataset("units",         data=np.array(units,    dtype=object), dtype=dt_str)

    # Time axis
    if time is not None:
        grp.create_dataset("time", data=np.asarray(time, dtype=np.float64), compression="gzip")

    # Channel data
    ch_grp = grp.create_group("channels")
    for name in channels:
        arr = data.get(name)
        if arr is not None:
            ch_grp.create_dataset(name, data=np.asarray(arr, dtype=np.float64), compression="gzip")

    # data_min / data_max
    min_grp = grp.create_group("data_min")
    max_grp = grp.create_group("data_max")
    for name in channels:
        if name in data_min:
            min_grp.create_dataset(name, data=float(data_min[name]))
        if name in data_max:
            max_grp.create_dataset(name, data=float(data_max[name]))

    # Metadata variables
    meta_grp = grp.create_group("metadata")
    for var_name, value in metadata:
        if isinstance(value, str):
            meta_grp.create_dataset(var_name, data=value, dtype=dt_str)
        else:
            meta_grp.create_dataset(var_name, data=float(value))


# ---------------------------------------------------------------------------
# SaveHDF5 node
# ---------------------------------------------------------------------------

class SaveHDF5:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "timeseries": ("TIMESERIES",),
                "filename":   ("STRING", {"default": "timeseries"}),
                "overwrite":  ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES  = ("TIMESERIES", "STRING")
    RETURN_NAMES  = ("timeseries", "filepath")
    FUNCTION      = "save"
    CATEGORY      = "timeseries"
    OUTPUT_NODE   = True
    DESCRIPTION   = (
        "Save a TIMESERIES dict to an HDF5 file.\n"
        "filename: stem only, .h5 is appended automatically.\n"
        "overwrite=False appends a numeric suffix if the file already exists."
    )
    SEARCH_ALIASES = ["hdf5", "h5", "save", "export", "write"]

    def save(self, timeseries: dict, filename: str, overwrite: bool) -> tuple:
        if not _H5PY_AVAILABLE:
            raise RuntimeError(
                "SaveHDF5: h5py is not installed. Run: pip install h5py"
            )

        stem = filename.strip() or "timeseries"
        for ext in (".h5", ".hdf5"):
            if stem.lower().endswith(ext):
                stem = stem[: -len(ext)]

        path = _resolve_output_path(stem, overwrite)

        dt_str = h5py.special_dtype(vlen=str)
        with h5py.File(path, "w") as f:
            _write_ts_to_group(timeseries, f, dt_str)

        return (timeseries, path)
