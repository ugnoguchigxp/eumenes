import { resolve } from "node:path";
import {
	groupTests,
	parseSelection,
	selectionPaths,
	sourceFiles,
	testCommand,
	testPattern,
	type TestRunner,
} from "./verification-selection";

const root = resolve(import.meta.dir, "..");
try {
	const { selected, sub } = parseSelection(process.argv.slice(2), true);
	const tests = selectionPaths(selected, sub)
		.flatMap((path) => sourceFiles(root, path))
		.filter((path) => testPattern.test(path));
	if (!tests.length) {
		console.error(
			`No tests selected for ${selected.join(",")}${sub ? `/${sub}` : ""}`,
		);
		process.exit(3);
	}
	const groups = groupTests(tests);
	for (const runner of Object.keys(groups) as TestRunner[]) {
		if (!groups[runner].length) continue;
		const child = Bun.spawn(testCommand(runner, groups[runner]), {
			cwd: root,
			stdout: "inherit",
			stderr: "inherit",
		});
		const code = await child.exited;
		if (code !== 0) process.exit(code);
	}
} catch (error) {
	console.error(String(error));
	process.exitCode = 2;
}
