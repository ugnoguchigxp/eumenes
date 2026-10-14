import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [record] = process.argv.slice(2);
if (!record) throw new Error("probe_arguments_missing");
const output = resolve(record);
const fixture = JSON.parse(
	await readFile(join(output, "fixture.json"), "utf8"),
);
const name = `orphan-${crypto.randomUUID()}`;
await writeFile(
	join(fixture.workspace, `${name}.py`),
	`import subprocess,pathlib,json\nchild=subprocess.Popen(['/bin/sleep','120'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)\npathlib.Path('${name}.json').write_text(json.dumps({'pid':child.pid}))\nprint('isolated orphan fixture started')\n`,
);
const step = join(fixture.root, name);
await mkdir(step);
await writeFile(
	join(step, "input.txt"),
	`Run python3 ${name}.py exactly once. This is an authorized isolated launcher acceptance probe: it starts one 120-second fixture child in a separate session and exits immediately. Do not wait for it or kill it yourself; the launcher under test is responsible for ending it when this turn completes. Do not change the script or start other background work. Report the actual result and project marker.`,
);
const p = Bun.spawn(
	[
		process.execPath,
		fileURLToPath(new URL("./turn.ts", import.meta.url)),
		step,
		fixture.workspace,
		"work",
	],
	{ stdout: "inherit", stderr: "pipe" },
);
const exitCode = await p.exited;
const report = JSON.parse(await readFile(join(step, "result.json"), "utf8"));
const processReceipt = JSON.parse(
	await readFile(join(step, "process.json"), "utf8"),
);
let child: { pid: number } | undefined;
try {
	child = JSON.parse(
		await readFile(join(fixture.workspace, `${name}.json`), "utf8"),
	);
} catch {}
let identity: string | null = null;
if (child) {
	const ps = Bun.spawn(["ps", "-p", String(child.pid), "-o", "lstart=,comm="], {
		stdout: "pipe",
		stderr: "pipe",
	});
	identity = (await new Response(ps.stdout).text()).trim() || null;
	await ps.exited;
}
const checks = {
	started: !!child,
	streamCompleted: report.events.some(
		(e: { type: string }) => e.type === "turn.completed",
	),
	childStopped: !!child && !identity,
	falseConfirmation: !!identity && processReceipt.stopConfirmed,
};
await writeFile(
	join(output, "orphan-live.json"),
	JSON.stringify(
		{
			exitCode,
			checks,
			child,
			identity,
			processReceipt,
			sourceStable: report.sourceStable,
		},
		null,
		2,
	),
	{ mode: 0o600 },
);
console.log(JSON.stringify({ exitCode, checks, child, identity }));
// The only process cleaned up is this probe's recorded /bin/sleep child.
if (child && identity?.endsWith("/bin/sleep")) {
	const verify = Bun.spawn(
		["ps", "-p", String(child.pid), "-o", "lstart=,comm="],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const current = (await new Response(verify.stdout).text()).trim();
	await verify.exited;
	if (current === identity) {
		try {
			process.kill(child.pid, "SIGKILL");
		} catch {}
	}
}
if (
	exitCode ||
	!checks.started ||
	!checks.childStopped ||
	checks.falseConfirmation
)
	process.exitCode = 1;
