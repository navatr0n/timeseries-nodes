"""
timeseries_dashboard.py — TimeseriesDashboard node.

An interactive dashboard node for exploring timeseries data in the browser.
On execution the node downsamples all input data and stores it server-side
keyed by unique_id.  The frontend JS opens a full-screen ECharts modal when
the user clicks "Open Dashboard".

Data flow
---------
1.  Graph is executed → execute() downsamples arrays and populates _DASHBOARD_DATA.
2.  User clicks "Open Dashboard" in the node.
3.  JS fetches GET /timeseries/dashboard/data/<node_id>.
4.  Modal renders an ECharts chart; controls update it client-side.
5.  Dashboard config (plot type, axis selection, series visibility) is saved in
    the hidden _dashboard_config STRING widget so it round-trips through
    save/load.

Inputs
------
timeseries_list : TIMESERIES_LIST (optional)
    Bundle of multiple TIMESERIES — each becomes one series in the dashboard.
    This is the primary input for the overlay / compare use case.
timeseries : TIMESERIES (optional)
    Single TIMESERIES — appended after timeseries_list entries.

Downsampling
------------
_uniform_downsample() reduces each channel to at most _MAX_POINTS values
using uniform stride selection.  This keeps HTTP response sizes in the
tens-of-kilobytes range for typical multi-channel datasets.
"""
from __future__ import annotations

import logging
import numpy as np

from .common import _detect_time_column

# ---------------------------------------------------------------------------
# Module-level data store.  Keyed by node unique_id (str).
# Populated by execute(); consumed by the HTTP route registered in __init__.py.
# ---------------------------------------------------------------------------
_DASHBOARD_DATA: dict[str, dict] = {}

_MAX_POINTS = 2000  # max samples per channel per series after downsampling


def _uniform_downsample(arr: np.ndarray, max_pts: int) -> list[float]:
    """Return arr uniformly downsampled to at most max_pts values."""
    n = len(arr)
    if n <= max_pts:
        return arr.tolist()
    indices = np.round(np.linspace(0, n - 1, max_pts)).astype(int)
    return arr[indices].tolist()


class TimeseriesDashboard:
    """
    Interactive dashboard for exploring and comparing timeseries data.

    Connect a TIMESERIES_LIST (overlay / compare) or a single TIMESERIES,
    run the graph, then click "Open Dashboard" on the node to open the
    ECharts visualization modal.  The modal supports line, scatter, and
    area plots with optional linear / moving-average fit overlays and
    per-series visibility toggles.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Hidden config widget — the JS hides it from the canvas.
                # Stores JSON-serialised dashboard state so it round-trips
                # through workflow save / load.
                "_dashboard_config": ("STRING", {"default": "{}",
                                                  "multiline": False}),
            },
            "optional": {
                "timeseries_list": ("TIMESERIES_LIST",),
                "timeseries":      ("TIMESERIES",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES   = ()
    OUTPUT_NODE    = True
    FUNCTION       = "execute"
    CATEGORY       = "timeseries"
    DESCRIPTION    = (
        "Interactive timeseries dashboard with ECharts. "
        "Connect TIMESERIES_LIST or TIMESERIES, run the graph, "
        "then click Open Dashboard to visualize and compare series."
    )
    SEARCH_ALIASES = [
        "dashboard", "plot", "chart", "visualize", "graph",
        "explore", "compare", "overlay", "echarts",
    ]

    def execute(
        self,
        _dashboard_config: str,
        unique_id,
        timeseries_list=None,
        timeseries=None,
    ):
        node_id = str(unique_id)

        # Collect all valid TIMESERIES entries in input order.
        all_ts: list[dict] = []
        if timeseries_list:
            all_ts.extend(
                ts for ts in timeseries_list
                if isinstance(ts, dict) and "channels" in ts
            )
        if isinstance(timeseries, dict) and "channels" in timeseries:
            all_ts.append(timeseries)

        series_out: list[dict] = []
        for ts in all_ts:
            channels  = ts.get("channels", [])
            units_lst = ts.get("units", [])
            units_map = dict(zip(channels, units_lst))
            time_arr  = ts.get("time")
            source    = ts.get("source_file", "")

            data_out: dict[str, list] = {}
            if time_arr is not None:
                data_out["__time__"] = _uniform_downsample(
                    np.asarray(time_arr, dtype=np.float64), _MAX_POINTS
                )

            for ch in channels:
                raw = ts.get("data", {}).get(ch)
                if raw is not None:
                    data_out[ch] = _uniform_downsample(
                        np.asarray(raw, dtype=np.float64), _MAX_POINTS
                    )

            series_out.append({
                "name":        source,
                "source_file": source,
                "channels":    channels,
                "units":       units_map,
                "has_time":    time_arr is not None,
                "data":        data_out,
            })

        # Compute channel intersection across all series (for axis selectors).
        # __time__ is prepended when every series has a time axis.
        if series_out:
            common = set(series_out[0]["channels"])
            for s in series_out[1:]:
                common &= set(s["channels"])
            has_time = all(s["has_time"] for s in series_out)
            # Exclude __time__ and the original time column (e.g. "time", "t")
            # to avoid duplicates — __time__ is prepended explicitly below.
            time_col = _detect_time_column(series_out[0]["channels"]) if has_time else None
            all_channels = [
                ch for ch in series_out[0]["channels"]
                if ch in common and ch != "__time__" and ch != time_col
            ]
            if has_time:
                all_channels = ["__time__"] + all_channels
        else:
            all_channels = []

        _DASHBOARD_DATA[node_id] = {
            "series":       series_out,
            "all_channels": all_channels,
        }

        logging.info(
            "TimeseriesDashboard [%s]: stored %d series, %d common channels",
            node_id, len(series_out), len(all_channels),
        )

        return {"ui": {}}