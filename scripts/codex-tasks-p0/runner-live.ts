import { existsSync, mkdtempSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, digest } from "../../packages/coding-runner/src/storage";
import { sdkRunnerClient } from "../../packages/coding-runner/src/sdk-client";
import {
	sdkTerminal,
	type SdkSpec,
} from "../../packages/coding-runner/src/sdk-contracts";

if (!process.argv.includes("--run")) throw new Error("p0_requires_run");
const root = realpathSync(mkdtempSync(join(tmpdir(), "ecs-")));
const workspace = join(root, "repo");
mkdirSync(workspace, { mode: 0o700 });
const spool = join(root, "spool");
const socket = join(spool, "sdk.sock");
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
const configPath = join(root, "config.json");
atomicWrite(configPath, {
	root: spool,
	workspaces: { fixture: workspace },
	protectedPaths: [resolve("data"), resolve(".env")],
});
async function git(...args: string[]) {
	const p = Bun.spawn(["git", "-C", workspace, ...args], {
		stdout: "pipe",
		stderr: "ignore",
	});
	if (await p.exited) throw new Error("fixture_git_failed");
	return (await new Response(p.stdout).text()).trim();
}
await git("init", "-b", "main");
await git("config", "user.name", "P0 runner fixture");
await git("config", "user.email", "fixture@example.invalid");
atomicWrite(
	join(workspace, "AGENTS.md"),
	"Read project instructions. Work only in this fixture. No subagents, other chats, commit, or push. Include runner-marker in the final summary.\n",
);
atomicWrite(join(workspace, "value.js"), "export const value = 1;\n");
await git("add", "AGENTS.md", "value.js");
await git("commit", "-m", "fixture baseline");
const baseline = await git("rev-parse", "HEAD");
const cliPath = fileURLToPath(
	new URL("../../packages/coding-runner/src/sdk-cli.ts", import.meta.url),
);
let runner = Bun.spawn([process.execPath, cliPath, "serve", configPath], {
	stdout: "ignore",
	stderr: "ignore",
});
let consumer: ReturnType<typeof Bun.spawn> | undefined;
const results: unknown[] = [];
async function ready() {
	for (let n = 0; n < 100 && !existsSync(socket); n++) await Bun.sleep(50);
	if (!existsSync(socket)) throw new Error("fixture_runner_not_ready");
}
try {
	await ready();
	const client = sdkRunnerClient(socket);
	let previous: { id: string; threadId: string } | undefined;
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		const id = `backend-${signal.toLowerCase()}`;
		const spec: SdkSpec = {
			protocol: "eumenes-codex-sdk/1",
			executionId: id,
			ownerId: "fixture-card",
			workspaceId: "fixture",
			deadline: new Date(Date.now() + 180_000).toISOString(),
			prompt: `Read AGENTS.md. Change value.js so value is ${signal === "SIGTERM" ? 2 : 3}. Run node to verify that value. Run a foreground sleep for 8 seconds before returning. Report actual verification using the output schema. Do not commit or push.`,
			...(previous
				? { continuationOf: previous.id, threadId: previous.threadId }
				: {}),
		};
		const input = join(root, `${id}.json`);
		atomicWrite(input, spec);
		const acceptanceClient = Bun.spawn(
			[
				process.execPath,
				fileURLToPath(new URL("./runner-client.ts", import.meta.url)),
				socket,
				input,
			],
			{ stdout: "pipe", stderr: "ignore" },
		);
		consumer = acceptanceClient;
		const reader = acceptanceClient.stdout.getReader();
		const accepted = await reader.read();
		if (!accepted.value) throw new Error("fixture_acceptance_missing");
		const first = await client.inspect(id);
		consumer.kill(signal);
		await consumer.exited;
		consumer = undefined;
		let final = first;
		for (let n = 0; n < 800 && !sdkTerminal(final.state); n++) {
			await Bun.sleep(250);
			final = await sdkRunnerClient(socket).inspect(id);
		}
		const replay = await sdkRunnerClient(socket).start(spec);
		const events = await client.events(id);
		const checks = {
			clientStopped: true,
			state: final.state,
			sameEpoch: first.epoch === final.epoch && replay.epoch === first.epoch,
			sameThread: !previous || final.threadId === previous.threadId,
			transcriptNotCopied: !existsSync(join(spool, "sessions")),
			handoffHeld: final.workspaceHeld && !final.workspaceReleaseConfirmed,
			marker: final.report?.summary.includes("runner-marker"),
			headUnchanged: (await git("rev-parse", "HEAD")) === baseline,
			finishedEvents:
				events.events.filter((e) => e.type === "turn.completed").length === 1,
		};
		results.push({ signal, executionId: id, receipt: final, checks });
		console.log(JSON.stringify({ signal, checks }));
		if (
			final.state !== "succeeded" ||
			Object.values(checks).some((v) => v === false) ||
			!final.threadId
		)
			throw new Error("fixture_recovery_failed");
		previous = { id, threadId: final.threadId };
	}
	// Restore a terminal durable result after the runner itself restarts, with no SDK call.
	runner.kill("SIGTERM");
	await runner.exited;
	runner = Bun.spawn([process.execPath, cliPath, "serve", configPath], {
		stdout: "ignore",
		stderr: "ignore",
	});
	await ready();
	const recovered = await sdkRunnerClient(socket).recover(previous!.id);
	results.push({
		runnerRestart: {
			state: recovered.state,
			threadId: recovered.threadId,
			seq: recovered.seq,
		},
	});
} finally {
	consumer?.kill("SIGKILL");
	runner.kill("SIGTERM");
	await runner.exited;
	const output = resolve(
		"verification-reports/codex-tasks-p0",
		new Date().toISOString().replaceAll(":", "-"),
	);
	mkdirSync(output, { recursive: true, mode: 0o700 });
	atomicWrite(join(output, "runner-recovery.json"), {
		root,
		workspace,
		baseline,
		sourceStable:
			JSON.stringify(initialSources) === JSON.stringify(await fingerprints()),
		results,
	});
	console.log(
		JSON.stringify({
			output,
			sourceStable:
				JSON.stringify(initialSources) === JSON.stringify(await fingerprints()),
		}),
	);
}
