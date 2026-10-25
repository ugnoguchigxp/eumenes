import { applyDotsProjectRole, dotsRoleOptions } from "./dots-project-role";
import type { DotsTasks } from "./dots-tasks";
import { createHash } from "node:crypto";
import { z } from "zod";
import { createInbox } from "../../domains/dots";
import type {
	Capabilities,
	ArtifactDefinitionV1,
} from "../../domains/capabilities";
import type { AdapterResult, DomainAdapter } from "../../domains/tool-runtime";
import type { DotsWork } from "./dots-work";
import { applyDotsSettings, dotsSettingsDocument } from "./dots-work-settings";

export const DOTS_DELEGATION_ADAPTER_REF = "adapter:dots-delegation@1";
const query = (key: string) => `query:dots.${key}@1`;
export const dotsWorkReceipt = z.object({
	version: z.literal(1),
	operation: z.string(),
	value: z.unknown().optional(),
	revision: z.number().int().optional(),
	verification: z.literal("registered_in_eumenes").optional(),
});
export const dotsWorkDomainSchemas = {
	"domain:dots.work-receipt@1": dotsWorkReceipt,
};
export const describeDotsDelegationAdapter = () => ({
	owner: "dots",
	operations: new Map([
		[
			"dots.project-role",
			{
				inputSchemaRef: "schema:dots-project-role@3",
				effect: "write" as const,
			},
		],
		[
			"dots.start",
			{ inputSchemaRef: "builtin:dotsWorkStartV1", effect: "write" as const },
		],
		[
			"dots.list",
			{ inputSchemaRef: "builtin:dotsWorkListV1", effect: "read" as const },
		],
		[
			"dots.inspect",
			{ inputSchemaRef: "builtin:dotsWorkInspectV1", effect: "read" as const },
		],
		[
			"dots.answer",
			{ inputSchemaRef: "builtin:dotsWorkAnswerV1", effect: "write" as const },
		],
		[
			"dots.stop",
			{ inputSchemaRef: "builtin:dotsWorkStopV1", effect: "write" as const },
		],
		[
			"dots.settings-apply",
			{
				inputSchemaRef: "schema:dots-work-settings-apply@3",
				effect: "write" as const,
			},
		],
	]),
	queries: new Set(
		[
			"jobs",
			"work",
			"activity",
			"connection",
			"settings",
			"connections",
			"projects",
			"roles",
		].map(query),
	),
	inputAdapters: new Map(),
	projections: new Set(["projection:dots-work-result@1"]),
	availability: "availability:dots-delegation@1",
	documents: new Map([["document:dots.settings@1", dotsSettingsDocument]]),
});
export function createDotsDelegationAdapter(
	work: DotsWork,
	capabilities: () => Capabilities,
	configuration: DotsTasks["config"],
): DomainAdapter {
	const inbox = createInbox(Date.now);
	function result(
		receipt: unknown,
		id: string,
		replay: boolean,
	): AdapterResult {
		const value = receipt as { value?: { taskId?: string; revision?: number } };
		return {
			receipt,
			receiptRef: {
				owner: "dots",
				operationId: id,
				digest: createHash("sha256")
					.update(JSON.stringify(receipt))
					.digest("hex"),
			},
			resultRefs: value.value?.taskId
				? [
						{
							owner: "dots",
							kind: "work",
							id: value.value.taskId,
							schemaRef: "domain:dots.work-receipt@1",
							revision: value.value.revision,
						},
					]
				: [],
			replay,
			answerContext: receipt,
		};
	}
	return {
		ref: DOTS_DELEGATION_ADAPTER_REF,
		describe: describeDotsDelegationAdapter,
		availableInTransaction: work.available,
		artifactAvailableInTransaction: () => true,
		snapshotInTransaction: work.snapshot,
		invokeInTransaction(db, request) {
			if (request.operationName === "dots.project-role") {
				if (request.origin.kind !== "ui")
					throw new Error("dots_permission_denied");
				const saved = applyDotsProjectRole(
					db,
					configuration,
					capabilities(),
					request.input,
					request.requestId,
					request.origin.scope,
				);
				return result(saved.receipt, request.requestId, saved.replay);
			}
			const applied =
				request.operationName === "dots.settings-apply"
					? (() => {
							if (request.origin.kind !== "ui")
								throw new Error("dots_permission_denied");
							return applyDotsSettings(
								db,
								work,
								request.input,
								request.requestId,
								createHash("sha256")
									.update(JSON.stringify(request.input))
									.digest("hex"),
								(id) => {
									for (const a of capabilities().artifactsInTransaction(db)) {
										const doc = capabilities().documentInTransaction(
											db,
											a.artifactRevisionId,
										)?.document as ArtifactDefinitionV1 | undefined;
										const found = doc?.fields?.find((f) => f.fieldId === id);
										if (found) return found;
									}
									return undefined;
								},
							);
						})()
					: work.invoke(db, request);
			return result(applied.receipt, request.requestId, applied.replay);
		},
		readInTransaction(db, id) {
			const receipt = work.read(db, id);
			return receipt ? result(receipt, id, true) : null;
		},
		sourceInTransaction(db, name, target, params) {
			const saved = work.settings.inTransaction(db),
				config = configuration.listInTransaction(db);
			if (name === query("settings"))
				return { revision: saved.revision, data: saved };
			if (name === query("connections"))
				return {
					revision: saved.revision,
					data: {
						options: [
							{ value: "", label: "未選択" },
							...config.connections.map((c) => ({
								value: c.id,
								label: c.title + (c.enabled ? "" : "（無効）"),
							})),
						],
					},
				};
			if (name === query("roles"))
				return {
					revision: 0,
					data: { options: dotsRoleOptions(db, capabilities()) },
				};
			if (name === query("projects"))
				return {
					revision: saved.revision,
					data: {
						items: config.projects.map((p) => ({
							ref: p.ref,
							title: p.title,
							revision: p.revision,
							capabilityRevisionId: p.capabilityRevisionId,
						})),
						options: [
							{ value: "", label: "未選択" },
							...config.projects.map((p) => ({
								value: p.ref,
								label: `${p.title}（${p.environment === "cloud" ? "クラウド" : "このPC"}${p.enabled ? "" : "・無効"}）`,
							})),
						],
					},
				};
			if (name === query("connection")) {
				const c = config.connections.find(
						(c) => c.id === saved.settings.connectionRef,
					),
					p = config.projects.find((p) => p.ref === saved.settings.projectRef);
				return {
					revision: saved.revision,
					data: {
						enabled: saved.settings.enabled,
						connection: c
							? {
									title: c.title,
									enabled: c.enabled,
									oauthConfigured: !!c.oauth,
								}
							: null,
						project: p
							? {
									title: p.title,
									environment: p.environment,
									enabled: p.enabled,
								}
							: null,
					},
				};
			}
			if (name === query("jobs"))
				return {
					revision: 0,
					data: work.page(
						db,
						undefined,
						(params as { offset?: number } | undefined)?.offset ?? 0,
					),
				};
			if (!target) return null;
			try {
				const detail = work.detail(db, target);
				if (name === query("work"))
					return { revision: detail.task.revision, data: detail };
				if (name === query("activity"))
					return {
						revision: detail.task.revision,
						data: {
							commands: inbox.commandsInTransaction(db, target).map((c) => ({
								id: c.commandId,
								kind: c.kind,
								state: c.state,
								createdAt: c.createdAt,
							})),
							sessions: detail.sessions,
						},
					};
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === "dots_permission_denied"
				)
					return null;
				throw error;
			}
			return null;
		},
		targetInput: (_query, target, revision) => ({
			taskRef: target,
			expectedRevision: revision,
		}),
	};
}
