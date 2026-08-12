#!/usr/bin/env python3
"""Build deterministic macOS and Windows onboarding ZIP archives."""

from __future__ import annotations

import argparse
import hashlib
import pathlib
import stat
import zipfile


HERE = pathlib.Path(__file__).resolve().parent
AGENT_DIR = HERE.parent
FIXED_TIME = (2026, 8, 12, 0, 0, 0)

COMMON = (
    (AGENT_DIR / "requirements.txt", "requirements.txt", False),
    (HERE / "install.py", "installer/install.py", True),
    (HERE / "release.json", "installer/release.json", False),
    (HERE / "config.template.json", "installer/config.template.json", False),
)

PLATFORMS = {
    "macos": (
        (AGENT_DIR / "install-macos.command", "install-macos.command", True),
    ),
    "windows": (
        (AGENT_DIR / "install-windows.cmd", "install-windows.cmd", False),
        (AGENT_DIR / "install-windows.ps1", "install-windows.ps1", False),
    ),
}


def archive_entry(path: pathlib.Path, name: str, executable: bool) -> tuple[zipfile.ZipInfo, bytes]:
    if not path.is_file():
        raise FileNotFoundError(f"bundle input is missing: {path}")
    info = zipfile.ZipInfo(name, FIXED_TIME)
    info.create_system = 3
    mode = (stat.S_IFREG | (0o755 if executable else 0o644)) << 16
    info.external_attr = mode
    info.compress_type = zipfile.ZIP_DEFLATED
    return info, path.read_bytes()


def build(output: pathlib.Path, platform_name: str) -> tuple[pathlib.Path, str]:
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"lh2-sync-agent-{platform_name}.zip"
    members = (*PLATFORMS[platform_name], *COMMON)
    with zipfile.ZipFile(destination, "w") as archive:
        for path, name, executable in members:
            info, data = archive_entry(path, name, executable)
            archive.writestr(info, data)
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    return destination, digest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path, default=AGENT_DIR / "dist")
    args = parser.parse_args()
    for platform_name in ("macos", "windows"):
        path, digest = build(args.output.resolve(), platform_name)
        print(f"{path}\n  sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
