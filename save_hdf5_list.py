"""
save_hdf5_list.py — SaveHDF5List node.

Saves a LIST of TIMESERIES dicts to a single HDF5 file.  Each TIMESERIES is
stored in its own numbered sub-group.

File layout
-----------
/
├── attrs:
│     format    "timeseries_list"
│     count     N  (integer)
│
├── timeseries_0/   (same internal layout as a single SaveHDF5 file)
│     attrs: source_file, sample_rate
│     channel_names, units
│     channels/, time, data_min/, data_max/, metadata/
│
├── timeseries_1/
└── ...
"""
from __future__ import annotations

from .save_hdf5 import _H5PY_AVAILABLE, _resolve_output_path, _write_ts_to_group

try:
    import h5py
except ImportError:
    pass  # guarded by _H5PY_AVAILABLE


class SaveHDF5List:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "timeseries_list": ("TIMESERIES_LIST",),
                "filename":        ("STRING", {"default": "timeseries_list"}),
                "overwrite":       ("BOOLEAN", {"default": True}),
            },
        }

    RETURN_TYPES  = ("TIMESERIES_LIST", "STRING")
    RETURN_NAMES  = ("timeseries_list", "filepath")
    FUNCTION      = "save"
    CATEGORY      = "timeseries"
    OUTPUT_NODE   = True
    DESCRIPTION   = (
        "Save a LIST of TIMESERIES dicts to a single HDF5 file.\n"
        "Each TIMESERIES occupies its own sub-group (timeseries_0, timeseries_1, …).\n"
        "filename: stem only, .h5 is appended automatically.\n"
        "overwrite=False appends a numeric suffix if the file already exists."
    )
    SEARCH_ALIASES = ["hdf5", "h5", "save", "export", "write", "list", "bundle"]

    def save(self, timeseries_list: list, filename: str, overwrite: bool) -> tuple:
        if not _H5PY_AVAILABLE:
            raise RuntimeError(
                "SaveHDF5List: h5py is not installed. Run: pip install h5py"
            )

        ts_items = [
            ts for ts in (timeseries_list or [])
            if isinstance(ts, dict) and "channels" in ts
        ]
        if not ts_items:
            raise ValueError(
                "SaveHDF5List: timeseries_list contains no valid TIMESERIES entries."
            )

        stem = filename.strip() or "timeseries_list"
        for ext in (".h5", ".hdf5"):
            if stem.lower().endswith(ext):
                stem = stem[: -len(ext)]

        path = _resolve_output_path(stem, overwrite)

        dt_str = h5py.special_dtype(vlen=str)
        with h5py.File(path, "w") as f:
            f.attrs["format"] = "timeseries_list"
            f.attrs["count"]  = len(ts_items)
            for i, ts in enumerate(ts_items):
                grp = f.create_group(f"timeseries_{i}")
                _write_ts_to_group(ts, grp, dt_str)

        return (timeseries_list, path)
