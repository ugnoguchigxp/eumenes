import { copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { prepare } from "../api/domains/prototype/runtime/prepare";
import { releaseFiles } from "../api/domains/prototype/runtime/release";
import { isInside } from "../api/domains/prototype/runtime/project";

const core = realpathSync(resolve(import.meta.dir, ".."));
const seed = join(core, "api/domains/prototype/runtime");
const sourceFiles: Record<string, string> = {
	"package.json": "dependencies.json",
	"bun.lock": "lock-source.jsonc",
};
const [command, path] = process.argv.slice(2);
try {
	if (command === "export" && path) {
		const given = resolve(path);
		const target = join(realpathSync(dirname(given)), basename(given));
		if (isInside(core, target))
			throw new Error("prototype_runtime_outside_core_required");
		mkdirSync(target);
		for (const file of releaseFiles)
			copyFileSync(join(seed, sourceFiles[file] ?? file), join(target, file));
	} else prepare(process.argv.slice(2), core);
} catch (error) {
	console.error((error as Error).message);
	process.exitCode = 1;
}
