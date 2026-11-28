#!/usr/bin/env python3
"""Compare real APFS allocations for isolated Works and Vite fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import statistics
import tempfile
import time

HERE = Path(__file__).resolve().parent
CORE = HERE.parents[2]
BASELINE = HERE.parent / "instant-project-sandbox-2026-11-28" / "disk-baseline.py"
spec = importlib.util.spec_from_file_location("p0", BASELINE)
p0 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p0)
BUN = shutil.which("bun")
RUNTIME = CORE / "api/domains/prototype/runtime"
MANIFEST = json.loads((RUNTIME / "dependencies.json").read_text())
p0.PACKAGES = {
    "dependencies": {k: v for k, v in MANIFEST["dependencies"].items() if k != "typescript"},
    "devDependencies": {**MANIFEST["devDependencies"],
                        "typescript": MANIFEST["dependencies"]["typescript"], "vite": "8.3.5"},
}

def tool(env, *args):
    return p0.run([BUN, "--no-env-file", "scripts/works-runtime.ts", *map(str, args)], cwd=CORE, env=env)

def git(cwd, *args):
    return p0.run(["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", str(cwd), *args])

def tag(repo, version):
    git(repo, "add", ".")
    git(repo, "-c", "user.email=works-test@example.invalid", "-c", "user.name=Works Trial", "commit", "-qm", version)
    git(repo, "tag", f"works-v{version}")

def summary(rows):
    return {key: {"median": statistics.median(row[key] for row in rows),
                  "min": min(row[key] for row in rows), "max": max(row[key] for row in rows)}
            for key in rows[0]}

def measure(root, seeds, env, primed):
    root.mkdir()
    image, mount = root / "works.sparseimage", root / "mounted"
    mount.mkdir()
    p0.run(["hdiutil", "create", "-size", "1g", "-fs", "APFS", "-type", "SPARSE", "-volname", "WorksMeasurements", str(image)])
    p0.run(["hdiutil", "attach", "-nobrowse", "-mountpoint", str(mount), str(image)])
    try:
        home, data, works = [mount / n for n in ("runtime", "data", "works")]
        for directory in (home, data, works):
            directory.mkdir()
        for name in ("first", "second"):
            target = works / name
            target.mkdir()
            (target / "src").mkdir()
            (target / "prototype.json").write_text(json.dumps({
                "schema": 1, "name": name, "entry": "src/main.tsx", "environment": "3.0",
                "features": [], "include": ["src"]
            }))
            (target / "src/main.tsx").write_text(
                'import React from "react"; import {createRoot} from "react-dom/client";\n'
                'import {MathUtils} from "three"; import {Vec3} from "cannon-es";\n'
                f'createRoot(document.getElementById("app")!).render(<h1>{name} {{MathUtils.clamp(new Vec3(2,0,0).length(),0,10)}}</h1>);\n')
        if primed:
            cache = home / "cache"
            warmup = root / "cache-warmup"
            warmup.mkdir()
            shutil.copyfile(seeds / "package.json", warmup / "package.json")
            shutil.copyfile(seeds / "bun.lock", warmup / "bun.lock")
            shutil.copyfile(seeds / "bunfig.toml", warmup / "bunfig.toml")
            p0.install(BUN, warmup, cache, env)
            shutil.rmtree(warmup)
        initial = p0.used_bytes(mount)
        values = {}
        for version in ("3.0", "3.1", "3.2"):
            pin = json.loads(tool(env, "pin", seeds, version))
            start = time.monotonic()
            tool(env, "install", home, seeds, version, pin["commit"], pin["digest"])
            if version == "3.0":
                values["preparation_ms"] = round((time.monotonic()-start)*1000)
                values["zero_works_allocated_bytes"] = p0.used_bytes(mount)-initial
                for name in ("first", "second"):
                    built = p0.run([str(home / "bin/eumenes-prototype"), "build"], cwd=works / name,
                                   env={**env, "EUMENES_PROTOTYPE_HOME": str(home)})
                    assert built == "dist/index.html"
                    values[name+"_cumulative_allocated_bytes"] = p0.used_bytes(mount)-initial
            else:
                key = "addition_with_old_release_bytes" if version == "3.1" else "after_oldest_cleanup_bytes"
                values[key] = p0.used_bytes(mount)-initial
        assert not (home / "releases/3.0").exists()
        assert (home / "releases/3.1").exists() and (home / "releases/3.2").exists()
        return values
    finally:
        p0.run(["hdiutil", "detach", str(mount)])

with tempfile.TemporaryDirectory(prefix="works-apfs-") as path:
    temp = Path(path).resolve()
    env = {"PATH": os.environ["PATH"], "HOME": str(temp), "TMPDIR": str(temp)}
    baseline = p0.create_project(temp, "baseline-lock")
    p0.install(BUN, baseline, temp/"baseline-cache", env, frozen=False)
    baseline_lock = (baseline / "bun.lock").read_bytes()
    seed = temp / "release"
    tool(env, "export", seed)
    git(seed, "init", "-q")
    tag(seed, "3.0")
    for version, package in (("3.1", {"nanoid": "5.1.5"}), ("3.2", {"picocolors": "1.1.1"})):
        manifest = json.loads((seed / "package.json").read_text())
        manifest["dependencies"].update(package)
        (seed / "package.json").write_text(json.dumps(manifest, indent=2)+"\n")
        p0.install(BUN, seed, temp/"shared-lock-cache", env, frozen=False)
        tag(seed, version)
    git(seed, "checkout", "-q", "works-v3.0")
    results = {"filesystem": "APFS, isolated sparse volumes", "bun": p0.run([BUN, "--version"]),
               "installBackend": "clonefile", "trialsPerMode": 3, "typescript": "5.9.3", "vite": "8.3.5"}
    for label, primed in (("cold", False), ("primed", True)):
        baseline_values, shared_values = [], []
        for i in range(3):
            baseline_values.append(p0.measure(BUN,temp/f"baseline-{label}-{i}",baseline_lock,env,primed))
            shared_values.append(measure(temp/f"shared-{label}-{i}",seed,env,primed))
        results[label] = {"separate": summary(baseline_values), "works": summary(shared_values)}
    print(json.dumps(results, indent=2))
