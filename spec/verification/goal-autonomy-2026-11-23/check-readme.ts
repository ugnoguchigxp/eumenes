import { spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const fixture = join(import.meta.dir, "workspace");
const expected = { count: 3, total: 12 };

function workspaceFile(workspace: string, name: string) {
	const path = join(workspace, name);
	return lstatSync(path, { throwIfNoEntry: false })?.isFile()
		? readFileSync(path)
		: null;
}

/** Replay the one documented invocation in a fresh directory with the original sample. */
export function checkReadme(workspace: string) {
	const program = readFileSync(join(fixture, "sample.mjs"));
	if (!workspaceFile(workspace, "sample.mjs")?.equals(program))
		return { passed: false, reason: "sample_changed" } as const;

	const readme = workspaceFile(workspace, "README.md")?.toString("utf8") ?? "";
	const blocks = Array.from(
		readme
			.replaceAll("\r\n", "\n")
			.matchAll(/^```(?:sh|bash|shell)[ \t]*\n([\s\S]*?)^```[ \t]*$/gm),
	);
	const command = blocks.length === 1 ? blocks[0]?.[1]?.trim() : undefined;
	const args = command?.match(
		/^bun[ \t]+sample\.mjs[ \t]+(--[a-z-]+)[ \t]+([a-z]+)$/,
	);
	if (!args)
		return { passed: false, reason: "example_missing_or_ambiguous" } as const;

	const scratch = mkdtempSync(join(tmpdir(), "eumenes-readme-check-"));
	try {
		writeFileSync(join(scratch, "sample.mjs"), program);
		const run = spawnSync(
			process.execPath,
			["sample.mjs", args[1]!, args[2]!],
			{
				cwd: scratch,
				encoding: "utf8",
				timeout: 5_000,
			},
		);
		if (run.error) throw run.error;
		const evidence = {
			command,
			exitCode: run.status,
			stdout: run.stdout.trim(),
			stderr: run.stderr.trim(),
		};
		if (run.status !== 0)
			return { passed: false, reason: "command_failed", ...evidence } as const;
		let actual: unknown;
		try {
			actual = JSON.parse(evidence.stdout);
		} catch {
			actual = null;
		}
		const passed = isDeepStrictEqual(actual, expected);
		return {
			passed,
			reason: passed ? "verified" : "unexpected_output",
			...evidence,
		};
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const result = checkReadme(process.argv[2] ?? fixture);
	console.log(JSON.stringify(result));
	if (!result.passed) process.exitCode = 1;
}
