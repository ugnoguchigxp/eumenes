#!/usr/bin/env python3
"""Run the P0 builder probe with disposable inputs and an independently installed shared tree."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
CORE = HERE.parents[2]
SOURCE = """
import * as React from "react";
import { Scene } from "three";
import { World } from "cannon-es";
const scene: Scene = new Scene();
const world: World = new World();
document.body.textContent = String(React.createElement("p", null, scene.type ?? world.time).type);
"""
SECOND_SOURCE = SOURCE.replace('"p", null', '"section", null')


def sandbox_profile(bun, cwd, reads, output):
    # The literal root directory is needed by dyld's cache lookup. It does not
    # grant reads of descendants. System runtime files are read-only.
    quoted = json.dumps
    literals = " ".join(f"(literal {quoted(str(path))})" for path in ("/", cwd, bun))
    subpaths = " ".join(f"(subpath {quoted(str(path))})" for path in (
        "/System", "/usr/lib", "/private/preboot", *reads,
    ))
    return " ".join((
        "(version 1)", "(allow default)",
        "(deny file-read-data)", f"(allow file-read-data {literals} {subpaths})",
        "(deny file-write*)", f"(allow file-write* (subpath {quoted(str(output))}))",
        "(deny network*)", "(deny process-exec)",
        f"(allow process-exec (literal {quoted(bun)}))",
    ))


def fixture_process(bun, env, work, controls, stage, shared, output, compiler, forbidden, mode,
                    *, registered=False):
    profile = sandbox_profile(bun, work, (controls, stage, shared, output, compiler), output)
    worker = [
        "--no-env-file", "--no-install", "--no-macros",
        f"--config={controls / 'bunfig.toml'}", str(controls / "builder-probe.ts"),
        str(controls), str(stage), str(shared), str(output), str(compiler), str(forbidden), mode,
    ]
    argv = ["/usr/bin/sandbox-exec", "-p", profile, bun, *worker]
    cwd = work
    if registered:
        cwd = controls
        argv = [bun, "--no-env-file", "--no-install", f"--config={controls / 'bunfig.toml'}",
                str(HERE / "registered-check-probe.ts"),
                str(work), bun, profile, *worker]
    result = subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True, timeout=30)
    try:
        evidence = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{mode}: exit {result.returncode}\n{result.stderr}") from error
    return result.returncode, evidence


def main():
    bun = str(Path(shutil.which("bun")).resolve())
    compiler_source = next(
        (CORE / "node_modules" / ".bun").glob("typescript@5.9.3/node_modules/typescript/lib"),
    ).resolve()
    reference = json.loads((HERE / "disk-baseline.json").read_text())
    with tempfile.TemporaryDirectory(prefix="works-builder-") as folder:
        root = Path(folder).resolve()
        shared, work, controls, stage, output = [root / key for key in (
            "shared", "work", "controls", "stage", "output",
        )]
        for directory in (shared, work, controls, stage, output):
            directory.mkdir()
        forbidden = root / "outside-fixture.txt"
        forbidden.write_text("synthetic value outside the allowed snapshot")
        env = {"PATH": "/usr/bin:/bin", "HOME": str(controls), "TMPDIR": str(output)}
        compiler = root / "compiler"
        shutil.copytree(compiler_source, compiler)
        shutil.copy2(HERE / "builder-probe.ts", controls / "builder-probe.ts")

        def install_shared(target, added=None):
            target.mkdir(exist_ok=True)
            manifest = {"name": "works-disk-baseline", "private": True, **reference["dependencies"]}
            if added:
                manifest["dependencies"] = {**manifest["dependencies"], **added}
            (target / "package.json").write_text(json.dumps(manifest))
            (target / "bun.lock").write_text(reference["bun_lock"])
            argv = [bun, "install", "--ignore-scripts", f"--cache-dir={root / 'cache'}"]
            if not added:
                argv.append("--frozen-lockfile")
            subprocess.run(argv, cwd=target, env=env, check=True, capture_output=True, timeout=60)

        install_shared(shared)
        core = work.parent

        def core_web(version):
            (core / "package.json").write_text(json.dumps({"dependencies": {"react": version}}))
            (core / "bun.lock").write_text(json.dumps({"react": version}))
            module = core / "node_modules" / "react"
            module.mkdir(parents=True, exist_ok=True)
            (module / "index.js").write_text(f'export const fixture = "{version}";')

        core_web("19.2.6")

        (controls / "bunfig.toml").write_text("")
        (controls / "build-tsconfig.json").write_text("{}")
        exports = {
            "react": "node_modules/react/index.js",
            "three": "node_modules/three/build/three.module.js",
            "cannon-es": "node_modules/cannon-es/dist/cannon-es.js",
        }
        export_file = controls / "exports.json"
        export_file.write_text(json.dumps(exports))
        def write_type_config(dependencies):
            (controls / "typecheck.json").write_text(json.dumps({
                "compilerOptions": {
                    "strict": True, "skipLibCheck": True, "noEmit": True, "target": "ES2022",
                    "module": "ESNext", "moduleResolution": "Bundler", "types": [],
                    "paths": {name: [str(dependencies / path)] for name, path in {
                        "react": "node_modules/@types/react/index.d.ts",
                        "three": "node_modules/@types/three/index.d.ts",
                        "three/examples/jsm/controls/OrbitControls.js":
                            "node_modules/@types/three/examples/jsm/controls/OrbitControls.d.ts",
                        "cannon-es": "node_modules/cannon-es/dist/cannon-es.d.ts",
                    }.items()},
                },
            }))

        write_type_config(shared)
        editor_config = work / ".eumenes"
        editor_config.mkdir()
        shutil.copy2(controls / "typecheck.json", editor_config / "tsconfig.generated.json")
        (work / ".gitignore").write_text(".eumenes/\n")
        (work / "tsconfig.json").write_text(json.dumps({
            "extends": "./.eumenes/tsconfig.generated.json", "include": ["src"],
        }))
        (work / "src").mkdir()
        (work / "src" / "main.tsx").write_text(SOURCE + """
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
type Controls = OrbitControls;
""")
        editor = subprocess.run(
            [bun, "--no-env-file", "--no-install", f"--config={controls / 'bunfig.toml'}",
             str(HERE / "editor-types-probe.ts"), str(work), str(compiler), str(shared)],
            cwd=controls, env=env, check=True, text=True, capture_output=True, timeout=30,
        )
        editor_types = json.loads(editor.stdout)
        (work / ".env").write_text("WORKS_FIXTURE_SETTINGS=should-not-load\n")
        (work / "bunfig.toml").write_text('preload = ["./preload.ts"]\n')
        sentinel = output / "preload-ran"
        (work / "preload.ts").write_text(f"await Bun.write({json.dumps(str(sentinel))}, 'ran');")
        (stage / "tsconfig.json").write_text(json.dumps({
            "compilerOptions": {"paths": {"react": [str(forbidden)]}},
        }))

        def probe(mode, dependencies=shared, *, registered=False):
            write_type_config(dependencies)
            return fixture_process(
                bun, env, work, controls, stage, dependencies, output, compiler, forbidden, mode,
                registered=registered,
            )

        def bundle_hash():
            return hashlib.sha256((output / "main.js").read_bytes()).hexdigest()

        def fixture_builds(dependencies):
            hashes = []
            for source in (SOURCE, SECOND_SOURCE):
                entry.write_text(source)
                result, report = probe("build", dependencies)
                assert result == 0 and report["built"], report
                hashes.append(bundle_hash())
            return hashes

        boundary_exit, boundary = probe("boundary")
        assert boundary_exit == 0 and all(boundary.values()), boundary
        entry = stage / "main.tsx"
        entry.write_text(SOURCE)
        good_exit, good = probe("typecheck")
        assert good_exit == 0 and good == {"diagnostics": []}, good
        built_exit, built = probe("build")
        assert built_exit == 0 and built["built"] and built["outputs"] > 0, built
        initial_hashes = fixture_builds(shared)
        assert initial_hashes[0] != initial_hashes[1]
        relocated = root / "relocated-fixed-environment"
        install_shared(relocated)
        assert fixture_builds(relocated) == initial_hashes
        newer = root / "next-fixed-environment"
        install_shared(newer, added={"zod": "4.4.3"})
        export_file.write_text(json.dumps({**exports, "zod": "node_modules/zod/index.js"}))
        entry.write_text('import { z } from "zod"; document.body.textContent = z.string().parse("C");')
        next_exit, next_build = probe("preview", newer)
        assert next_exit == 0 and next_build["built"], next_build
        export_file.write_text(json.dumps(exports))
        assert fixture_builds(shared) == initial_hashes
        core_web("19.2.7")
        assert fixture_builds(shared) == initial_hashes
        entry.write_text(SOURCE)
        tracked = work / "src" / "main.tsx"
        tracked.write_text(SOURCE)
        registered_checks = {}
        for mode in ("boundary", "typecheck", "build"):
            wrapper_exit, report = probe(mode, registered=True)
            assert wrapper_exit == report["exitCode"] == 0 and report["passed"], report
            if mode == "boundary":
                assert all(report["worker"].values()), report
            registered_checks[mode] = report

        entry.write_text(SOURCE + '\nconst invalid: number = "expected type error";\n')
        invalid_exit, invalid = probe("typecheck")
        assert invalid_exit == 3 and {entry["code"] for entry in invalid["diagnostics"]} == {2322}, invalid
        preview_exit, preview = probe("preview")
        assert preview_exit == 0 and preview["built"], preview
        tracked.write_text(entry.read_text())
        wrapper_exit, failed_check = probe("typecheck", registered=True)
        assert wrapper_exit == 0 and failed_check["exitCode"] == 3 and not failed_check["passed"], failed_check
        registered_checks["typed_error"] = failed_check
        wrapper_exit, failed_build = probe("build", registered=True)
        assert wrapper_exit == 0 and failed_build["exitCode"] == 3 and not failed_build["passed"], failed_build
        registered_checks["build_with_typed_error"] = failed_build
        macro_sentinel = output / "macro-ran"
        (stage / "macro.ts").write_text(
            f"export const mark = () => Bun.write({json.dumps(str(macro_sentinel))}, 'ran');",
        )
        entry.write_text('import { mark } from "./macro.ts" with { type: "macro" };\nmark();\n')
        macro_exit, macro = probe("build")
        assert macro_exit == 2 and macro == {"error": "macro_import_forbidden"}, macro
        assert not macro_sentinel.exists() and not sentinel.exists()
        assert not (work / "node_modules").exists() and not (stage / "node_modules").exists()

        print(json.dumps({
            "boundary": boundary,
            "normal_build": built,
            "restored_lock_build_matches": True,
            "other_fixed_environment_accepts_new_dependency": True,
            "original_build_unchanged_after_adding_dependency": True,
            "both_builds_unchanged_after_fixture_core_dependency_update": True,
            "normal_typecheck": good,
            "editor_language_service": editor_types,
            "registered_checks": registered_checks,
            "type_error": invalid,
            "preview_build_from_typed_error_input": preview,
            "macro_rejection": macro,
            "macro_marker_created": False,
            "project_preload_marker_created": False,
            "project_node_modules_created": False,
        }, indent=2))


if __name__ == "__main__":
    main()
