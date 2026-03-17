"""
xy_plot_overlay.py — XYPlotOverlay node.

Takes a LIST of TIMESERIES and renders all of them as overlaid XY lines on a
single matplotlib figure.  Each series receives a distinct color drawn from the
selected palette.  The x/y channel names are STRING inputs; the JS extension
(js/xy_plot_overlay.js) converts them to live combo widgets populated by
walking the upstream graph.

Output: a standard ComfyUI IMAGE tensor (1, H, W, 3), float32 in [0, 1].

Requires matplotlib: pip install matplotlib
"""
from __future__ import annotations

import io as _io
import logging
import os

import numpy as np
import torch
from PIL import Image as _PIL_Image

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import matplotlib.cm as _mplcm
    _MATPLOTLIB_AVAILABLE = True
except ImportError:
    _MATPLOTLIB_AVAILABLE = False
    logging.info(
        "timeseries_nodes: matplotlib not available — "
        "XYPlotOverlay disabled. Install with: pip install matplotlib"
    )


def _get_colors(palette: str, n: int) -> list:
    """Return n distinct colors from a matplotlib categorical palette."""
    try:
        cmap = matplotlib.colormaps[palette]
    except AttributeError:
        # matplotlib < 3.5 fallback
        cmap = _mplcm.get_cmap(palette)
    return [cmap(i % cmap.N) for i in range(n)]


class XYPlotOverlay:
    """
    Plot multiple TIMESERIES as overlaid XY lines using matplotlib.
    x_channel and y_channel are the channel names to use for each axis —
    both must be present in every TIMESERIES in the input list.

    The JS extension auto-populates the channel combos from the upstream graph.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "timeseries_list": ("TIMESERIES_LIST",),
                # Hidden STRING backing — JS replaces these with live combos.
                "x_channel": ("STRING", {"default": ""}),
                "y_channel": ("STRING", {"default": ""}),
                "plot_type":  (["line", "scatter"],),
                "title":    ("STRING", {"default": "", "multiline": False}),
                "subtitle": ("STRING", {"default": "", "multiline": False}),
                "x_range_mode": (["auto", "manual"],),
                "x_min": ("FLOAT", {"default": 0.0, "step": 0.001}),
                "x_max": ("FLOAT", {"default": 1.0, "step": 0.001}),
                "y_range_mode": (["auto", "manual"],),
                "y_min": ("FLOAT", {"default": 0.0, "step": 0.001}),
                "y_max": ("FLOAT", {"default": 1.0, "step": 0.001}),
                "legend_position": ([
                    "best", "upper right", "upper left",
                    "lower right", "lower left",
                    "center left", "center right",
                    "lower center", "upper center", "center", "none",
                ],),
                "color_palette": (["tab10", "tab20", "Set1", "Set2", "Set3", "Paired"],),
                "width":  ("INT", {"default": 800, "min": 100, "max": 4096, "step": 1}),
                "height": ("INT", {"default": 600, "min": 100, "max": 4096, "step": 1}),
                "dpi":    ("INT", {"default": 100, "min": 50,  "max": 300,  "step": 1}),
            },
        }

    RETURN_TYPES   = ("IMAGE",)
    RETURN_NAMES   = ("plot",)
    FUNCTION       = "plot"
    CATEGORY       = "timeseries"
    DESCRIPTION    = (
        "Plot a LIST of TIMESERIES as overlaid XY lines using matplotlib. "
        "x_channel and y_channel select which channel appears on each axis. "
        "Each series is drawn in a distinct color from the chosen palette. "
        "Requires: pip install matplotlib"
    )
    SEARCH_ALIASES = ["plot", "overlay", "xy", "chart", "graph", "compare", "multi"]

    def plot(
        self,
        timeseries_list: list,
        x_channel: str,
        y_channel: str,
        plot_type: str,
        title: str,
        subtitle: str,
        x_range_mode: str,
        x_min: float,
        x_max: float,
        y_range_mode: str,
        y_min: float,
        y_max: float,
        legend_position: str,
        color_palette: str,
        width: int,
        height: int,
        dpi: int,
    ):
        if not _MATPLOTLIB_AVAILABLE:
            raise RuntimeError(
                "XYPlotOverlay requires matplotlib. "
                "Install it with: pip install matplotlib"
            )

        x_ch = (x_channel or "").strip()
        y_ch = (y_channel or "").strip()

        # Filter to valid TIMESERIES entries
        ts_items = [
            ts for ts in (timeseries_list or [])
            if isinstance(ts, dict) and "channels" in ts
        ]
        if not ts_items:
            raise ValueError("XYPlotOverlay: timeseries_list contains no valid TIMESERIES entries.")

        if not x_ch or not y_ch:
            raise ValueError(
                "XYPlotOverlay: x_channel and y_channel must be non-empty. "
                "Connect the timeseries_list input so the JS can populate the channel combos."
            )

        # Validate that all entries have both channels
        missing = [
            i for i, ts in enumerate(ts_items)
            if x_ch not in ts.get("data", {}) or y_ch not in ts.get("data", {})
        ]
        if missing:
            available = sorted(set(
                ch for ts in ts_items for ch in (ts.get("channels") or [])
            ))
            raise ValueError(
                f"XYPlotOverlay: channel(s) not found in entries {missing}. "
                f"x='{x_ch}', y='{y_ch}'. Available: {available}"
            )

        # Axis labels: use channel name + unit from first entry
        def _label(ts, ch_name):
            channels = ts.get("channels") or []
            units    = ts.get("units") or []
            unit_map = dict(zip(channels, units))
            unit = unit_map.get(ch_name, "")
            return f"{ch_name} [{unit}]" if unit else ch_name

        x_label = _label(ts_items[0], x_ch)
        y_label = _label(ts_items[0], y_ch)

        colors = _get_colors(color_palette, len(ts_items))

        fig, ax = plt.subplots(figsize=(width / dpi, height / dpi), dpi=dpi)

        for i, ts in enumerate(ts_items):
            x_data = np.asarray(ts["data"][x_ch], dtype=np.float64)
            y_data = np.asarray(ts["data"][y_ch], dtype=np.float64)
            n = min(len(x_data), len(y_data))
            x_data = x_data[:n]
            y_data = y_data[:n]

            # Series label: source_file basename (no ext), or "Series N"
            src = os.path.basename(ts.get("source_file", ""))
            label = os.path.splitext(src)[0] or f"Series {i + 1}"

            color = colors[i]
            if plot_type == "scatter":
                ax.scatter(x_data, y_data, s=4, linewidths=0, color=color, label=label)
            else:
                ax.plot(x_data, y_data, linewidth=1.0, color=color, label=label)

        ax.set_xlabel(x_label)
        ax.set_ylabel(y_label)
        ax.grid(True, alpha=0.3)

        # Axis ranges
        if x_range_mode == "manual":
            if x_min >= x_max:
                raise ValueError(
                    f"XYPlotOverlay: x_min ({x_min}) must be less than x_max ({x_max})"
                )
            ax.set_xlim(x_min, x_max)
        if y_range_mode == "manual":
            if y_min >= y_max:
                raise ValueError(
                    f"XYPlotOverlay: y_min ({y_min}) must be less than y_max ({y_max})"
                )
            ax.set_ylim(y_min, y_max)

        # Titles
        if title and subtitle:
            fig.suptitle(title, fontsize=13, fontweight="bold")
            ax.set_title(subtitle, fontsize=9, color="gray")
        elif title:
            ax.set_title(title, fontsize=13, fontweight="bold")
        elif subtitle:
            ax.set_title(subtitle, fontsize=10, color="gray")

        # Legend
        if legend_position != "none":
            ax.legend(loc=legend_position, fontsize=8)

        fig.tight_layout()

        # Render → PIL → numpy → torch
        buf = _io.BytesIO()
        fig.savefig(buf, format="png", dpi=dpi)
        plt.close(fig)
        buf.seek(0)

        pil_img = _PIL_Image.open(buf).convert("RGB")
        arr    = np.array(pil_img).astype(np.float32) / 255.0
        tensor = torch.from_numpy(arr)[None,]

        return (tensor,)
