import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createKanbanSdkHost } from "../api/application/work/kanban-sdk-host";
import { createTerminals } from "../api/domains/terminals";
import { SdkService } from "../packages/coding-runner/src/sdk-service";
import { serveSdk } from "../packages/coding-runner/src/sdk-server";
import { sdkRunnerClient } from "../packages/coding-runner/src/sdk-client";
import { createSdkGitEngine } from "../packages/coding-runner/src/sdk-git-engine";
import {
	registeredSdkGitRemotes,
	executeSdkGitPhase,
} from "../packages/coding-runner/src/sdk-git-operations";
import { git } from "../packages/coding-runner/src/workspace";
import { readPrivate } from "../packages/coding-runner/src/storage";
import { sdkGitPhaseSchema } from "../packages/coding-runner/src/sdk-git-contracts";
import { configureLogging } from "../api/infrastructure/logger";
configureLogging({ file: process.env.EUMENES_LOG_FILE, level: "warn" });
const root = realpathSync(mkdtempSync(join(tmpdir(), "kanban-sdk-browser-")));
const cwd = join(root, "project");
mkdirSync(cwd);
git(cwd, ["init", "-b", "main"]);
git(cwd, ["config", "core.hooksPath", join(cwd, ".git/hooks")]);
git(cwd, ["config", "user.name", "Browser fixture"]);
git(cwd, ["config", "user.email", "fixture@example.invalid"]);
writeFileSync(join(cwd, "value.js"), "export const value=1;\n");
git(cwd, ["add", "value.js"]);
git(cwd, ["commit", "-m", "baseline"]);
const remote = join(root, "bare");
mkdirSync(remote);
git(remote, ["init", "--bare"]);
git(cwd, ["remote", "add", "origin", remote]);
git(cwd, ["push", "origin", "main"]);
const remotes = registeredSdkGitRemotes(cwd, "eumenes");
const calls: { id: string; threadId: string | undefined }[] = [];
const sdk = new SdkService(
	{
		root: join(root, "runner"),
		workspaces: { eumenes: cwd },
		protectedPaths: [],
		remotes,
	},
	createSdkGitEngine(
		async ({ spec, signal, onThread, onActivity, gitPhaseFile }) => {
			calls.push({ id: spec.executionId, threadId: spec.threadId });
			onThread(spec.threadId ?? crypto.randomUUID());
			onActivity({ type: "turn.started" });
			onActivity({
				type: "item.started",
				itemType: "command_execution",
				itemId: "fixture-command",
				status: "in_progress",
			});
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 1800);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});
			if (signal.aborted)
				return { failure: "sdk_aborted", managedExecutionStopped: true };
			onActivity({
				type: "item.completed",
				itemType: "command_execution",
				itemId: "fixture-command",
				status: "completed",
				exitCode: 0,
			});
			onActivity({ type: "turn.completed" });
			const blocked = spec.prompt.includes("[block]");
			if (gitPhaseFile)
				executeSdkGitPhase(
					sdkGitPhaseSchema.parse(JSON.parse(readPrivate(gitPhaseFile))),
					gitPhaseFile.includes("/commit/") ? "fixture approved change" : "",
				);
			else if (!blocked)
				writeFileSync(join(cwd, "value.js"), "export const value=2;\n");
			return {
				managedExecutionStopped: true,
				report: {
					outcome: blocked ? "blocked" : "done",
					summary: blocked ? "fixture needs an answer" : "fixture verified",
					blocker: blocked ? "対象の条件を指定してください" : "",
					verification: ["fixture check passed"],
					files: ["value.js"],
					unconfirmed: [],
				},
			};
		},
	),
);
const server = await serveSdk(sdk);
let sdkHost!: ReturnType<typeof createKanbanSdkHost>;
const h = await harness({
	timers: true,
	kanbanComposition: (store, settings, capabilities) =>
		(sdkHost = createKanbanSdkHost({
			store,
			settings,
			capabilities,
			dbPath: store.readSnapshot((tx) => tx.filename),
			cwd,
			runner: sdkRunnerClient(server.socket),
			hooks: {
				baseUrl: `http://127.0.0.1:${process.env.EUMENES_PORT}`,
				publish: () => {},
			},
			terminals: (options) =>
				createTerminals({
					...options,
					command: [
						"/bin/sh",
						join(import.meta.dir, "../tests/browser/fixtures/fake-claude.sh"),
					],
					sweepMs: 100,
				}),
		})),
});
const saved = h.settings.get();
const connectionId = crypto.randomUUID();
const resourceId = crypto.randomUUID();
saved.connections.push({
	id: connectionId,
	kind: "codex-sdk",
	name: "Fixture SDK",
	baseUrl: "https://example.invalid",
	enabled: true,
	epoch: 0,
	envRef: null,
});
saved.resources.push({
	id: resourceId,
	connectionId,
	purpose: "llm",
	model: crypto.randomUUID(),
	contextWindow: 8192,
	voice: null,
});
await h.settings.apply({
	requestId: crypto.randomUUID(),
	expectedRevision: saved.revision,
	settings: saved,
	keys: [],
});
await h.store.write((tx) =>
	sdkHost.tasks.configureInTransaction(
		tx,
		{
			expectedRevision: 0,
			enabled: true,
			runnerId: "local",
			workspaceId: "eumenes",
			resourceId,
		},
		sdkHost.allowed(),
	),
);
const maintenance = setInterval(() => {
	void sdkHost.runs.maintain();
}, 250);
const api = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.EUMENES_PORT),
	fetch: (request) => {
		const path = new URL(request.url).pathname;
		if (path === "/fixture/sdk-calls") return Response.json(calls);
		if (path === "/fixture/sdk-state")
			return Response.json({
				pending: sdkHost.tasks.pending().map((a) => ({
					id: a.id,
					state: a.state,
					seq: a.seq,
					published: a.published,
				})),
				executions: sdk.store.ids().map((id) => {
					const a = sdk.store.read(id)!;
					return {
						executionId: a.executionId,
						state: a.state,
						seq: a.seq,
						managedExecutionStopped: a.managedExecutionStopped,
						reason: a.reason,
					};
				}),
				board: h.store.readSnapshot((tx) => {
					const b = sdkHost.kanban.sharedBoardInTransaction(tx, {
						runnable: true,
					});
					return {
						revision: b.revision,
						cards: b.cards.map((c) => ({
							id: c.id,
							revision: c.revision,
							column: c.column,
							label: c.label,
						})),
						runs: b.runs.map((r) => ({
							id: r.id,
							state: r.state,
							executionStopped: r.executionStopped,
						})),
					};
				}),
			});
		return h.app.fetch(request);
	},
});
let closing = false;
const stop = async () => {
	if (closing) return;
	closing = true;
	clearInterval(maintenance);
	await h.close();
	await server.close();
	api.stop(true);
	rmSync(root, { recursive: true, force: true });
	process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
export { h, sdkHost, stop };
