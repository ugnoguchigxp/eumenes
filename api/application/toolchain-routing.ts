import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	toolchainRuntimeOf,
	type Capabilities,
	type FixedDefinition,
	type ToolchainRuntimeMeta,
} from "../domains/capabilities";
import type { ToolchainHistory } from "../domains/toolchain-history";
import type { ToolchainRoutingPort } from "../domains/dialogue";
import type {
	BoundCommandPort,
	BoundCommandSet,
} from "../domains/dialogue/contracts/toolchains";
import type { AdapterRegistry } from "../domains/tool-runtime";
import type { SchemaProvider } from "./toolchain-adapters";

/**
 * Dialogue's view of the toolchain registry and selection history. Retrieval merges
 * full-text, vector and past-selection ranks; it never decides for the conversation model.
 * A toolchain revision with a binding runs through its registered adapter; others keep the
 * host's fixed runtime map.
 */
export function createToolchainRouting(
	capabilities: Capabilities,
	history: ToolchainHistory,
	embedQuery: ToolchainRoutingPort["embedQuery"],
	registry: AdapterRegistry,
	schemas: SchemaProvider,
): ToolchainRoutingPort {
	function runtimeInTransaction(
		db: Database,
		d: FixedDefinition,
	): ToolchainRuntimeMeta | undefined {
		const bound = capabilities.toolchainBindingInTransaction(db, d.revisionId);
		if (!bound) return toolchainRuntimeOf(d.id);
		const adapter = registry.get(bound.binding.document.adapterRef);
		return {
			execution: "command",
			binding: {
				bindingRevisionId: bound.binding.revisionId,
				adapterRef: bound.binding.document.adapterRef,
				artifactRevisionId: bound.artifact.revisionId,
				available: !!adapter && adapter.availableInTransaction(db),
			},
		};
	}
	function adapterOf(db: Database, bindingRevisionId: string) {
		const doc = capabilities.documentInTransaction(db, bindingRevisionId);
		const ref =
			doc && (doc.document as { kind?: string }).kind === "binding"
				? (doc.document as { adapterRef: string }).adapterRef
				: undefined;
		const adapter = ref ? registry.get(ref) : undefined;
		if (!adapter || !adapter.availableInTransaction(db))
			throw new Error("adapter_unavailable");
		return adapter;
	}
	const bound: BoundCommandPort = {
		snapshotInTransaction: (db, bindingRevisionId) =>
			adapterOf(db, bindingRevisionId).snapshotInTransaction(db),
		parseInvocation(set, toolId, args) {
			const tool = set.tools.find((t) => t.id === toolId);
			if (!tool) return { ok: false, code: "toolchain_command_tool_unknown" };
			const schema = schemas.get(tool.inputSchemaRef);
			if (!schema) return { ok: false, code: "unsupported_schema" };
			const parsed = schema.safeParse(args ?? {});
			return parsed.success
				? {
						ok: true,
						toolRevisionId: tool.toolRevisionId,
						operationName: tool.operationName,
						input: parsed.data as Record<string, unknown>,
					}
				: { ok: false, code: "toolchain_command_invalid_arguments" };
		},
		questionChoicesInTransaction: (db, bindingRevisionId, inputSchemaRef) =>
			adapterOf(db, bindingRevisionId).choicesInTransaction?.(
				db,
				inputSchemaRef,
			) ?? [],
		parseAnswer(inputSchemaRef, input) {
			const schema = schemas.get(inputSchemaRef);
			if (!schema) return { ok: false, code: "unsupported_schema" };
			const parsed = schema.safeParse(input);
			return parsed.success
				? { ok: true, value: parsed.data }
				: { ok: false, code: "invalid_answer" };
		},
		prepareInTransaction(db, runId, set, invocation) {
			adapterOf(db, set.bindingRevisionId);
			return capabilities.prepareBoundInTransaction(
				db,
				{ rootRunId: runId, taskId: runId, cancelEpoch: 0 },
				set.packageRevisionId,
				invocation.toolRevisionId,
				invocation.input,
			);
		},
	};
	return {
		embedQuery,
		routeInTransaction(db, input) {
			const active = capabilities
				.toolchainsInTransaction(db)
				.filter((d) => input.available.has(d.id));
			const past = input.query
				? history.similarSelectionsInTransaction(db, {
						space: input.query.space,
						vector: input.query.vector,
						activeRevisionIds: new Set(active.map((d) => d.revisionId)),
						excludeRunId: input.runId,
					})
				: [];
			const fromHistory = past.flatMap((p) => {
				const d = active.find((x) => x.functionName === p.functionName);
				return d ? [d.id] : [];
			});
			const cards = capabilities.toolchainCandidatesInTransaction(db, {
				text: input.text,
				vector: input.query
					? { space: input.query.space, values: input.query.vector }
					: undefined,
				available: (id) => input.available.has(id),
				fromHistory,
			});
			const fts = cards.some((c) => c.score.ftsRank !== null);
			const vector = cards.some((c) => c.score.similarity !== null);
			return {
				cards,
				past,
				retrieval:
					fts && vector
						? "hybrid"
						: vector
							? "embedding"
							: fts
								? "fts"
								: "none",
			};
		},
		catalogInTransaction(db) {
			return capabilities.toolchainsInTransaction(db).flatMap((d) => {
				const runtime = runtimeInTransaction(db, d);
				return runtime ? [{ id: d.id, revisionId: d.revisionId, runtime }] : [];
			});
		},
		resolveInTransaction(db, revisionId) {
			const resolved = capabilities.resolveToolchainInTransaction(
				db,
				revisionId,
			);
			const runtime = runtimeInTransaction(db, resolved.toolchain);
			if (!runtime || (runtime.binding && !runtime.binding.available))
				throw new Error("toolchain_unavailable");
			return { ...resolved, runtime };
		},
		commandSetInTransaction(db, revisionId) {
			const set = capabilities.toolchainSetInTransaction(db, revisionId);
			let binding: BoundCommandSet | undefined;
			if (set.binding) {
				const doc = set.binding.document;
				binding = {
					bindingRevisionId: set.binding.revisionId,
					adapterRef: doc.adapterRef,
					artifactRevisionId: doc.artifactRevisionId,
					packageRevisionId: set.package.revisionId,
					questions: doc.questions ?? [],
					tools: doc.tools.map((t) => {
						const tool = set.tools.find(
							(x) => x.revisionId === t.toolRevisionId,
						);
						const schema = schemas.resolveInTransaction(db, t.inputSchemaRef);
						if (!tool || !schema) throw new Error("required_context_missing");
						return {
							id: tool.id,
							toolRevisionId: t.toolRevisionId,
							operationName: t.operationId,
							inputSchemaRef: t.inputSchemaRef,
							summary: tool.summary,
							schema: z.toJSONSchema(schema) as Record<string, unknown>,
						};
					}),
				};
			}
			return {
				backend: set.package.backend,
				profile: set.profile,
				skills: set.skills,
				tools: set.tools as Array<{
					id: string;
					revisionId: string;
					summary: string;
					schema: Record<string, unknown> | null;
				}>,
				...(binding ? { binding } : {}),
			};
		},
		bound,
		recordSelectionInTransaction: history.recordSelectionInTransaction,
		linkTaskInTransaction: history.linkTaskInTransaction,
		settleSelectionInTransaction: history.settleSelectionInTransaction,
		requestOfRunInTransaction: history.requestOfRunInTransaction,
	};
}
