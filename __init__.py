"""
timeseries_nodes: ComfyUI nodes for loading and mapping timeseries data.

Nodes
-----
LoadTimeseries    -- Load a CSV file and output a TIMESERIES dict.
ChannelMapper     -- Map CSV columns into named, scaled CHANNEL outputs.
ChannelXYPlot     -- Plot two CHANNEL signals as an XY chart (IMAGE output). Display name: XY-Plotter-Simple.
ChannelBundle     -- Bundle multiple CHANNEL signals into a TIMESERIES (like MATLAB Mux/Bus Creator).
AttachMetadata    -- Attach or replace metadata on a TIMESERIES.
SaveHDF5          -- Save a single TIMESERIES to an HDF5 file.
TimeseriesListBundle -- Bundle multiple TIMESERIES into a LIST (channel intersection).
SaveHDF5List      -- Save a LIST of TIMESERIES to a single HDF5 file.
LoadHDF5List      -- Load a LIST of TIMESERIES from an HDF5 file.
XYPlotOverlay     -- Plot a LIST of TIMESERIES as overlaid XY lines (IMAGE output).

Dependencies:
  - numpy      (required, already in ComfyUI requirements.txt)
  - torch      (required, already in ComfyUI requirements.txt)
  - Pillow     (required, already in ComfyUI requirements.txt)
  - h5py       (required for SaveHDF5 / SaveHDF5List / LoadHDF5List; pip install h5py)
  - pandas     (optional, improves CSV parsing;  pip install pandas)
  - matplotlib (optional, required for ChannelXYPlot / XYPlotOverlay; pip install matplotlib)

Without pandas, uses Python's built-in csv module which handles standard CSV.
With pandas, supports auto-detection of mixed types, non-comma separators, etc.

File layout
-----------
  common.py             Shared types (TimeseriesDict, ChannelDict), constants,
                        and helper functions (_load_csv, _parse_channel_mapping, …)
  load_timeseries.py    LoadTimeseries node
  channel_mapper.py     ChannelMapper node + _UnboundedChannelTypes helper
  channel_xy_plot.py    ChannelXYPlot node
  save_hdf5.py          SaveHDF5 node + module-level HDF5 write helpers
  save_hdf5_list.py     SaveHDF5List node
  load_hdf5_list.py     LoadHDF5List node
  xy_plot_overlay.py    XYPlotOverlay node
  __init__.py           This file — thin entry point for ComfyUI plugin discovery
"""

from .load_timeseries        import LoadTimeseries
from .channel_mapper         import ChannelMapper
from .channel_xy_plot        import ChannelXYPlot
from .channel_bundle         import ChannelBundle
from .attach_metadata        import AttachMetadata
from .save_hdf5              import SaveHDF5
from .timeseries_list_bundle import TimeseriesListBundle
from .save_hdf5_list         import SaveHDF5List
from .load_hdf5_list         import LoadHDF5List
from .xy_plot_overlay        import XYPlotOverlay
from .timeseries_dashboard   import TimeseriesDashboard

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
    "SaveHDF5List":          SaveHDF5List,
    "LoadHDF5List":          LoadHDF5List,
    "XYPlotOverlay":         XYPlotOverlay,
    "TimeseriesDashboard":   TimeseriesDashboard,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "LoadTimeseries":        "Load Timeseries",
    "ChannelMapper":         "Channel Mapper (editor)",
    "ChannelXYPlot":         "XY-Plotter-Simple",
    "ChannelBundle":         "Channel Bundle",
    "AttachMetadata":        "Attach Metadata",
    "SaveHDF5":              "Save HDF5",
    "TimeseriesListBundle":  "Timeseries Bundle",
    "SaveHDF5List":          "Save HDF5 List",
    "LoadHDF5List":          "Load HDF5 List",
    "XYPlotOverlay":         "XY-Plotter-Overlay",
    "TimeseriesDashboard":   "Timeseries Dashboard",
}

# JS extensions are served from the ./js directory.
WEB_DIRECTORY = "./js"

# ---------------------------------------------------------------------------
# Custom API route: GET /timeseries/columns?file=<filename>
# Returns the column list for a given file so the JS table widget can
# auto-populate rows when a TIMESERIES is connected, without running the graph.
# ---------------------------------------------------------------------------
import os as _os

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


@PromptServer.instance.routes.get("/timeseries/list_channels")
async def get_list_channels(request: web.Request) -> web.Response:
    """
    Return the intersection of channel names from all TIMESERIES entries in a
    SaveHDF5List file.  Used by the XYPlotOverlay JS to populate channel combos
    when the timeseries_list input is sourced from a LoadHDF5List node.

    Query param: file=<filename>  (just the filename, searched in output dir)
    """
    filename = request.rel_url.query.get("file", "")
    if not filename:
        return web.json_response({"error": "no file specified"}, status=400)

    output_dir = folder_paths.get_output_directory()
    filepath = _os.path.join(output_dir, filename)
    if not _os.path.isfile(filepath):
        return web.json_response({"error": f"file not found: {filename}"}, status=404)

    try:
        import h5py
        with h5py.File(filepath, "r") as f:
            fmt = f.attrs.get("format", "")
            if fmt != "timeseries_list":
                return web.json_response(
                    {"error": f"not a timeseries_list file (format='{fmt}')"},
                    status=400,
                )
            count = int(f.attrs.get("count", 0))
            channel_lists = []
            for i in range(count):
                key = f"timeseries_{i}"
                if key not in f:
                    break
                grp = f[key]
                if "channel_names" in grp:
                    channel_lists.append(list(grp["channel_names"].asstr()[:]))

        if not channel_lists:
            return web.json_response({"channels": []})

        common = set(channel_lists[0])
        for names in channel_lists[1:]:
            common &= set(names)
        # Preserve order from first entry
        ordered = [ch for ch in channel_lists[0] if ch in common]
        return web.json_response({"channels": ordered})

    except ImportError:
        return web.json_response(
            {"error": "h5py not installed on server"}, status=500
        )
    except Exception as exc:
        return web.json_response({"error": str(exc)}, status=500)


# ---------------------------------------------------------------------------
# Dashboard data endpoint — GET /timeseries/dashboard/data/<node_id>
# Returns the downsampled series payload stored by TimeseriesDashboard.execute().
# ---------------------------------------------------------------------------

@PromptServer.instance.routes.get("/timeseries/dashboard/data/{node_id}")
async def get_dashboard_data(request: web.Request) -> web.Response:
    node_id = request.match_info["node_id"]
    from .timeseries_dashboard import _DASHBOARD_DATA
    payload = _DASHBOARD_DATA.get(node_id)
    if payload is None:
        return web.json_response(
            {"error": "No data for this node — run the graph first."},
            status=404,
        )
    return web.json_response(payload)


