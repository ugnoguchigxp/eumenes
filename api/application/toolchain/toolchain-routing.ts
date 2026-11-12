import type { Database } from "bun:sqlite";
import { z } from "zod";
import {
	READ_TOOLS,
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

/** Changes when the connection's data changes: its own writes and other connections' commits. */
function dataVersion(db: Database) {
	const changes = db
		.query<{ n: number }, []>("SELECT total_changes() AS n")
		.get()!.n;
	const version = db
		.query<{ data_version: number }, []>("PRAGMA data_version")
		.get()!.data_version;
	return `${changes}:${version}`;
}

/**
 * A value computed once per synchronous pass over a connection. The catalog, the cards and the adapters'
 * availability are asked for many times in one pass (each agency conversation, each autonomy check), and each
 * answer walks every capability. The value is dropped when the connection's data changes and after the current
 * task, so state outside the database (a service that came up) is read again next time.
 */
function perPass<T>(compute: (db: Database) => T) {
	const cache = new WeakMap<Database, { version: string; value: T }>();
	return (db: Database): T => {
		const version = dataVersion(db);
		const hit = cache.get(db);
		if (hit?.version === version) return hit.value;
		const value = compute(db);
		cache.set(db, { version, value });
		queueMicrotask(() => {
			if (cache.get(db)?.value === value) cache.delete(db);
		});
		return value;
	};
}

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
	/** The router package's embedding of what it routes (spec router-package-integration 2026-11-04 §1 #5). */
	embedRouter?: ToolchainRoutingPort["embedRouter"],
): ToolchainRoutingPort {
	/** An adapter's availability does not depend on the toolchain bound to it: asked once per adapter in a pass. */
	const adapterAvailability = perPass(() => new Map<string, boolean>());
	const toolchains = perPass((db) => capabilities.toolchainsInTransaction(db));
	/** Every active toolchain as a card, in search order: what `cardInTransaction` picks one revision from. */
	const allCards = perPass((db) =>
		capabilities.toolchainCandidatesInTransaction(db, {
			text: "",
			// Preserve redirect identities; only the exact revision asked for is returned and enriched.
			available: () => true,
			// A work names its own revision, selectable or not.
			unselectable: true,
		}),
	);
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
		const adapterRef = bound.binding.document.adapterRef;
		const adapter = registry.get(adapterRef);
		let available = false;
		if (adapter) {
			const known = adapterAvailability(db);
			const cached = known.get(adapterRef);
			available = cached ?? adapter.availableInTransaction(db);
			if (cached === undefined) known.set(adapterRef, available);
		}
		return {
			execution: bound.binding.document.execution,
			binding: {
				bindingRevisionId: bound.binding.revisionId,
				adapterRef,
				...(bound.artifact
					? { artifactRevisionId: bound.artifact.revisionId }
					: {}),
				available,
			},
		};
	}
	const catalog = perPass((db) =>
		toolchains(db).flatMap((d) => {
			const runtime = runtimeInTransaction(db, d);
			return runtime
				? [
						{
							id: d.id,
							revisionId: d.revisionId,
							runtime,
							...(d.selectable === false ? { selectable: false as const } : {}),
						},
					]
				: [];
		}),
	);
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
	const instant = createInstantRouting({
		capabilities,
		registry,
		schemas,
		fallbackAvailable: (db, d) => {
			const runtime = runtimeInTransaction(db, d);
			return !!runtime && (!runtime.binding || runtime.binding.available);
		},
	});
	/** The card with the instant execution's typed arguments. */
	const enrich = (db: Database, card: Parameters<typeof instant.card>[1]) =>
		instant.card(db, card);
	const bound: BoundCommandPort = {
		snapshotInTransaction: (db, bindingRevisionId, context) =>
			adapterOf(db, bindingRevisionId).snapshotInTransaction(db, context),
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
		taskInTransaction: (db, revisionId) =>
			registeredTask(capabilities, registry, db, revisionId),
		cardInTransaction(db, revisionId) {
			const d = toolchains(db).find((d) => d.revisionId === revisionId);
			if (!d) return undefined;
			const runtime = runtimeInTransaction(db, d);
			if (!runtime || (runtime.binding && !runtime.binding.available))
				return undefined;
			const card = allCards(db).find((c) => c.revisionId === revisionId);
			return card ? enrich(db, card)[0] : undefined;
		},
		routeInTransaction(db, input) {
			// The router's offer (the eumenes_router package searched already): those cards, no search of ours.
			if (input.ids)
				return {
					cards: capabilities
						.toolchainCandidatesInTransaction(db, {
							text: "",
							available: (id) => input.available.has(id),
							ids: input.ids,
						})
						.flatMap((card) => enrich(db, card)),
					past: [],
					// The package's retrieval is lexical and by embedding.
					retrieval: "hybrid",
				};
			const active = capabilities
				.toolchainsInTransaction(db)
				.filter((d) => d.selectable !== false && input.available.has(d.id));
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
				strict: input.strict,
				lexicalFallback: input.lexicalFallback,
				// A task's search fills each kind's slots.
				...(input.strict ? { slots: true as const } : {}),
			});
			const offered = cards.flatMap((card) => enrich(db, card));
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
		catalogInTransaction: (db) => [...catalog(db)],
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
					tools: boundTools(db, set, doc.tools, schemas),
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
				tools: boundTools(db, set, doc.tools, schemas),
				targetSchemaRef: doc.session.targetSchemaRef ?? null,
				timeLimits: doc.timeLimits ?? null,
				agent: agentOf(doc.agent, () => adapter.describe().workspaces),
			};
		},
		bound,
		instantInTransaction: instant.run,
		recordSelectionInTransaction: history.recordSelectionInTransaction,
		// The router's traces and the user's corrections (spec toolchain-router-redesign 2026-11-01 §5.3).
		recordRouterTraceInTransaction: history.recordRouterTraceInTransaction,
		linkRouterWorkInTransaction: history.linkRouterWorkInTransaction,
		latestRouterTraceInTransaction: history.latestRouterTraceInTransaction,
		recordRouterFeedbackInTransaction:
			history.recordRouterFeedbackInTransaction,
		nearRouterFeedbackInTransaction: history.nearRouterFeedbackInTransaction,
		setRouterFeedbackStateInTransaction:
			history.setRouterFeedbackStateInTransaction,
		// The router package's tables and its embedding (spec router-package-integration 2026-11-04 §1).
		...(embedRouter ? { embedRouter } : {}),
		routerCardsInTransaction: history.routerCardsInTransaction,
		routerLexicalInTransaction: history.routerLexicalInTransaction,
		routerModelInTransaction: history.routerModelInTransaction,
		titlesInTransaction(db, ids) {
			const wanted = new Set(ids);
			return new Map(
				[
					...capabilities
						.toolchainsInTransaction(db)
						.map((d) => [d.id, d.title] as const),
					...READ_TOOLS.map((tool) => [tool.name, tool.title] as const),
				].filter(([id]) => wanted.has(id)),
			);
		},
		linkTaskInTransaction: history.linkTaskInTransaction,
		settleSelectionInTransaction: history.settleSelectionInTransaction,
		requestOfRunInTransaction: history.requestOfRunInTransaction,
		usageOfRunInTransaction: history.usageOfRunInTransaction,
	};
}

/** The binding's tools with the package tool's id and summary and the flat JSON schema. */
function boundTools(
	db: Database,
	set: ReturnType<Capabilities["toolchainSetInTransaction"]>,
	tools: BindingV1["tools"],
	schemas: SchemaProvider,
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

/**
 * The binding's agent settings as the specialist runs them. The work document is the adapter's own
 * declaration; one it does not declare makes the toolchain unusable (registration refuses it too).
 */
function agentOf(
	agent: AgentV1 | undefined,
	/** Read only for a binding that names a work document. */
	workspaces: () =>
		ReadonlyMap<string, { path: string; mediaType: string }> | undefined,
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
		...(agent?.collaborationState
			? { collaborationState: agent.collaborationState }
			: {}),
		...(agent?.larmReasoning ? { larmReasoning: agent.larmReasoning } : {}),
		...(agent?.turn?.maxModelCalls !== undefined
			? { maxModelCalls: agent.turn.maxModelCalls }
			: {}),
		...(agent?.turn?.maxOutputTokens !== undefined
			? { maxOutputTokens: agent.turn.maxOutputTokens }
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

/** Retained task owners remain reachable for cancellation and erasure after disablement. */
function registeredTask(
	capabilities: Capabilities,
	registry: AdapterRegistry,
	db: Database,
	revisionId: string,
): ReturnType<NonNullable<ToolchainRoutingPort["taskInTransaction"]>> {
	const boundTask = capabilities.toolchainBindingInTransaction(db, revisionId, {
		retained: true,
	});
	if (boundTask?.binding.document.execution !== "task") return undefined;
	const adapter = registry.get(boundTask.binding.document.adapterRef);
	const task = adapter?.task;
	if (!task) throw new Error("task_lifecycle_unavailable");
	return {
		...task,
		startInTransaction(tx, input) {
			if (!adapter?.availableInTransaction(tx))
				throw new Error("adapter_unavailable");
			return task.startInTransaction(tx, {
				...input,
				toolchainRevisionId: revisionId,
				bindingRevisionId: boundTask.binding.revisionId,
			});
		},
	};
}
