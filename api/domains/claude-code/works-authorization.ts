import { realpathSync } from "node:fs";
import { join } from "node:path";
import { claudeAuthorization } from "../coding";
import type { WorksTarget } from "./contracts";

export function worksAuthorization(target: WorksTarget, deadline: number) {
	const writablePaths = [...target.include, "README.md"].map((file) =>
		join(target.root, file),
	);
	return claudeAuthorization.parse({
		workspaceRef: `prototype:${target.id}`,
		targetRevision: `${target.generation}:${target.environment}`,
		mode: "edit",
		deadline,
		worksRuntime: target.runtime,
		readablePaths: [
			...writablePaths,
			join(target.root, "prototype.json"),
			join(target.root, "package.json"),
		],
		writablePaths,
		checks: ["typecheck", "build"].map((mode) => ({
			cwd: target.root,
			executable: realpathSync(process.execPath),
			args: [
				"--no-env-file",
				"--no-install",
				"--no-macros",
				`--config=${join(target.runtime, "bunfig.toml")}`,
				`--cwd=${target.runtime}`,
				join(target.runtime, "check.ts"),
				mode,
				target.environment,
				target.root,
			],
		})),
	});
}
