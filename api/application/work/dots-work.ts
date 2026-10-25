import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { Capabilities } from "../../domains/capabilities";
import {
	dotsWorkStartV1,
	dotsWorkListV1,
	dotsWorkInspectV1,
	dotsWorkAnswerV1,
	dotsWorkStopV1,
} from "../../domains/capabilities/contracts";
import type { TasksService, OrchestrationWorkTask } from "../../domains/tasks";
import type { ConversationService } from "../../domains/conversation";
import {
	createInbox,
	createWorkSettings,
	workOperation,
	putWorkOperation,
} from "../../domains/dots";
import type { AdapterOrigin } from "../../domains/tool-runtime";
import type { TaskReports } from "../../domains/task-reports";
import type { WorkDetailView } from "../../domains/dots/contracts";

const digest = (v: unknown) =>
	createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function createDotsWork(input: {
	tasks: TasksService;
	conversation: ConversationService;
	capabilities: () => Capabilities;
	reports?: TaskReports;
	now?: () => number;
}) {
	const now = input.now ?? Date.now,
		inbox = createInbox(now),
		settings = createWorkSettings(now);
	function projects(db: Database) {
		const saved = settings.inTransaction(db);
		return inbox.projectsInTransaction(db).flatMap((p) => {
			const c = inbox.connectionInTransaction(db, p.connectionRef);
			if (
				!p.enabled ||
				!c?.enabled ||
				p.connectionRef !== saved.settings.connectionRef
			)
				return [];
			try {
				const pack = input.capabilities().prepareActiveByIdInTransaction(
					db,
					{
						rootRunId: "dots-catalog",
						taskId: "dots-catalog",
						cancelEpoch: 0,
					},
					p.capabilityRevisionId,
					{},
				);
				return [
					{
						...p,
						connectionRevision: c.revision,
						capability: {
							revisionId: pack.package.revisionId,
							hash: pack.package.hash,
							generation: pack.package.generation,
						},
						available: saved.settings.enabled,
					},
				];
			} catch {
				return [];
			}
		});
	}
	function page(db: Database, conversationId?: string, offset = 0) {
		const rows = input.tasks.kindPageInTransaction(
			db,
			"orchestration",
			conversationId,
			offset,
			51,
		) as OrchestrationWorkTask[];
		return {
			items: rows.slice(0, 50).map((t) => ({
				ref: t.id,
				title: t.title,
				state: t.state,
				revision: t.revision,
				question: input.tasks.openQuestionInTransaction(db, t.id)?.id ?? null,
			})),
			nextOffset: rows.length > 50 ? offset + 50 : null,
		};
	}
	function detail(db: Database, taskRef: string, conversationId?: string) {
		const task = input.tasks.getInTransaction(db, taskRef);
		if (
			!task ||
			task.kind !== "orchestration" ||
			task.bodyExpired ||
			task.forgottenAt ||
			(conversationId &&
				(task.origin.source !== "conversation" ||
					task.origin.conversationId !== conversationId))
		)
			throw new Error("dots_permission_denied");
		const reported = input.reports?.latestInTransaction(db, taskRef) ?? null;
		return {
			task,
			question: input.tasks.openQuestionInTransaction(db, taskRef),
			sessions: inbox.sessionsInTransaction(db, taskRef),
			report:
				reported?.authorityEpoch === task.authorityEpoch &&
				reported.executionGeneration === task.executionGeneration
					? reported
					: null,
		} satisfies WorkDetailView;
	}
	function originKey(origin: AdapterOrigin) {
		if (origin.kind === "ui")
			return JSON.stringify({ kind: origin.kind, scope: origin.scope });
		if (origin.kind !== "conversation")
			throw new Error("dots_permission_denied");
		return JSON.stringify({
			kind: origin.kind,
			conversationId: origin.conversationId,
			messageId: origin.messageId,
			runId: origin.runId,
		});
	}
	function invoke(
		db: Database,
		request: {
			operationName: string;
			input: unknown;
			requestId: string;
			origin: AdapterOrigin;
		},
	) {
		const origin = originKey(request.origin),
			hash = digest([request.operationName, request.input]),
			old = workOperation(db, request.requestId);
		if (old) {
			if (old.digest !== hash || old.origin_json !== origin)
				throw new Error("dots_conflict");
			return { receipt: JSON.parse(old.receipt_json), replay: true };
		}
		const conversationId =
			request.origin.kind === "conversation"
				? request.origin.conversationId
				: undefined;
		if (request.origin.kind === "conversation") {
			const message = input.conversation.messageInTransaction(
				db,
				request.origin.messageId,
			)?.message;
			if (message?.role !== "user" || message.conversationId !== conversationId)
				throw new Error("dots_permission_denied");
		}
		let value: unknown;
		if (request.operationName === "dots.start") {
			if (request.origin.kind !== "conversation")
				throw new Error("dots_permission_denied");
			const data = dotsWorkStartV1.parse(request.input),
				saved = settings.inTransaction(db).settings;
			const p = projects(db).find((p) => p.ref === data.projectRef);
			if (
				!p ||
				p.revision !== data.projectRevision ||
				p.connectionRevision !== data.connectionRevision
			)
				throw new Error("dots_stale");
			if (!p.available) throw new Error("dots_unavailable");
			if (
				data.runtimeSeconds > saved.maxRuntimeSeconds ||
				data.maxSessions > saved.maxSessions ||
				!data.operations.every((op) => p.allowedOperations.includes(op))
			)
				throw new Error("dots_permission_denied");
			// tasks and dots validate continued Session ownership and native project/host bounds.
			value = input.tasks.createInTransaction(
				db,
				{
					requestId: request.requestId,
					kind: "orchestration",
					version: 1,
					title: data.title,
					request: data.request,
					completionConditions: data.completionConditions,
					startMode: data.startMode,
					grant: {
						connectionRef: p.connectionRef,
						projectRef: p.ref,
						operations: data.operations,
						sessionRefs: data.sessionRefs,
						maxSessions: data.maxSessions,
						maxRuntimeMs: data.runtimeSeconds * 1000,
						expiresAt: new Date(
							now() + data.runtimeSeconds * 1000,
						).toISOString(),
					},
				},
				{
					origin: {
						source: "conversation",
						conversationId: request.origin.conversationId,
						messageId: request.origin.messageId,
						runId: request.origin.runId,
						operationKey: `dots:${request.requestId}`,
					},
				},
			);
		} else if (request.operationName === "dots.list") {
			value = page(
				db,
				conversationId,
				dotsWorkListV1.parse(request.input).offset,
			);
		} else {
			const data =
				request.operationName === "dots.inspect"
					? dotsWorkInspectV1.parse(request.input)
					: request.operationName === "dots.answer"
						? dotsWorkAnswerV1.parse(request.input)
						: request.operationName === "dots.stop"
							? dotsWorkStopV1.parse(request.input)
							: null;
			if (!data) throw new Error("unsupported_operation");
			const view = detail(db, data.taskRef, conversationId);
			if (
				"expectedRevision" in data &&
				data.expectedRevision !== view.task.revision
			)
				throw new Error("revision_conflict");
			if (request.operationName === "dots.answer") {
				const answer = dotsWorkAnswerV1.parse(request.input);
				value = input.tasks.answerInTransaction(db, data.taskRef, {
					requestId: request.requestId,
					expectedRevision: answer.expectedRevision,
					questionId: answer.questionId,
					answer: answer.answer,
				});
			} else if (request.operationName === "dots.stop") {
				const stop = dotsWorkStopV1.parse(request.input);
				value = input.tasks.requestStopInTransaction(db, data.taskRef, {
					requestId: request.requestId,
					expectedRevision: stop.expectedRevision,
					intent: stop.intent,
				});
			} else
				value = {
					taskId: view.task.id,
					title: view.task.title,
					state: view.task.state,
					revision: view.task.revision,
					result: view.task.result,
					question: view.question,
					sessions: view.sessions,
				};
		}
		const receipt = {
			version: 1,
			operation: request.operationName,
			value,
			verification: "registered_in_eumenes",
		};
		putWorkOperation(db, {
			id: request.requestId,
			digest: hash,
			origin,
			receipt,
			now: now(),
		});
		return { receipt, replay: false };
	}
	return {
		settings,
		projects,
		page,
		detail,
		invoke,
		available(db: Database) {
			return projects(db).some((p) => p.available);
		},
		snapshot(db: Database, context?: { conversationId: string }) {
			return {
				settings: settings.inTransaction(db),
				projects: projects(db),
				tasks: context ? page(db, context.conversationId).items : [],
			};
		},
		read(db: Database, id: string) {
			const row = workOperation(db, id);
			return row ? JSON.parse(row.receipt_json) : null;
		},
	};
}
export type DotsWork = ReturnType<typeof createDotsWork>;
