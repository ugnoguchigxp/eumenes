import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { configureEditor, runBuild } from "./build";
import { collect } from "./project";
import { previewListener } from "./preview";
import { openRelease } from "./release";

async function main() {
	const [command, portArg] = process.argv.slice(2);
	if (
		!["dev", "build", "typecheck"].includes(command ?? "") ||
		(portArg && (command !== "dev" || !/^--port=\d{1,5}$/.test(portArg)))
	)
		throw new Error(
			"Usage: eumenes-prototype dev [--port=8795] | typecheck | build",
		);
	const root = realpathSync(
		process.env.EUMENES_PROTOTYPE_PROJECT ?? process.cwd(),
	);
	const snapshot = collect(root);
	const release = openRelease(
		realpathSync(process.env.EUMENES_PROTOTYPE_HOME!),
		snapshot.project.environment,
	);
	const scratch = realpathSync(
		mkdtempSync(
			join(realpathSync(process.env.EUMENES_PROTOTYPE_HOME!), "work-"),
		),
	);
	try {
		configureEditor(root, release.path, "standalone");
		const output = join(scratch, "preview");
		const result = await runBuild({
			runtime: release.path,
			snapshot,
			mode: "standalone",
			work: scratch,
			target: output,
			build: command !== "typecheck",
			typecheck: true,
			strict: command === "build",
		});
		for (const d of result.diagnostics) console.error(d);
		if (command === "typecheck") return result.diagnostics.length ? 1 : 0;
		if (!result.built) return 1;
		if (command === "build") {
			const dir = join(root, "dist");
			if (
				existsSync(dir) &&
				(!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir)
			)
				throw new Error("prototype_generated_path_invalid");
			if (existsSync(dir) && !existsSync(join(dir, ".works-output")))
				throw new Error("prototype_dist_not_managed");
			mkdirSync(dir, { recursive: true });
			// Copy to the destination filesystem before replacing dist.
			const next = mkdtempSync(join(root, ".eumenes", "dist-"));
			const previous = join(next, "previous");
			const staged = join(next, "staged");
			try {
				await Bun.write(join(output, ".works-output"), snapshot.digest + "\n");
				const { cpSync } = await import("node:fs");
				cpSync(output, staged, { recursive: true });
				renameSync(dir, previous);
				try {
					renameSync(staged, dir);
				} catch (e) {
					renameSync(previous, dir);
					throw e;
				}
			} finally {
				rmSync(next, { recursive: true, force: true });
			}
			console.log("dist/index.html");
			return 0;
		}
		const port = portArg ? Number(portArg.slice(7)) : 8795;
		const listener = previewListener(port);
		const hash = createHash("sha256").update(root).digest("hex").slice(0, 32);
		const id = hash.replace(
			/^(........)(....)(....)(....)(............)$/,
			"$1-$2-$3-$4-$5",
		);
		const pending = Promise.withResolvers<void>();
		const cleanup = () => pending.resolve();
		process.once("SIGTERM", cleanup);
		process.once("SIGINT", cleanup);
		try {
			console.log(listener.add(id, output).url);
			await pending.promise;
		} finally {
			process.removeListener("SIGTERM", cleanup);
			process.removeListener("SIGINT", cleanup);
			await listener.close();
		}
		return 0;
	} finally {
		release.close();
		rmSync(scratch, { recursive: true, force: true });
	}
}

try {
	process.exitCode = await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
