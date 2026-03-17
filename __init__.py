"""
timeseries_nodes: ComfyUI nodes for loading and mapping timeseries data.

Nodes
-----
LoadTimeseries  -- Load a CSV file and output a TIMESERIES dict.
ChannelMapper   -- Map CSV columns into named, scaled CHANNEL outputs.
ChannelXYPlot   -- Plot two CHANNEL signals as an XY chart (IMAGE output). Display name: XY-Plotter-Simple.
ChannelBundle   -- Bundle multiple CHANNEL signals into a TIMESERIES (like MATLAB Mux/Bus Creator).

Dependencies:
  - numpy      (required, already in ComfyUI requirements.txt)
  - torch      (required, already in ComfyUI requirements.txt)
  - Pillow     (required, already in ComfyUI requirements.txt)
  - h5py       (required for SaveHDF5; pip install h5py)
  - pandas     (optional, improves CSV parsing;  pip install pandas)
  - matplotlib (optional, required for ChannelXYPlot; pip install matplotlib)

Without pandas, uses Python's built-in csv module which handles standard CSV.
With pandas, supports auto-detection of mixed types, non-comma separators, etc.

File layout
-----------
  common.py           Shared types (TimeseriesDict, ChannelDict), constants,
                      and helper functions (_load_csv, _parse_channel_mapping, …)
  load_timeseries.py  LoadTimeseries node
  channel_mapper.py   ChannelMapper node + _UnboundedChannelTypes helper
  channel_xy_plot.py  ChannelXYPlot node
  __init__.py         This file — thin entry point for ComfyUI plugin discovery
"""

from .load_timeseries        import LoadTimeseries
from .channel_mapper         import ChannelMapper
from .channel_xy_plot        import ChannelXYPlot
from .channel_bundle         import ChannelBundle
from .attach_metadata        import AttachMetadata
from .save_hdf5              import SaveHDF5
from .timeseries_list_bundle import TimeseriesListBundle

# ---------------------------------------------------------------------------
# ComfyUI plugin registration
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "LoadTimeseries":        LoadTimeseries,
    "ChannelMapper":         ChannelMapper,
    "ChannelXYPlot":         ChannelXYPlot,
    "ChannelBundle":         ChannelBundle,
    "AttachMetadata":        AttachMetadata,
    "SaveHDF5":              SaveHDF5,
    "TimeseriesListBundle":  TimeseriesListBundle,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadTimeseries":        "Load Timeseries",
    "ChannelMapper":         "Channel Mapper (editor)",
    "ChannelXYPlot":         "XY-Plotter-Simple",
    "ChannelBundle":         "Channel Bundle",
    "AttachMetadata":        "Attach Metadata",
    "SaveHDF5":              "Save HDF5",
    "TimeseriesListBundle":  "Timeseries Bundle",
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
from .common import _load_csv, folder_paths


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
        return web.json_response({"channels": columns, "units": [""] * len(columns)})
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


