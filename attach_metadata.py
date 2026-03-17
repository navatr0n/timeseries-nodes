"""
attach_metadata.py — AttachMetadata node.

Attaches a list of (variable_name, value) tuples to a TIMESERIES dict.

Modes
-----
append  : new tuples are merged into the existing metadata list.
replace : existing metadata is discarded; the new list is used as-is.

Duplicate handling (relevant only when mode = "append")
--------------------------------------------------------
first : the existing (old) value wins; incoming duplicate is omitted.
last  : the incoming (new) value wins; the old entry is removed.
"""
from __future__ import annotations


class AttachMetadata:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "timeseries": ("TIMESERIES",),
                "mode": (["append", "replace"], {"default": "append"}),
                "keep_duplicates": (["last", "first"], {"default": "last"}),
            },
            "optional": {
                "metadata": ("METADATA", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("TIMESERIES",)
    RETURN_NAMES = ("timeseries",)
    FUNCTION = "attach"
    CATEGORY = "timeseries"
    DESCRIPTION = (
        "Attach metadata (variable_name, value) tuples to a TIMESERIES.\n"
        "mode='replace' discards existing metadata; mode='append' merges.\n"
        "keep_duplicates='first' keeps the old value; 'last' keeps the new one."
    )

    @staticmethod
    def _dedup(tuples: list, keep: str) -> list:
        """
        Remove duplicate variable names from a flat list of (name, value) tuples.
        keep='first' retains the first occurrence; keep='last' retains the last.
        """
        if keep == "first":
            seen: dict = {}
            for name, value in tuples:
                if name not in seen:
                    seen[name] = value
            return list(seen.items())
        else:  # last
            seen = {}
            for name, value in tuples:
                seen[name] = value
            return list(seen.items())

    def attach(
        self,
        timeseries: dict,
        mode: str = "append",
        keep_duplicates: str = "last",
        metadata: list | None = None,
    ) -> tuple:
        incoming = list(metadata) if metadata else []

        if mode == "replace":
            merged = incoming
        else:  # append
            existing = list(timeseries.get("metadata") or [])
            if keep_duplicates == "first":
                # Old wins: put existing first so dedup keeps it.
                merged = self._dedup(existing + incoming, keep="first")
            else:
                # New wins: put incoming last so dedup keeps it.
                merged = self._dedup(existing + incoming, keep="last")

        result = {**timeseries, "metadata": merged}
        return (result,)
