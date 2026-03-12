"""
load_timeseries.py — LoadTimeseries node.

Loads a CSV file and outputs a TIMESERIES dict containing all columns as
numpy float64 arrays, plus metadata (sample rate, time axis, source file).

The JS extension (timeseries_upload.js) uses the beforeRegisterNodeDef hook
to inject a DATAUPLOAD widget into this node's required inputs, then provides
that widget type via getCustomWidgets with the correct accept filter.
The accepted_extensions hidden field is the only contract between Python and JS.
"""
from __future__ import annotations

import hashlib
import os

import numpy as np
import folder_paths

from .common import (
    TimeseriesDict,
    _detect_time_column,
    _infer_sample_rate,
    _load_csv,
)


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
        "Dict containing all CSV channels as numpy float64 arrays, "
        "plus metadata (channels list, units list, sample_rate, time axis).",
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

        data_min: dict = {}
        data_max: dict = {}
        for col, arr in data.items():
            finite = arr[np.isfinite(arr)]
            if len(finite) > 0:
                data_min[col] = float(np.min(finite))
                data_max[col] = float(np.max(finite))
            else:
                data_min[col] = float("nan")
                data_max[col] = float("nan")

        timeseries: TimeseriesDict = {
            "data": data,
            "channels": columns,
            "units": [""] * len(columns),
            "sample_rate": sample_rate,
            "time": time_array,
            "source_file": os.path.basename(file),
            "data_min": data_min,
            "data_max": data_max,
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
