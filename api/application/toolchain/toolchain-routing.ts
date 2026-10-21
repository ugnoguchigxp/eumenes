import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	toolchainRuntimeOf,
	type AgentV1,
	type BindingV1,
	type Capabilities,
	type FixedDefinition,
	type ToolchainRuntimeMeta,
} from "../../domains/capabilities";
import type { ToolchainHistory } from "../../domains/toolchain-history";
import type { ToolchainRoutingPort } from "../../domains/dialogue";
import type { SpecialistSet } from "../../domains/dialogue/contracts/specialist";
import type {
	BoundCommandPort,
	BoundCommandSet,
} from "../../domains/dialogue/contracts/toolchains";
import type { AdapterRegistry } from "../../domains/tool-runtime";
import type { SchemaProvider } from "./toolchain-adapters";
import { createInstantRouting } from "./toolchain-instant";

/**
 * Dialogue's view of the toolchain registry and selection history. Retrieval uses
 * the current request embedding; past selections are reference data.
 * It never decides for the conversation model.
 * A toolchain revision with a binding runs through its registered adapter; others keep the
 * host's fixed runtime map (the World investigation also needs World to be usable).
 */
export function createToolchainRouting(
	capabilities: Capabilities,
	history: ToolchainHistory,
	embedQuery: ToolchainRoutingPort["embedQuery"],
	registry: AdapterRegistry,
	schemas: SchemaProvider,
	/** World is usable now; without it the World investigation is never offered. */
	worldAvailable?: (db: Database) => boolean,
): ToolchainRoutingPort {
	function runtimeInTransaction(
		db: Database,
		d: FixedDefinition,
	): ToolchainRuntimeMeta | undefined {
		const bound = capabilities.toolchainBindingInTransaction(db, d.revisionId);
		if (!bound) {
			const runtime = toolchainRuntimeOf(d.id);
			return runtime?.requires === "world" && !worldAvailable?.(db)
				? undefined
				: runtime;
		}
		const adapter = registry.get(bound.binding.document.adapterRef);
		return {
			execution: bound.binding.document.execution,
			binding: {
				bindingRevisionId: bound.binding.revisionId,
				adapterRef: bound.binding.document.adapterRef,
				...(bound.artifact
					? { artifactRevisionId: bound.artifact.revisionId }
					: {}),
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
	/** The binding's tools with the package tool's id and summary and the flat JSON schema. */
	function boundTools(
		db: Database,
		set: ReturnType<Capabilities["toolchainSetInTransaction"]>,
		tools: BindingV1["tools"],
	) {
		return tools.map((t) => {
			const tool = set.tools.find((x) => x.revisionId === t.toolRevisionId);
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
		});
	}
	const instant = createInstantRouting({
		capabilities,
		registry,
		schemas,
		fallbackAvailable: (db, d) => {
			const runtime = runtimeInTransaction(db, d);
			return !!runtime && (!runtime.binding || runtime.binding.available);
		},
	});
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
		answerSchema(inputSchemaRef) {
			const schema = schemas.get(inputSchemaRef);
			return schema ? z.toJSONSchema(schema) : null;
		},
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
		cardInTransaction(db, revisionId) {
			const d = capabilities
				.toolchainsInTransaction(db)
				.find((d) => d.revisionId === revisionId);
			if (!d) return undefined;
			const runtime = runtimeInTransaction(db, d);
			if (!runtime || (runtime.binding && !runtime.binding.available))
				return undefined;
			const card = capabilities
				.toolchainCandidatesInTransaction(db, {
					text: "",
					// Preserve redirect identities; only this exact revision is returned and enriched.
					available: () => true,
				})
				.find((c) => c.revisionId === revisionId);
			return card ? instant.card(db, card)[0] : undefined;
		},
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
				excludeRevisionIds: input.excludeRevisionIds,
				strict: input.strict,
				limit: input.strict ? 4 : undefined,
			});
			const offered = cards.flatMap((card) => instant.card(db, card));
			const fts = cards.some((c) => c.score.ftsRank !== null);
			const vector = cards.some((c) => c.score.similarity !== null);
			return {
				cards: offered,
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
				if (doc.execution !== "command")
					throw new Error("capability_unavailable");
				binding = {
					bindingRevisionId: set.binding.revisionId,
					adapterRef: doc.adapterRef,
					artifactRevisionId: doc.artifactRevisionId,
					packageRevisionId: set.package.revisionId,
					questions: doc.questions ?? [],
					tools: boundTools(db, set, doc.tools),
					...(doc.agent ? { agentTurn: doc.agent.turn } : {}),
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
		sessionSetInTransaction(db, revisionId): SpecialistSet {
			const set = capabilities.toolchainSetInTransaction(db, revisionId);
			const doc = set.binding?.document;
			if (!set.binding || doc?.execution !== "session")
				throw new Error("capability_unavailable");
			const adapter = registry.get(doc.adapterRef);
			if (!adapter?.availableInTransaction(db))
				throw new Error("capability_unavailable");
			return {
				toolchainId: set.toolchain.id,
				toolchainRevisionId: set.toolchain.revisionId,
				title: set.toolchain.title,
				bindingRevisionId: set.binding.revisionId,
				adapterRef: doc.adapterRef,
				artifactRevisionId: doc.artifactRevisionId,
				packageRevisionId: set.package.revisionId,
				profile: set.profile,
				skills: set.skills,
				tools: boundTools(db, set, doc.tools),
				targetSchemaRef: doc.session.targetSchemaRef ?? null,
				timeLimits: doc.timeLimits ?? null,
				agent: agentOf(doc.agent, () => adapter.describe().workspaces),
			};
		},
		bound,
		instantInTransaction: instant.run,
		recordSelectionInTransaction: history.recordSelectionInTransaction,
		linkTaskInTransaction: history.linkTaskInTransaction,
		settleSelectionInTransaction: history.settleSelectionInTransaction,
		requestOfRunInTransaction: history.requestOfRunInTransaction,
		usageOfRunInTransaction: history.usageOfRunInTransaction,
	};
}

/**
 * The binding's agent settings as the specialist runs them. The work document is the adapter's own
 * declaration; one it does not declare makes the toolchain unusable (registration refuses it too).
 */
function agentOf(
	agent: AgentV1 | undefined,
	/** Read only for a binding that names a work document. */
	workspaces: () =>
		| ReadonlyMap<string, { path: string; mediaType: string }>
		| undefined,
): SpecialistSet["agent"] {
	const ref = agent?.workspace?.documentRef;
	const declared = ref ? workspaces()?.get(ref) : undefined;
	if (ref && !declared) throw new Error("capability_unavailable");
	return {
		document:
			ref && declared
				? {
						ref,
						...declared,
						...(agent?.workspace?.inlineBytes !== undefined
							? { inlineBytes: agent.workspace.inlineBytes }
							: {}),
					}
				: null,
		...(agent?.turn?.maxModelCalls !== undefined
			? { maxModelCalls: agent.turn.maxModelCalls }
			: {}),
		...(agent?.turn?.retries ? { retries: agent.turn.retries } : {}),
		...(agent?.memory?.recentTurns !== undefined
			? { recentTurns: agent.memory.recentTurns }
			: {}),
		...(agent?.memory?.recentBytes !== undefined
			? { recentBytes: agent.memory.recentBytes }
			: {}),
		sharedTools: agent?.sharedTools ?? [],
	};
}
