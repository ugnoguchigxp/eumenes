#!/usr/bin/env python3
"""Check the P0 Git identity contract using only disposable repositories."""

from dataclasses import dataclass
import json
from pathlib import Path
import subprocess
import tempfile


@dataclass(frozen=True)
class GitIdentity:
    root: Path
    common: Path


def git(cwd, *args, check=True):
    return subprocess.run(
        ["git", "-C", str(cwd), "-c", "user.name=Works Fixture",
         "-c", "user.email=works.invalid@example.invalid", "-c", "core.hooksPath=/dev/null",
         *args],
        capture_output=True, text=True, check=check, timeout=10,
    )


def repository(path):
    path.mkdir()
    git(path, "init", "--quiet", "--initial-branch=main")
    git(path, "commit", "--quiet", "--allow-empty", "-m", f"fixture {path.name}")
    return path


def identify(folder):
    requested = folder.resolve(strict=True)
    root, common = git(
        requested, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir",
    ).stdout.splitlines()
    return requested, GitIdentity(Path(root).resolve(), Path(common).resolve())


def can_register(folder, known):
    requested, identity = identify(folder)
    return requested == identity.root and all(
        identity.common != existing.common
        and not identity.root.is_relative_to(existing.root)
        and not existing.root.is_relative_to(identity.root)
        for existing in known
    )


def main():
    with tempfile.TemporaryDirectory(prefix="works-git-") as folder:
        root = Path(folder).resolve()
        core = repository(root / "core")
        first = repository(root / "work-a")
        second = repository(root / "work-b")
        nested = first / "nested"
        nested.mkdir()
        alias = root / "alias-a"
        alias.symlink_to(first, target_is_directory=True)
        core_link = root / "core-linked"
        first_link = root / "a-linked"
        git(core, "worktree", "add", "--quiet", "--detach", str(core_link))
        git(first, "worktree", "add", "--quiet", "--detach", str(first_link))
        core_id, first_id = map(lambda path: identify(path)[1], (core, first))
        known = [core_id, first_id]

        head = git(first, "rev-parse", "HEAD").stdout.strip()
        moved = root / "moved"
        git(root, "clone", "--quiet", "--no-local", str(first), str(moved))

        results = {
            "independent_repositories_accepted": can_register(first, [core_id]) and can_register(second, known),
            "core_linked_worktree_rejected": not can_register(core_link, known),
            "work_linked_worktree_rejected": not can_register(first_link, known),
            "registered_alias_rejected": not can_register(alias, known),
            "path_inside_repository_rejected": not can_register(nested, known),
            "relocated_clone_contains_registration_anchor":
                git(moved, "cat-file", "-e", f"{head}^{{commit}}", check=False).returncode == 0,
            "unrelated_repository_lacks_anchor":
                git(second, "cat-file", "-e", f"{head}^{{commit}}", check=False).returncode != 0,
        }
        assert all(results.values()), results
        print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
