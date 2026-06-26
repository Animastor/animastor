#!/usr/bin/env python3
"""
animastor — Source Code Backup Script

Creates a compact .zip archive of project source files and text configs,
excluding binaries, media, build artifacts, caches, and dependencies.

Usage:
    ./src-backup.sh

Prompts for an optional label, then creates:
    animastor-src-YYYY-MM-DD_HH-MM-SS[-label].zip
"""

import os
import sys
import zipfile
import fnmatch
from datetime import datetime
from pathlib import Path

# ── Configuration ────────────────────────────────────────────────────────────
# Modify these lists to add/remove directories and file types.

# Output directory for the archive
OUTPUT_DIR = Path('/backups')

# Directories to EXCLUDE entirely (will be skipped during traversal)
EXCLUDE_DIRS = [
    '.git',
    'node_modules',
    'build',
    '.gradle',
    '__pycache__',
    '.venv',
    'venv',
]

# File extensions to INCLUDE (source code, configs, docs)
INCLUDE_EXTS = {
    # Source code
    '.js', '.cjs', '.mjs', '.ts', '.kt', '.kts', '.java',
    # Web / UI
    '.xml', '.html', '.css', '.svg', '.drawio',
    # Config / data
    '.json', '.yml', '.yaml', '.toml', '.properties', '.cfg', '.conf', '.ini',
    '.env',
    # Documentation
    '.md', '.txt',
    # Shell / scripts
    '.sh',
    # Docker
    '.dockerfile',
    # Gradle / build
    '.gradle', '.kts', '.pro',
}

# Exact filenames to include (without extension or with special names)
INCLUDE_NAMES = {
    'Dockerfile',
    'Makefile',
    '.gitignore',
    '.dockerignore',
    '.env.example',
    'gradlew',
    'gradlew.bat',
}

# Binary/media extensions to EXCLUDE (safety net overrides INCLUDE_EXTS)
EXCLUDE_EXTS = {
    # Audio
    '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
    # Images
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
    # Video
    '.mp4', '.webm', '.avi', '.mov', '.mkv',
    # Archives
    '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.rar', '.7z',
    # Fonts
    '.woff', '.woff2', '.ttf', '.eot', '.otf',
    # Binary documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    # Binaries / packages
    '.deb', '.rpm', '.apk', '.aab', '.so', '.dll', '.dylib', '.exe',
    '.jar', '.war', '.class', '.pyc', '.pyd',
    # Build artifacts
    '.oat', '.odex', '.vdex', '.art',
}


def should_include(rel_path: str) -> bool:
    """Check if a file should be included in the archive."""

    rel = Path(rel_path)
    parts = rel.parts

    # Exclude directories
    for excluded in EXCLUDE_DIRS:
        if excluded in parts:
            return False

    # Exclude by extension
    ext = rel.suffix.lower()
    if ext in EXCLUDE_EXTS:
        return False

    # Include by extension
    if ext in INCLUDE_EXTS:
        return True

    # Include by exact filename
    if rel.name in INCLUDE_NAMES:
        return True

    return False


def collect_files(root: str) -> list[Path]:
    """Walk the directory tree and return all files matching include rules."""
    files = []
    root = os.path.abspath(root)

    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        # Prune excluded directories in-place (prevents os.walk from descending)
        dirnames[:] = [
            d for d in dirnames
            if d not in EXCLUDE_DIRS
        ]

        for filename in filenames:
            full_path = os.path.join(dirpath, filename)
            rel_path = os.path.relpath(full_path, root)
            if should_include(rel_path):
                files.append(full_path)

    return sorted(files)


def main():
    print("╔══════════════════════════════════════╗")
    print("║  animastor — Source Archive Creator  ║")
    print("╚══════════════════════════════════════╝")
    print()

    # ── Prompt for optional label ──
    label = input("Optional label (or press Enter to skip): ").strip()
    print()

    # ── Determine project root (where this script lives) ──
    script_dir = Path(__file__).resolve().parent
    os.chdir(script_dir)

    # ── Build archive filename ──
    ts = datetime.now().strftime('%Y-%m-%d_%H-%M-%S')
    if label:
        archive_name = f"animastor-src-{ts}-{label}.zip"
    else:
        archive_name = f"animastor-src-{ts}.zip"
    archive_path = OUTPUT_DIR / archive_name

    # ── Collect files ──
    print("Scanning project files...")
    files = collect_files(str(script_dir))

    if not files:
        print("❌ No matching files found. Check include/exclude lists in the script.")
        sys.exit(1)

    # Ensure output directory exists
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Found {len(files)} files. Creating archive...")

    # ── Create archive ──
    file_count = 0
    with zipfile.ZipFile(
        str(archive_path),
        mode='w',
        compression=zipfile.ZIP_DEFLATED,
        allowZip64=True,
    ) as zf:
        for filepath in files:
            rel_path = os.path.relpath(filepath, str(script_dir))
            zf.write(filepath, rel_path)
            file_count += 1

    # ── Report ──
    archive_size = os.path.getsize(str(archive_path))
    # Human-readable size
    if archive_size < 1024:
        size_str = f"{archive_size} B"
    elif archive_size < 1024 ** 2:
        size_str = f"{archive_size / 1024:.1f} KB"
    else:
        size_str = f"{archive_size / (1024 ** 2):.1f} MB"

    print()
    print("✅ Archive created successfully!")
    print(f"   Path:  {archive_path}")
    print(f"   Size:  {size_str}")
    print(f"   Files: {file_count}")
    print()


if __name__ == '__main__':
    main()
