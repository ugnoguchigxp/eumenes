import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [record, signal] = process.argv.slice(2);
if (!record || !["SIGTERM", "SIGKILL", "ABORT"].includes(signal!))
	throw new Error("probe_arguments_missing");
const output = resolve(record);
const fixture = JSON.parse(
	await readFile(join(output, "fixture.json"), "utf8"),
);
const workspace: string = fixture.workspace;
const name = `stop-${crypto.randomUUID()}`;
await writeFile(
	join(workspace, `${name}.py`),
	`import os,pathlib,time,json\npathlib.Path('${name}.json').write_text(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'pgid':os.getpgid(0)}))\ntime.sleep(120)\n`,
);
const step = join(fixture.root, name);
await mkdir(step);
await writeFile(
	join(step, "input.txt"),
	`Run python3 ${name}.py once in the foreground. This is an isolated process-tree stop acceptance test; the host will stop it after its pid canary appears. Do not background it, edit it, spawn subagents, or run other long commands. Report the marker if it returns.`,
);
const p = Bun.spawn(
	[
		process.execPath,
		fileURLToPath(new URL("./turn.ts", import.meta.url)),
		step,
		workspace,
		"work",
	],
	{ stdout: "pipe", stderr: "pipe" },
);
let child: { pid: number; ppid: number; pgid: number } | undefined;
for (let n = 0; n < 900; n++) {
	try {
		child = JSON.parse(await readFile(join(workspace, `${name}.json`), "utf8"));
		break;
	} catch {}
	if (p.exitCode !== null) break;
	await Bun.sleep(100);
}
const processReceipt = JSON.parse(
	await readFile(join(step, "process.json"), "utf8"),
);
const before = child ? await identity(child.pid) : null;
if (signal === "ABORT") await writeFile(join(step, "abort"), "stop");
else p.kill(signal as "SIGTERM" | "SIGKILL");
await p.exited;
await Bun.sleep(2000);
const after = child ? await identity(child.pid) : null;
const launcherAfter = await identity(processReceipt.launcher);
const groupAfter = await identity(processReceipt.group);
const checks = {
	commandStarted: !!child,
	commandStopped: !!child && !after,
	launcherStopped: !launcherAfter,
	cliStopped: !groupAfter,
};
await writeFile(
	join(output, `${signal}.json`),
	JSON.stringify(
		{ child, before, after, launcherAfter, groupAfter, processReceipt, checks },
		null,
		2,
	),
	{ mode: 0o600 },
);
console.log(JSON.stringify({ signal, checks, child, after }));
// Only cleanup a proven survivor created by this test, with matching process identity.
if (child && before && after === before) {
	try {
		process.kill(child.pid, "SIGKILL");
	} catch {}
}
if (Object.values(checks).some((v) => !v)) process.exitCode = 1;

async function identity(pid: number) {
	const p = Bun.spawn(["ps", "-p", String(pid), "-o", "lstart=,comm="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const result = (await new Response(p.stdout).text()).trim();
	await p.exited;
	return result || null;
}
