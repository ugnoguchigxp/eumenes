import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runBuild } from "./build";
import { collect } from "./project";

async function main() {
	const [mode, version, project] = process.argv.slice(2);
	if (
		process.env.EUMENES_WORKS_CHECK !== "1" ||
		(mode !== "typecheck" && mode !== "build")
	)
		throw new Error("prototype_registered_check_required");
	const runtime = realpathSync(import.meta.dir);
	const snapshot = collect(realpathSync(project!));
	if (snapshot.project.environment !== version)
		throw new Error("prototype_environment_changed");
	const scratch = mkdtempSync(join(process.env.TMPDIR!, "works-check-"));
	try {
		const report = await runBuild({
			runtime,
			snapshot,
			work: scratch,
			target: join(scratch, "output"),
			mode: "host",
			typecheck: true,
			build: mode === "build",
			strict: true,
			insideCheckSandbox: true,
		});
		if (report.diagnostics.length || (mode === "build" && !report.built)) {
			for (const text of report.diagnostics) console.error(text);
			process.exitCode = 1;
		} else console.log("Works " + mode + " passed");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
