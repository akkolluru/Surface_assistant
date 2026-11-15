"""Safe local wallpaper discovery (images & looping MP4s) with bundled fallbacks."""

from __future__ import annotations

from pathlib import Path

from daemon.models import MediaKind, WallpaperItem, WallpaperState

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".svg"}
VIDEO_EXTS = {".mp4", ".webm"}
BUNDLED_ASSETS_DIR = Path(__file__).resolve().parent / "assets" / "wallpapers"


class WallpaperService:
    """Indexes ~/wallpapers/static and ~/wallpapers/loops with path-traversal protection."""

    def __init__(self, wallpapers_root: Path, interval_seconds: int = 180) -> None:
        self._root = wallpapers_root
        self._interval_seconds = interval_seconds
        self._items: list[WallpaperItem] = []
        self._file_map: dict[str, Path] = {}
        self._current_index = 0
        self.refresh()

    def refresh(self) -> WallpaperState:
        items: list[WallpaperItem] = []
        file_map: dict[str, Path] = {}

        scan_dirs: list[tuple[Path, MediaKind]] = [
            (self._root / "static", "image"),
            (self._root / "loops", "video"),
            (self._root, "image"),
        ]

        seen_names: set[str] = set()
        for directory, default_kind in scan_dirs:
            if not directory.exists() or not directory.is_dir():
                continue
            for entry in sorted(directory.iterdir()):
                if not entry.is_file():
                    continue
                ext = entry.suffix.lower()
                if ext in VIDEO_EXTS:
                    kind: MediaKind = "video"
                elif ext in IMAGE_EXTS:
                    kind = "image"
                else:
                    continue
                _ = default_kind
                item_id = f"{entry.parent.name}_{entry.name}"
                if item_id in seen_names:
                    continue
                seen_names.add(item_id)
                file_map[item_id] = entry.resolve()
                items.append(
                    WallpaperItem(
                        id=item_id,
                        filename=entry.name,
                        kind=kind,
                        url=f"/api/wallpapers/file/{item_id}",
                    )
                )

        if not items and BUNDLED_ASSETS_DIR.exists():
            for entry in sorted(BUNDLED_ASSETS_DIR.iterdir()):
                if entry.is_file() and entry.suffix.lower() in IMAGE_EXTS:
                    item_id = f"bundled_{entry.name}"
                    file_map[item_id] = entry.resolve()
                    items.append(
                        WallpaperItem(
                            id=item_id,
                            filename=entry.name,
                            kind="image",
                            url=f"/api/wallpapers/file/{item_id}",
                        )
                    )

        self._items = items
        self._file_map = file_map
        if self._current_index >= len(self._items):
            self._current_index = 0
        return self.state

    @property
    def state(self) -> WallpaperState:
        return WallpaperState(
            current_index=self._current_index,
            interval_seconds=self._interval_seconds,
            items=list(self._items),
        )

    def next_wallpaper(self) -> WallpaperState:
        if not self._items:
            self.refresh()
        if self._items:
            self._current_index = (self._current_index + 1) % len(self._items)
        return self.state

    def resolve_file(self, item_id: str) -> Path | None:
        return self._file_map.get(item_id)
