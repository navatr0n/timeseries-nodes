"""
channel_xy_plot.py — ChannelXYPlot node.

Renders two CHANNEL signals as an XY line chart via matplotlib and returns
the result as a standard ComfyUI IMAGE tensor (1, H, W, 3) float32 [0, 1].
No JS extension is needed — ComfyUI previews IMAGE outputs natively.

Conversion pipeline:
    matplotlib Figure  →  savefig(BytesIO, 'png')  →  PIL Image  →  numpy
    float32 array / 255  →  torch.Tensor (1, H, W, 3)
"""
from __future__ import annotations

import io as _io
import logging

import numpy as np
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

from .common import ChannelDict


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
                "plot_type": (["line", "scatter"],),
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

    def plot(self, x_channel, y_channel, plot_type: str, width: int, height: int, dpi: int):
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
        x_unit  = x_channel.get("units", "")
        y_unit  = y_channel.get("units", "")
        x_label = f"{x_name} - [{x_unit}]" if x_unit else x_name
        y_label = f"{y_name} - [{y_unit}]" if y_unit else y_name

        # Create figure at the requested pixel size (matplotlib works in inches)
        x_src = x_channel.get("source_file", "")
        y_src = y_channel.get("source_file", "")
        if x_src == y_src:
            source_note = f"Source: {x_src}" if x_src else ""
        else:
            source_note = f"Source: {x_src} / {y_src}"

        fig, ax = plt.subplots(figsize=(width / dpi, height / dpi), dpi=dpi)
        if plot_type == "scatter":
            ax.scatter(x_data, y_data, s=4, linewidths=0)
        else:
            ax.plot(x_data, y_data, linewidth=1.0)
        ax.set_xlabel(x_label)
        ax.set_ylabel(y_label)
        ax.grid(True, alpha=0.3)
        fig.tight_layout()
        if source_note:
            fig.text(
                0.99, 0.01, source_note,
                ha="right", va="bottom",
                fontsize=7, color="gray", style="italic",
                transform=fig.transFigure,
            )

        # Render to in-memory PNG → PIL Image → numpy → torch tensor
        buf = _io.BytesIO()
        fig.savefig(buf, format="png", dpi=dpi)
        plt.close(fig)    # Release matplotlib memory — important for repeated executions
        buf.seek(0)

        pil_img = _PIL_Image.open(buf).convert("RGB")
        arr     = np.array(pil_img).astype(np.float32) / 255.0  # (H, W, 3), range [0, 1]
        tensor  = torch.from_numpy(arr)[None,]                   # (1, H, W, 3)

        return (tensor,)
