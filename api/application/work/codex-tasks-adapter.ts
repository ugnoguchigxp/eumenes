import { z } from "zod";
import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../infrastructure/digest";
import type { DomainAdapter } from "../../domains/tool-runtime";
import type { CodexTasks } from "../../domains/codex-tasks";
import type { KanbanService } from "../../domains/kanban";
import {
	codexTaskRequest,
	codexTaskRef,
	codexTaskFollowup,
} from "../../domains/capabilities/contracts";
export const CODEX_TASKS_ADAPTER_REF = "adapter:codex-tasks@1";
const operations = new Map([
	[
		"codex-tasks.request",
		{ inputSchemaRef: "builtin:codexTaskRequest", effect: "write" as const },
	],
	[
		"codex-tasks.list",
		{ inputSchemaRef: "builtin:kanbanList", effect: "read" as const },
	],
	[
		"codex-tasks.followup",
		{ inputSchemaRef: "builtin:codexTaskFollowup", effect: "write" as const },
	],
	[
		"codex-tasks.cancel",
		{ inputSchemaRef: "builtin:codexTaskRef", effect: "write" as const },
	],
	[
		"codex-tasks.stop",
		{ inputSchemaRef: "builtin:codexTaskRef", effect: "write" as const },
	],
	[
		"codex-tasks.configure",
		{ inputSchemaRef: "builtin:codexTaskConfigure", effect: "write" as const },
	],
]);
const fields = z
	.object({
		expectedRevision: z.string(),
		enabled: z.enum(["true", "false"]),
		runnerId: z.string(),
		workspaceId: z.string(),
		resourceId: z.string(),
	})
	.strict();
export const describeCodexTasksAdapter = () => ({
	owner: "codex-tasks",
	operations,
	queries: new Set(["query:codex-tasks.settings@1"]),
	inputAdapters: new Map([
		[
			"input:codex-tasks.settings@1",
			(raw: Record<string, unknown>) => {
				const result = fields.safeParse(raw);
				if (!result.success)
					return {
						ok: false as const,
						errors: [{ field: "settings", message: "設定を確認してください" }],
					};
				const value = result.data;
				return {
					ok: true as const,
					value: {
						...value,
						expectedRevision: Number(value.expectedRevision),
						enabled: value.enabled === "true",
						runnerId: value.runnerId || null,
						workspaceId: value.workspaceId || null,
						resourceId: value.resourceId || null,
					},
				};
			},
		],
	]),
	projections: new Set(["projection:codex-tasks.result@1"]),
	availability: "availability:codex-tasks@1",
});
export function createCodexTasksAdapter(options: {
	tasks: CodexTasks;
	kanban: KanbanService;
	shared: DomainAdapter;
	allowed: () => {
		runners: readonly string[];
		workspaces: readonly string[];
		resources: readonly string[];
	};
	settingsSource: (tx: Database) => unknown;
}): DomainAdapter {
	const { tasks, kanban, shared } = options;
	return {
		ref: CODEX_TASKS_ADAPTER_REF,
		describe: describeCodexTasksAdapter,
		availableInTransaction: () => true,
		snapshotInTransaction: shared.snapshotInTransaction,
		choicesInTransaction: shared.choicesInTransaction,
		invokeInTransaction(tx, request) {
			if (request.operationName === "codex-tasks.configure") {
				if (request.origin.kind !== "ui")
					throw new Error("codex_settings_requires_ui");
				const receipt = tasks.configureInTransaction(
					tx,
					request.input,
					options.allowed(),
					request.requestId,
				);
				return {
					receipt,
					receiptRef: {
						owner: "codex-tasks",
						operationId: `settings:${request.requestId}`,
						digest: sha256Hex(JSON.stringify(receipt)),
					},
					resultRefs: [],
					replay: false,
					answerContext: { settings: receipt },
				};
			}
			const suffix = request.operationName.slice("codex-tasks.".length);
			let input = request.input;
			if (suffix === "request")
				input = { ...codexTaskRequest.parse(input), executorId: "codex" };
			else if (suffix !== "list") {
				const ref =
					suffix === "followup"
						? codexTaskFollowup.parse(input)
						: codexTaskRef.parse(input);
				if (kanban.cardExecutorInTransaction(tx, ref.cardId).id !== "codex")
					throw new Error("kanban_executor_mismatch");
			}
			return shared.invokeInTransaction(tx, {
				...request,
				operationName: `kanban.shared.${suffix === "request" ? "add-run" : suffix}`,
				input,
			});
		},
		readInTransaction(tx, id) {
			if (!id.startsWith("settings:")) return shared.readInTransaction(tx, id);
			const receipt = tasks.settingsReceiptInTransaction(tx, id.slice(9));
			return receipt
				? {
						receipt,
						receiptRef: {
							owner: "codex-tasks",
							operationId: id,
							digest: sha256Hex(JSON.stringify(receipt)),
						},
						resultRefs: [],
						replay: true,
					}
				: null;
		},
		sourceInTransaction: (tx, query) =>
			query === "query:codex-tasks.settings@1"
				? {
						revision: tasks.settingsInTransaction(tx).revision,
						data: options.settingsSource(tx),
					}
				: null,
		targetInput: () => ({}),
		afterCommit: shared.afterCommit,
	};
}
