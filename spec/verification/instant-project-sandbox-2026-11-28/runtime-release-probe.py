#!/usr/bin/env python3
"""P0 publication, co-installation, hold/evict and reconstruction in disposable Git."""

import hashlib
from itertools import count
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
FILES = ("package.json", "bun.lock", "bunfig.toml", "resolution.json", "cli.ts", "adapter.ts")
LIMIT = 512 * 1024 * 1024


def digest(files):
    sha = hashlib.sha256()
    for name in FILES:
        body = files[name]
        sha.update(name.encode())
        sha.update(len(body).to_bytes(8, "big"))
        sha.update(body)
    return sha.hexdigest()


def size(root):
    # Conservative logical budget, separate from the APFS physical measurement.
    return sum(p.lstat().st_size for p in root.rglob("*") if p.is_file() and not p.is_symlink())


def main():
    baseline = json.loads((HERE / "disk-baseline.json").read_text())
    bun = str(Path(shutil.which("bun")).resolve())
    with tempfile.TemporaryDirectory(prefix="works-releases-") as folder:
        root = Path(folder).resolve()
        env = {
            "PATH": os.environ["PATH"], "HOME": str(root),
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
        }
        source = root / "publisher"
        source.mkdir()
        cache = root / "bun-cache"
        installs = root / "installed"
        installs.mkdir()
        pins = {"1.0", "1.1"}
        releases, last_used = {}, {}
        access_count = count()

        def run(cwd, *argv):
            return subprocess.run(
                argv, cwd=cwd, env=env, check=True, capture_output=True, timeout=75,
            ).stdout

        def git(cwd, *args):
            return run(cwd, "git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Works P0",
                       "-c", "user.email=p0@example.invalid", *args)

        def install(target, frozen):
            flags = ["--frozen-lockfile"] if frozen else []
            run(target, bun, "install", "--ignore-scripts", f"--cache-dir={cache}", *flags)

        def tag(version):
            if not re.fullmatch(r"[1-9][0-9]*\.[0-9]+", version):
                raise ValueError("invalid_release_version")
            return f"works-v{version}"

        def publish(version):
            if version in releases:
                raise ValueError("release_already_published")
            git(source, "add", "--", *FILES)
            git(source, "commit", "-qm", f"Works fixture {version}")
            git(source, "tag", tag(version))
            commit = git(source, "rev-parse", "HEAD").decode().strip()
            files = {name: (source / name).read_bytes() for name in FILES}
            releases[version] = {"commit": commit, "digest": digest(files)}

        def verified(source_copy, version):
            pinned = releases[version]
            actual = git(source_copy, "rev-parse", f"refs/tags/{tag(version)}^{{commit}}").decode().strip()
            if actual != pinned["commit"]:
                raise ValueError("release_ref_changed")
            files = {name: git(source_copy, "show", f"{actual}:{name}") for name in FILES}
            if digest(files) != pinned["digest"]:
                raise ValueError("release_content_changed")
            return files

        def prepare(source_copy, version, budget=LIMIT):
            files = verified(source_copy, version)
            dest = installs / version
            if dest.exists():
                assert digest({name: (dest / name).read_bytes() for name in FILES}) == releases[version]["digest"]
                last_used[version] = next(access_count)
                return
            victims = sorted(set(last_used) - pins, key=lambda item: (last_used[item], item))
            if len(last_used) >= 2 and not victims:
                raise ValueError("all_retained_releases_in_use")
            with tempfile.TemporaryDirectory(prefix="staging-", dir=installs) as temp:
                stage = Path(temp) / "ready"
                stage.mkdir()
                for name, body in files.items():
                    (stage / name).write_bytes(body)
                install(stage, frozen=True)
                assert digest({name: (stage / name).read_bytes() for name in FILES}) == releases[version]["digest"]
                remaining = set(last_used)
                while (len(remaining) >= 2 or
                       size(cache) + size(stage) + sum(size(installs / v) for v in remaining) > budget):
                    if not victims:
                        raise ValueError("retained_releases_over_budget")
                    remaining.remove(victims.pop(0))
                stage.rename(dest)
                for removed in sorted(set(last_used) - remaining):
                    shutil.rmtree(installs / removed)
                    del last_used[removed]
                    events.append(f"evicted {removed}")
            last_used[version] = next(access_count)
            events.append(f"prepared {version}")

        events = []
        git(source, "init", "--quiet", "--initial-branch=main")
        manifest = {"name": "works-disk-baseline", "private": True, **baseline["dependencies"]}
        (source / "package.json").write_text(json.dumps(manifest))
        (source / "bun.lock").write_text(baseline["bun_lock"])
        (source / "bunfig.toml").write_text("[install]\nminimumReleaseAge = 604800\n")
        (source / "resolution.json").write_text('{"react":"node_modules/react/index.js"}\n')
        (source / "cli.ts").write_text("export const fixtureProtocol = 1;\n")
        (source / "adapter.ts").write_text("export const fixtureAdapter = 1;\n")
        publish("1.0")
        manifest["dependencies"] = {**manifest["dependencies"], "zod": "4.4.3"}
        (source / "package.json").write_text(json.dumps(manifest))
        install(source, frozen=False)
        (source / "resolution.json").write_text(
            '{"react":"node_modules/react/index.js","zod":"node_modules/zod/index.js"}\n',
        )
        publish("1.1")
        (source / "adapter.ts").write_text("export const fixtureAdapter = 2;\n")
        publish("2.0")
        try:
            publish("1.0")
        except ValueError as error:
            assert str(error) == "release_already_published"
        else:
            raise AssertionError("publication was overwritten")

        receiver = root / "independent-clone"
        git(root, "clone", "-q", "--no-local", str(source), str(receiver))
        prepare(receiver, "1.0")
        prepare(receiver, "1.1")
        assert not (installs / "1.0/node_modules/zod").exists()
        assert (installs / "1.1/node_modules/zod").exists()
        try:
            prepare(receiver, "2.0")
        except ValueError as error:
            assert str(error) == "all_retained_releases_in_use"
        else:
            raise AssertionError("pinned version was displaced")
        pins.remove("1.0")
        prepare(receiver, "2.0")
        assert not (installs / "1.0").exists()
        pins.remove("1.1")
        prepare(receiver, "1.0")
        assert (installs / "1.0").exists()
        assert len(last_used) == 2
        try:
            prepare(receiver, "1.1", budget=1)
        except ValueError as error:
            assert str(error) == "retained_releases_over_budget"
        else:
            raise AssertionError("oversized release was activated")
        assert {entry.name for entry in installs.iterdir()} == {"1.0", "2.0"}
        assert size(cache) + size(installs) <= LIMIT

        git(receiver, "tag", "-f", tag("1.0"), releases["2.0"]["commit"])
        try:
            verified(receiver, "1.0")
        except ValueError as error:
            assert str(error) == "release_ref_changed"
        else:
            raise AssertionError("a mutable tag resolved to unexpected content")

        print(json.dumps({
            "publishedVersions": list(releases), "publishedFingerprints": releases,
            "events": events, "cacheBudgetBytes": LIMIT,
            "estimatedRetainedLogicalBytes": size(cache) + size(installs),
            "concurrentOldAndNewIsolated": True, "activeVersionsNotEvicted": True,
            "evictedVersionRestoredFromLockedTag": True,
            "overBudgetAdmissionLeavesPublishedInstallsIntact": True,
            "duplicatePublicationAndChangedTagRejected": True,
        }, indent=2))


if __name__ == "__main__":
    main()
