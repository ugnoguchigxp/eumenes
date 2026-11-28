#!/usr/bin/env python3
"""Measure the allocation of two conventional Bun installs on an isolated APFS volume."""

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time

PACKAGES = {
    "dependencies": {
        "cannon-es": "0.20.0",
        "react": "19.2.7",
        "react-dom": "19.2.7",
        "three": "0.186.1",
    },
    "devDependencies": {
        "@types/react": "19.2.17",
        "@types/react-dom": "19.2.3",
        "@types/three": "0.186.0",
        "typescript": "7.0.2",
        "vite": "8.3.5",
    },
}


def run(argv, **options):
    result = subprocess.run(argv, text=True, capture_output=True, **options)
    if result.returncode:
        raise RuntimeError(f"{argv[0]} {argv[1]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def used_bytes(mount):
    volume = os.statvfs(mount)
    return (volume.f_blocks - volume.f_bfree) * volume.f_frsize


def install(bun, project, cache, env, *, frozen=True):
    argv = [bun, "install", "--ignore-scripts", "--backend=clonefile", f"--cache-dir={cache}"]
    if frozen:
        argv.append("--frozen-lockfile")
    start = time.monotonic()
    run(argv, cwd=project, env=env)
    return round((time.monotonic() - start) * 1000)


def create_project(parent, name, lock=None):
    project = parent / name
    project.mkdir()
    manifest = {"name": "works-disk-baseline", "private": True, **PACKAGES}
    (project / "package.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (project / "bunfig.toml").write_text("[install]\nminimumReleaseAge = 604800\n")
    if lock is not None:
        (project / "bun.lock").write_bytes(lock)
    return project


def measure(bun, root, lock, env, primed):
    root.mkdir()
    image = root / "baseline.sparseimage"
    mount = root / "mounted"
    mount.mkdir()
    run(["hdiutil", "create", "-size", "512m", "-fs", "APFS", "-type", "SPARSE",
         "-volname", "WorksBaseline", str(image)])
    run(["hdiutil", "attach", "-nobrowse", "-mountpoint", str(mount), str(image)])
    try:
        cache = mount / "cache"
        if primed:
            warmup = create_project(mount, "cache-warmup", lock)
            install(bun, warmup, cache, env)
            shutil.rmtree(warmup)
        first = create_project(mount, "first", lock)
        second = create_project(mount, "second", lock)

        before = used_bytes(mount)
        first_ms = install(bun, first, cache, env)
        after_first = used_bytes(mount)
        second_ms = install(bun, second, cache, env)
        after_second = used_bytes(mount)

        return {
            "first_install_allocated_bytes": after_first - before,
            "second_install_allocated_bytes": after_second - after_first,
            "two_install_allocated_bytes": after_second - before,
            "first_install_ms": first_ms,
            "second_install_ms": second_ms,
            "apfs_fragment_bytes": os.statvfs(mount).f_frsize,
        }
    finally:
        run(["hdiutil", "detach", str(mount)])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--reference", type=Path, help="Reuse an earlier result’s lockfile.")
    parser.add_argument("--output", type=Path, help="Write a new JSON result to this path.")
    args = parser.parse_args()
    if platform.system() != "Darwin" or args.trials < 1:
        parser.error("Run on macOS with at least one trial.")
    bun = shutil.which("bun")
    if bun is None:
        parser.error("Bun is required.")

    with tempfile.TemporaryDirectory(prefix="works-disk-") as folder:
        root = Path(folder).resolve()
        # No account credentials, user-level Bun configuration, or production cache.
        env = {"PATH": os.environ["PATH"], "HOME": str(root), "TMPDIR": str(root)}
        if args.reference:
            reference = json.loads(args.reference.read_text())
            if reference["dependencies"] != PACKAGES:
                parser.error("The reference uses a different dependency set.")
            lock = reference["bun_lock"].encode()
        else:
            seed = create_project(root, "lock-source")
            install(bun, seed, root / "lock-cache", env, frozen=False)
            lock = (seed / "bun.lock").read_bytes()
        samples = {}
        for label, primed in [("cold", False), ("primed", True)]:
            samples[label] = [
                measure(bun, root / f"{label}-{i}", lock, env, primed)
                for i in range(args.trials)
            ]

    data = json.dumps({
        "os": platform.mac_ver()[0],
        "machine": platform.machine(),
        "bun": run([bun, "--version"]),
        "filesystem": "APFS (sparse disk image, isolated per trial)",
        "backend": "clonefile",
        "dependencies": PACKAGES,
        "bun_lock": lock.decode(),
        "samples": samples,
    }, indent=2)
    if args.output:
        with args.output.open("x") as output:
            output.write(data + "\n")
    else:
        print(data)


if __name__ == "__main__":
    main()
