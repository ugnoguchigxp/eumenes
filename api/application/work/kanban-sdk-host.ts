import type { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import type { SqliteStore } from "../../infrastructure/sqlite";
import type { createSettings } from "../../domains/settings";
import type { Capabilities } from "../../domains/capabilities";
import { createCodexTasks } from "../../domains/codex-tasks";
import {
	sdkDaemonClient,
	registeredSdkGitRemotes,
	sdkTerminal,
} from "../../domains/coding";
import { createCodexTaskGit } from "./codex-task-git";
import {
	createKanban,
	readWorkspaceGuard,
	beginWorkspaceReleaseInTransaction,
	finishWorkspaceReleaseInTransaction,
	type KanbanExecutor,
} from "../../domains/kanban";
import { createTerminals } from "../../domains/terminals";
import { createKanbanExecutorRegistry } from "./kanban-executors";
import {
	createCodexTaskPort,
	adoptCodexTaskInTransaction,
} from "./codex-task-port";
import { connectCodexTaskRunner } from "./codex-task-runner";
import { enqueueDispatch, connectKanbanRuns } from "./kanban-runs";
import {
	createTerminalWorkspacePort,
	createIdleTerminalHandoff,
} from "./terminal-workspace";

/** Registry data and saved settings connect the two native session owners to the common board. */
export function createKanbanSdkHost(options: {
	store: SqliteStore;
	settings: Pick<Awaited<ReturnType<typeof createSettings>>, "inTransaction">;
	capabilities: () => Capabilities;
	dbPath: string;
	cwd?: string;
	hooks?: { baseUrl: string; publish: () => void };
	runner?: ReturnType<typeof import("../../domains/coding").sdkRunnerClient>;
	terminals?: (
		options: Parameters<typeof createTerminals>[0],
	) => ReturnType<typeof createTerminals>;
}) {
	const cwd = realpathSync(options.cwd ?? process.cwd());
	const workspaceRef = "eumenes";
	const workspace = (path: string | undefined) => {
		try {
			return realpathSync(path ?? cwd) === cwd ? workspaceRef : null;
		} catch {
			return null;
		}
	};
	const tasks = createCodexTasks({ store: options.store });
	const remotes = registeredSdkGitRemotes(cwd, "eumenes");
	const terminals = (options.terminals ?? createTerminals)({
		store: options.store,
		cwd,
		hookBaseUrl: options.hooks?.baseUrl,
		onChange: options.hooks?.publish,
		workspace: createTerminalWorkspacePort({
			store: options.store,
			executorId: "claude-code",
			workspaceRef: workspace,
		}),
	});
	const daemon =
		options.runner ??
		sdkDaemonClient({
			root: join(dirname(realpathSync(options.dbPath)), "codex-sdk-runner"),
			workspaces: { eumenes: cwd },
			remotes,
			protectedPaths: [
				dirname(realpathSync(options.dbPath)),
				join(cwd, ".env"),
			],
		});
	const workerProfile = "profile:codex-tasks.worker@1";
	const workerSkill = "skill:codex-tasks.worker@1";
	const configuration = () => codexConfiguration(tasks, options);
	const claude: KanbanExecutor = {
		id: "claude-code",
		revision: 1,
		label: "Claude Code",
		workspaceRef,
		sessionPolicy: "host-created",
		available: terminals.trackable(),
		capabilities: {
			terminal: true,
			activity: true,
			commit: false,
			push: false,
			commitPush: true,
		},
	};
	const codex = () => {
		const { saved, resource, connection } = configuration();
		const available =
			saved.enabled &&
			!!resource &&
			!!connection &&
			(!!options.runner || !!Bun.which("codex")) &&
			saved.runnerId === "local" &&
			saved.workspaceId === "eumenes";
		return {
			id: "codex",
			revision: 1,
			label: "Codex",
			workspaceRef,
			sessionPolicy: "executor-created" as const,
			available,
			...(!available
				? { unavailableReason: "Codexの作業設定とCLIの導入を確認してください" }
				: {}),
			capabilities: {
				terminal: false,
				activity: true,
				commit: available && Object.keys(remotes).length > 0,
				push: available && Object.keys(remotes).length > 0,
				commitPush: available && Object.keys(remotes).length > 0,
			},
		};
	};
	const port = createCodexTaskPort({
		tasks,
		scope: "eumenes",
		definition: codex,
		git: createCodexTaskGit({ tasks, scope: "eumenes", remotes }),
		contextInTransaction: (tx) => {
			const { saved, resource, connection } = configuration();
			if (!saved.enabled || !resource || !connection)
				throw new Error("codex_configuration_incomplete");
			const catalog = options.capabilities();
			const role = catalog.instructionInTransaction(tx, workerProfile);
			const skill = catalog.instructionInTransaction(tx, workerSkill);
			return {
				scope: "eumenes",
				workerRevision: `${role.revisionId}:${role.hash}/${skill.revisionId}:${skill.hash}`,
				workerInstruction: `${role.body}\n\n${skill.body}`,
				settingsRevision: saved.revision,
				runnerId: saved.runnerId!,
				workspaceId: saved.workspaceId!,
				model: resource.model,
				deadlineMs: 60 * 60_000,
			};
		},
		stop: async (id) => {
			await options.store.write((tx) => tasks.requestStopInTransaction(tx, id));
			try {
				await daemon.stop(id, `stop-${id}`);
				const until = Date.now() + 10_000;
				while (Date.now() < until) {
					const current = await daemon.inspect(id);
					if (sdkTerminal(current.state))
						return current.managedExecutionStopped &&
							current.state !== "unknown"
							? "confirmed"
							: "unconfirmed";
					await Bun.sleep(100);
				}
				return "unconfirmed";
			} catch {
				return "unconfirmed";
			}
		},
	});
	const registry = createKanbanExecutorRegistry([
		{
			definition: () => ({ ...claude, available: terminals.trackable() }),
			enqueueInTransaction: (tx, dispatch) =>
				enqueueDispatch(terminals, tx, dispatch),
			cancelQueuedInTransaction: terminals.cancelQueuedInTransaction,
			stop: async (id) =>
				(await terminals.stop(id)) === "unconfirmed"
					? "unconfirmed"
					: "confirmed",
		},
		port,
	]);
	const kanban = createKanban({
		store: options.store,
		executors: registry.definitions,
	});
	const claudeRuns = connectKanbanRuns(kanban, terminals);
	const driver = connectCodexTaskRunner({
		store: options.store,
		tasks,
		runner: (id) => (id === "local" ? daemon : undefined),
		adoptInTransaction: (tx, attempt) => {
			const adopted = adoptCodexTaskInTransaction(tx, kanban, "codex", attempt);
			if (adopted?.dispatch)
				registry.enqueueInTransaction(tx, kanban, adopted.dispatch);
		},
	});
	const handoff = createIdleTerminalHandoff({
		store: options.store,
		terminals,
		workspaceRef: workspace,
	});
	let closed = false;
	let maintenance: Promise<void> | undefined;
	const maintain = () =>
		(maintenance ??= (async () => {
			if (closed) return;
			await driver.flush();
			for (const session of terminals.workspaceSessions()) {
				if (
					session.owner.startsWith("kanban:") &&
					session.activity === "idle" &&
					!session.inflight
				) {
					const result = await handoff.begin(session.sessionId);
					if (result)
						await options.store.write((tx) =>
							finishWorkspaceReleaseInTransaction(
								tx,
								result.guard,
								result.managedStopped,
							),
						);
				}
			}
			await options.store.write((tx) => {
				for (const entry of terminals.list().sessions) {
					const guard = readWorkspaceGuard(tx, workspaceRef);
					const owner =
						entry.owner === "direct" ? `direct:${entry.id}` : entry.owner;
					if (
						entry.status === "exited" &&
						guard?.state === "held" &&
						guard.ownerRef === owner &&
						guard.executorId === "claude-code" &&
						beginWorkspaceReleaseInTransaction(tx, guard)
					)
						finishWorkspaceReleaseInTransaction(tx, guard, true);
				}
				for (const executor of registry.definitions()) {
					const dispatch = kanban.dispatchNextInTransaction(tx, executor.id);
					if (dispatch) registry.enqueueInTransaction(tx, kanban, dispatch);
				}
			});
		})().finally(() => {
			maintenance = undefined;
		}));
	return {
		kanban,
		terminals,
		tasks,
		registry,
		allowed: () => ({
			runners: ["local"],
			workspaces: ["eumenes"],
			resources: savedResources(
				options.store.readSnapshot(options.settings.inTransaction),
			).map((r) => r.id),
		}),
		resources: (tx: Database) =>
			savedResources(options.settings.inTransaction(tx)),

		activity(tx: Database, cardId: string, params: unknown) {
			const current = tasks.latestForCardInTransaction(tx, "eumenes", cardId);
			if (!current)
				return {
					revision: 0,
					data: {
						entries: [],
						connected: true,
						emptyText: "活動はまだありません",
					},
				};
			const after =
				typeof params === "object" && params !== null && "after" in params
					? Number(params.after)
					: 0;
			const events = tasks.activityInTransaction(
				tx,
				"eumenes",
				current.id,
				after,
				100,
			);
			return {
				revision: current.seq,
				data: {
					entries: events.map((e) => ({
						id: `${current.id}:${e.seq}`,
						at: e.at,
						title: e.itemType ?? e.type,
						detail: e.status ?? "",
						status:
							e.exitCode !== undefined &&
							e.exitCode !== null &&
							e.exitCode !== 0
								? "failed"
								: e.type.endsWith("completed")
									? "completed"
									: "working",
					})),
					connected: current.state !== "unknown",
					report: current.receipt?.report,
				},
			};
		},
		runs: {
			recover: async () => {
				await claudeRuns.recover();
				await driver.flush();
			},
			maintain: async () => {
				await claudeRuns.maintain();
				await maintain();
			},
			disconnect: async () => {
				closed = true;
				await maintenance;
				await driver.disconnect();
				claudeRuns.disconnect();
			},
		},
	};
}

function savedResources(
	saved: ReturnType<
		Awaited<ReturnType<typeof createSettings>>["inTransaction"]
	>,
) {
	return saved.resources
		.filter(
			(r) =>
				r.purpose === "llm" &&
				saved.connections.some(
					(c) => c.id === r.connectionId && c.kind === "codex-sdk" && c.enabled,
				),
		)
		.map((r) => ({
			id: r.id,
			label: `${saved.connections.find((c) => c.id === r.connectionId)!.name} / ${r.model}`,
		}));
}

function codexConfiguration(
	tasks: ReturnType<typeof createCodexTasks>,
	options: Pick<
		Parameters<typeof createKanbanSdkHost>[0],
		"store" | "settings"
	>,
) {
	const saved = tasks.settings();
	const global = options.store.readSnapshot(options.settings.inTransaction);
	const resource = global.resources.find(
		(r) => r.id === saved.resourceId && r.purpose === "llm",
	);
	const connection =
		resource &&
		global.connections.find(
			(c) =>
				c.id === resource.connectionId && c.kind === "codex-sdk" && c.enabled,
		);
	return { saved, resource, connection };
}
