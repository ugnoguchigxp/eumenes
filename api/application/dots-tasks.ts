import { createDotsQueries } from "./dots-queries";
import { assertDotsSessionAccess } from "./dots-session-access";
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../infrastructure/sqlite";
import {
	createCommands,
	createConfiguration,
	createInbox,
	type Command,
	type Project,
} from "../domains/dots";
import type {
	TasksService,
	TaskKindDefinition,
	WorkTask,
	OrchestrationWorkTask,
} from "../domains/tasks";
import type { TaskReports } from "../domains/task-reports";
import type { Prepared, Capabilities } from "../domains/capabilities";
import type { ConversationService } from "../domains/conversation";

export function createDotsTasks(input: {
	store: SqliteStore;
	tasks: () => TasksService;
	reports: TaskReports;
	capabilities?: () => Capabilities;
	conversation?: ConversationService;
	now?: () => number;
	commandPrepared?: (db: Database, c: Command) => void;
}) {
	const { store, tasks, reports } = input,
		now = input.now ?? Date.now;
	const config = createConfiguration(store, (db, scope) => {
			if (
				scope.ownershipChanged &&
				scope.connectionRef &&
				tasks().hasConnectionHistoryInTransaction(db, scope.connectionRef)
			)
				throw new Error("dots_owner_immutable");
			for (const t of tasks().liveInTransaction(db)) {
				if (
					t.kind !== "orchestration" ||
					t.state === "stopping" ||
					t.state === "paused" ||
					t.state === "registered"
				)
					continue;
				if (
					(scope.connectionRef &&
						t.grant.connectionRef === scope.connectionRef) ||
					(scope.projectRef && t.grant.projectRef === scope.projectRef)
				)
					tasks().requestStopInTransaction(db, t.id, {
						requestId: crypto.randomUUID(),
						expectedRevision: t.revision,
						intent: "pause",
					});
			}
		}),
		commands = createCommands(store, now),
		inbox = createInbox(now);
	function orchestration(t: WorkTask): OrchestrationWorkTask {
		if (t.kind !== "orchestration") throw new Error("invalid_dots_task");
		return t;
	}
	function available() {
		return config.list().connections.some((c) => c.enabled);
	}
	function validateGrant(db: Database, t: WorkTask) {
		const task = orchestration(t),
			p = inbox.projectInTransaction(db, task.grant.projectRef);
		if (
			!p ||
			p.connectionRef !== task.grant.connectionRef ||
			!p.enabled ||
			!task.grant.operations.every((op) => p.allowedOperations.includes(op))
		)
			throw new Error("dots_permission_denied");
		assertDotsSessionAccess(db, task, { tasks, inbox });
	}
	function prepare(
		db: Database,
		task: WorkTask,
		kind: Command["kind"],
		questionId?: string,
	) {
		const t = orchestration(task),
			c = inbox.connectionInTransaction(db, t.grant.connectionRef),
			project = inbox.projectInTransaction(db, t.grant.projectRef);
		if (!c || !project || project.connectionRef !== c.id)
			throw new Error("dots_unavailable");
		if (kind !== "stop" && (!c.enabled || !project.enabled))
			throw new Error("dots_unavailable");
		const old = inbox.commandsInTransaction(db, t.id);
		const previous =
			[...old]
				.reverse()
				.find(
					(cmd) =>
						cmd.kind === "start" &&
						cmd.authorityEpoch === t.authorityEpoch &&
						cmd.executionGeneration === t.executionGeneration,
				) ?? [...old].reverse().find((cmd) => cmd.kind === "start");
		const question = questionId
			? tasks().questionInTransaction(db, questionId)
			: null;
		if (questionId && (!question || question.answer === null))
			throw new Error("invalid_dots_answer");
		let capability: Prepared | null = null;
		if (
			kind !== "stop" &&
			input.capabilities &&
			(kind === "answer" || kind === "reconcile") &&
			previous?.snapshot.capability
		) {
			capability = previous.snapshot.capability as Prepared;
			input.capabilities().validateInTransaction(db, capability);
		} else if (kind !== "stop" && input.capabilities)
			capability = input
				.capabilities()
				.prepareActiveByIdInTransaction(
					db,
					{ rootRunId: t.id, taskId: t.id, cancelEpoch: t.authorityEpoch },
					project.capabilityRevisionId,
					{},
				);
		const stopProject = (previous?.snapshot.project ?? project) as Project;
		const commandId = createHash("sha256")
			.update(
				JSON.stringify([
					t.id,
					kind,
					t.authorityEpoch,
					t.executionGeneration,
					questionId ?? (kind === "reconcile" ? "recovery" : t.revision),
				]),
			)
			.digest("hex");
		const command = commands.prepareInTransaction(db, {
			commandId,
			taskId: t.id,
			connectionRef: c.id,
			kind,
			authorityEpoch: t.authorityEpoch,
			executionGeneration: t.executionGeneration,
			createdAt: now(),
			expiresAt:
				kind === "stop"
					? now() + 86400000
					: Math.min(
							Date.parse(t.grant.expiresAt),
							Date.parse(t.executionDeadlineAt ?? t.grant.expiresAt),
						),
			state: "pending",
			leaseId: null,
			snapshot: {
				protocolVersion: 1,
				workflowVersion: 1,
				task: kind === "stop" ? { id: t.id, stopIntent: t.stopIntent } : t,
				project:
					kind === "stop"
						? {
								nativeProjectId: stopProject.nativeProjectId,
								hostId: stopProject.hostId,
							}
						: project,
				connectionRevision: c.revision,
				projectRevision: project.revision,
				sessions: kind === "stop" ? [] : inbox.sessionsInTransaction(db, t.id),
				capability:
					kind === "stop"
						? null
						: (capability ?? previous?.snapshot.capability ?? null),
				sourceRequest:
					kind === "stop"
						? null
						: (previous?.snapshot.sourceRequest ??
							(t.origin.source === "conversation"
								? (input.conversation?.messageInTransaction(
										db,
										t.origin.messageId,
									)?.message.text ?? null)
								: null)),
				...(question
					? { answer: { questionId: question.id, text: question.answer } }
					: {}),
			},
		});
		input.commandPrepared?.(db, command);
	}
	const kind: TaskKindDefinition = {
		kind: "orchestration",
		version: 1,
		available,
		startInTransaction(db, t) {
			validateGrant(db, t);
			prepare(db, t, "start");
		},
		answerInTransaction(db, t, q) {
			commands.supersedeInTransaction(db, t.id, true);
			reports.supersedeQuestionsInTransaction(db, t.id);
			prepare(db, t, "answer", q);
		},
		stopInTransaction(db, t, context) {
			const existing = inbox
				.commandsInTransaction(db, t.id)
				.find(
					(c) =>
						c.kind === "stop" &&
						c.authorityEpoch === t.authorityEpoch &&
						c.executionGeneration === t.executionGeneration,
				);
			if (existing) {
				if (existing.expiresAt <= now()) {
					const renewed = commands.renewStopInTransaction(
						db,
						existing.commandId,
					);
					input.commandPrepared?.(db, renewed);
				}
				return;
			}
			commands.supersedeInTransaction(db, t.id);
			if (!context?.executionStopped) prepare(db, t, "stop");
		},
		terminalInTransaction(db, t) {
			commands.supersedeInTransaction(
				db,
				t.id,
				t.state === "completed" || t.state === "failed",
			);
		},
	};
	function current(db: Database, owner: string, c: Command) {
		const t = tasks().getInTransaction(db, c.taskId);
		if (!t || t.kind !== "orchestration" || t.grant.connectionRef !== owner)
			throw new Error("dots_permission_denied");
		if (
			t.authorityEpoch !== c.authorityEpoch ||
			t.executionGeneration !== c.executionGeneration
		)
			throw new Error("dots_stale");
		if (c.kind === "stop") {
			if (t.state !== "stopping") throw new Error("dots_stale");
			return t;
		}
		if (c.kind === "reminder") {
			const schedule = inbox.scheduleInTransaction(
				db,
				String(c.snapshot.scheduleRef),
			);
			if (
				!schedule ||
				schedule.command_id !== c.commandId ||
				schedule.expires_at <= now() ||
				t.bodyExpired ||
				t.forgottenAt ||
				["stopping", "cancelled", "paused"].includes(t.state) ||
				!inbox.connectionInTransaction(db, owner)?.enabled ||
				inbox.connectionInTransaction(db, owner)?.revision !==
					c.snapshot.connectionRevision ||
				!inbox.projectInTransaction(db, t.grant.projectRef)?.enabled ||
				inbox.projectInTransaction(db, t.grant.projectRef)?.revision !==
					c.snapshot.projectRevision
			)
				throw new Error("dots_stale");
			return t;
		}
		if (
			t.bodyExpired ||
			t.forgottenAt ||
			Date.parse(t.grant.expiresAt) <= now() ||
			Date.parse(t.executionDeadlineAt ?? t.grant.expiresAt) <= now()
		)
			throw new Error("dots_stale");
		const connection = inbox.connectionInTransaction(db, owner),
			project = inbox.projectInTransaction(db, t.grant.projectRef);
		if (
			!connection?.enabled ||
			!project?.enabled ||
			connection.revision !== c.snapshot.connectionRevision ||
			project.revision !== c.snapshot.projectRevision
		)
			throw new Error("dots_stale");
		if (input.capabilities && c.snapshot.capability)
			input
				.capabilities()
				.validateInTransaction(db, c.snapshot.capability as Prepared);
		return t;
	}
	return {
		kind,
		config,
		commands,
		available,
		...createDotsQueries({
			store,
			now,
			commands,
			tasks,
			inbox,
			current,
			prepare,
			reports,
		}),
	};
}
export type DotsTasks = ReturnType<typeof createDotsTasks>;
