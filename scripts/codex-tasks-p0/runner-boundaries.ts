import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	atomicWrite,
	digest,
	readPrivate,
} from "../../packages/coding-runner/src/storage";
import { sdkRunnerClient } from "../../packages/coding-runner/src/sdk-client";
import {
	sdkTerminal,
	type SdkConfig,
	type SdkReceipt,
	type SdkSpec,
} from "../../packages/coding-runner/src/sdk-contracts";

const recordPath = process.argv.find((arg) =>
	arg.endsWith("runner-recovery.json"),
);
if (!process.argv.includes("--run") || !recordPath)
	throw new Error("p0_requires_run_record");
const record = JSON.parse(readPrivate(resolve(recordPath))) as { root: string };
const configPath = join(record.root, "config.json");
const config = JSON.parse(readPrivate(configPath)) as SdkConfig;
const sources = [
	"sdk-contracts",
	"sdk-store",
	"sdk-service",
	"sdk-engine",
	"sdk-transport",
	"sdk-process-tree",
	"sdk-server",
	"sdk-client",
	"sdk-cli",
].map(
	(name) =>
		new URL(`../../packages/coding-runner/src/${name}.ts`, import.meta.url),
);
async function fingerprints() {
	return Promise.all(
		sources.map(async (file) => digest(await Bun.file(file).bytes())),
	);
}
const initialSources = await fingerprints();
for (const name of ["abort", "crash", "orphan"]) {
	const workspace = join(record.root, name);
	mkdirSync(workspace, { mode: 0o700 });
	config.workspaces[name] = workspace;
	atomicWrite(
		join(workspace, "AGENTS.md"),
		"Fixture only. No subagents or other chats. No commit or push. Use the exact test instructions; report actual results.\n",
	);
	const git = Bun.spawn(["git", "init", "-b", "main", workspace], {
		stdout: "ignore",
		stderr: "ignore",
	});
	if (await git.exited) throw new Error("fixture_git_failed");
}
atomicWrite(configPath, config);
const cli = fileURLToPath(
	new URL("../../packages/coding-runner/src/sdk-cli.ts", import.meta.url),
);
let runner = Bun.spawn([process.execPath, cli, "serve", configPath], {
	stdout: "ignore",
	stderr: "ignore",
});
const client = sdkRunnerClient(join(config.root, "sdk.sock"));
const results: unknown[] = [];
async function ready() {
	for (let n = 0; n < 100; n++) {
		try {
			await client.inspect("backend-sigkill");
			return;
		} catch {
			await Bun.sleep(50);
		}
	}
	throw new Error("fixture_runner_not_ready");
}
function spec(name: string, prompt: string): SdkSpec {
	return {
		protocol: "eumenes-codex-sdk/1",
		executionId: `boundary-${name}`,
		ownerId: `card-${name}`,
		workspaceId: name,
		prompt,
		deadline: new Date(Date.now() + 180_000).toISOString(),
	};
}
async function waitForFile(name: string, file: string) {
	for (let n = 0; n < 600; n++) {
		if (existsSync(join(config.workspaces[name]!, file))) return;
		if (sdkTerminal((await client.inspect(`boundary-${name}`)).state))
			throw new Error("fixture_command_not_started");
		await Bun.sleep(250);
	}
	throw new Error("fixture_command_timeout");
}
async function settled(id: string): Promise<SdkReceipt> {
	for (let n = 0; n < 1000; n++) {
		const receipt = await client.inspect(id);
		if (sdkTerminal(receipt.state)) return receipt;
		await Bun.sleep(200);
	}
	throw new Error("fixture_settlement_timeout");
}
try {
	await ready();
	const prompt =
		"Read AGENTS.md. Run one foreground command: python3 -c \"from pathlib import Path; import time; Path('ready.txt').write_text('started'); time.sleep(90)\". Do not background it. Then report the actual result using the output schema.";
	const abort = spec("abort", prompt);
	await client.start(abort);
	await waitForFile("abort", "ready.txt");
	await client.stop(abort.executionId, "manual-stop");
	const stopped = await settled(abort.executionId);
	results.push({
		name: "manual-stop",
		state: stopped.state,
		managedExecutionStopped: stopped.managedExecutionStopped,
		workspaceReleaseConfirmed: stopped.workspaceReleaseConfirmed,
		workspaceHeld: stopped.workspaceHeld,
	});
	console.log(JSON.stringify(results.at(-1)));
	if (
		stopped.state !== "cancelled" ||
		!stopped.managedExecutionStopped ||
		!stopped.workspaceHeld ||
		stopped.workspaceReleaseConfirmed
	)
		throw new Error("fixture_stop_failed");
	const crash = spec("crash", prompt);
	await client.start(crash);
	await waitForFile("crash", "ready.txt");
	const before = await client.inspect(crash.executionId);
	runner.kill("SIGKILL");
	await runner.exited;
	runner = Bun.spawn([process.execPath, cli, "serve", configPath], {
		stdout: "ignore",
		stderr: "ignore",
	});
	await ready();
	const recovered = await client.recover(crash.executionId);
	const replayed = await client.start(crash);
	results.push({
		name: "runner-crash",
		state: recovered.state,
		sameEpoch: before.epoch === recovered.epoch,
		noReplay: replayed.state === "unknown" && replayed.seq === before.seq,
		workspaceHeld: recovered.workspaceHeld,
		managedExecutionStopped: recovered.managedExecutionStopped,
	});
	console.log(JSON.stringify(results.at(-1)));
	if (
		recovered.state !== "unknown" ||
		before.epoch !== recovered.epoch ||
		replayed.seq !== before.seq ||
		!recovered.workspaceHeld ||
		recovered.managedExecutionStopped
	)
		throw new Error("fixture_crash_recovery_failed");
	const orphan = spec(
		"orphan",
		"Read AGENTS.md. This is an isolated process-ownership test. Run python3 -c \"import subprocess,json; from pathlib import Path; p=subprocess.Popen(['/bin/sleep','180'],start_new_session=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); Path('orphan.json').write_text(json.dumps({'pid':p.pid}))\". Let that parent exit immediately. Do not stop the sleep or wait for it. Return a done report with no further commands. The host cleans this fixture process after verifying that workspace handoff remains blocked.",
	);
	await client.start(orphan);
	await waitForFile("orphan", "orphan.json");
	const final = await settled(orphan.executionId);
	const pid = Number(
		JSON.parse(
			readFileSync(join(config.workspaces.orphan!, "orphan.json"), "utf8"),
		).pid,
	);
	const identity = () => {
		const child = Bun.spawnSync(
			["ps", "-p", String(pid), "-o", "pid=,lstart=,comm="],
			{ stdout: "pipe", stderr: "ignore" },
		);
		return child.stdout.toString().trim();
	};
	const captured = identity();
	let denied = false;
	try {
		await client.release(orphan.executionId, "handoff-test");
	} catch (error) {
		denied =
			error instanceof Error && error.message === "sdk_release_unconfirmed";
	}
	results.push({
		name: "orphan-handoff",
		state: final.state,
		orphanSurvived: !!captured,
		handoffDenied: denied,
		workspaceHeld: final.workspaceHeld,
		workspaceReleaseConfirmed: final.workspaceReleaseConfirmed,
	});
	console.log(JSON.stringify(results.at(-1)));
	// Only this fixture's still-matching birth/executable identity may be signalled.
	if (captured && captured === identity()) process.kill(pid, "SIGKILL");
	if (!denied || !final.workspaceHeld || final.workspaceReleaseConfirmed)
		throw new Error("fixture_handoff_unsafe");
} finally {
	runner.kill("SIGTERM");
	await runner.exited;
	const output = resolve(
		"verification-reports/codex-tasks-p0",
		new Date().toISOString().replaceAll(":", "-"),
	);
	mkdirSync(output, { recursive: true, mode: 0o700 });
	atomicWrite(join(output, "runner-boundaries.json"), {
		root: record.root,
		sourceStable:
			JSON.stringify(initialSources) === JSON.stringify(await fingerprints()),
		results,
	});
	console.log(JSON.stringify({ output }));
}
