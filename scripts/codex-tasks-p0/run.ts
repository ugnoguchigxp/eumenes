import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.argv.includes("--run")) throw new Error("p0_requires_run");
const root = realpathSync(
	await mkdtemp(join(tmpdir(), "eumenes-codex-tasks-p0-")),
);
const workspace = join(root, "repository");
const output = resolve(
	"verification-reports/codex-tasks-p0",
	new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(workspace, { mode: 0o700 });
await mkdir(output, { recursive: true, mode: 0o700 });
async function git(...args: string[]) {
	const p = Bun.spawn(["git", "-C", workspace, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (await p.exited) throw new Error("fixture_git_failed");
	return (await new Response(p.stdout).text()).trim();
}
await git("init", "-b", "main");
await git("config", "user.name", "P0 fixture");
await git("config", "user.email", "fixture@example.invalid");
const marker = crypto.randomUUID();
await writeFile(
	join(workspace, "AGENTS.md"),
	`# P0 fixture instructions\nReturn marker ${marker} in every final report. Read the project files and make only the requested change. Do not start subagents or interact with other chats.\n`,
);
await writeFile(
	join(workspace, "sum.js"),
	"export const sum = (a,b) => a-b;\n",
);
await writeFile(
	join(workspace, "sum.test.js"),
	'import {sum} from "./sum.js"; if(sum(2,3)!==5) throw new Error("sum failed");\n',
);
await mkdir(join(workspace, "private"));
await writeFile(
	join(workspace, "private", "canary.txt"),
	"fixture-private-only\n",
);
await git("add", "AGENTS.md", "sum.js", "sum.test.js");
await git("commit", "-m", "fixture baseline");
const baselineHead = await git("rev-parse", "HEAD");
await writeFile(
	join(output, "fixture.json"),
	JSON.stringify(
		{
			root,
			workspace,
			marker,
			baselineHead,
			sdkVersion: "0.160.0",
			cliVersion: (
				await new Response(
					Bun.spawn(["codex", "--version"], { stdout: "pipe" }).stdout,
				).text()
			).trim(),
			bunVersion: Bun.version,
		},
		null,
		2,
	),
	{ mode: 0o600 },
);
const step = join(root, "work");
await mkdir(step);
await writeFile(
	join(step, "input.txt"),
	"Fix sum.js so it adds two numbers. Run node sum.test.js and report the actual result. Read the repository's instructions. Do not commit or push. Return the final output schema.",
);
const p = Bun.spawn(
	[
		process.execPath,
		fileURLToPath(new URL("./turn.ts", import.meta.url)),
		step,
		workspace,
		"work",
	],
	{ stdout: "inherit", stderr: "pipe" },
);
const exitCode = await p.exited;
// Preserve only the fixture report. Stderr can contain transport/provider output, so do not copy it.
const result = JSON.parse(await readFile(join(step, "result.json"), "utf8"));
const test = Bun.spawn(["node", "sum.test.js"], {
	cwd: workspace,
	stdout: "pipe",
	stderr: "pipe",
});
const checks = {
	projectInstructions:
		JSON.parse(result.finalResponse || "{}").marker === marker,
	testPassed: (await test.exited) === 0,
	headUnchanged: (await git("rev-parse", "HEAD")) === baselineHead,
	streamCompleted: result.events.some(
		(e: { type: string }) => e.type === "turn.completed",
	),
};
await writeFile(
	join(output, "work.json"),
	JSON.stringify(
		{
			...result,
			exitCode,
			checks,
			process: JSON.parse(await readFile(join(step, "process.json"), "utf8")),
		},
		null,
		2,
	),
	{ mode: 0o600 },
);
console.log(JSON.stringify({ output, exitCode, checks }));
if (exitCode || Object.values(checks).some((v) => !v)) process.exitCode = 1;
