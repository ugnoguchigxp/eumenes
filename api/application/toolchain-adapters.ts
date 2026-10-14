import type { Database } from "bun:sqlite";
import type { ZodType } from "zod";
import {
	validators,
	type BundleHost,
	type Capabilities,
	type SchemaKey,
} from "../domains/capabilities";
import type {
	ActionAdapter,
	AdapterRegistry,
	DomainAdapter,
} from "../domains/tool-runtime";
import type { AgentRuntime } from "../domains/agent-runtime";
import { readActionOriginInTransaction } from "../domains/dialogue";
import {
	describeTimerAdapter,
	TIMER_ADAPTER_REF,
	timerDomainSchemas,
} from "./timer-adapter";
import {
	describeTtsDictionaryAdapter,
	TTS_DICTIONARY_ADAPTER_REF,
} from "./tts-dictionary-adapter";
import { describeDotsAdapter, DOTS_ADAPTER_REF } from "./dots-adapter";
import { describeMemoryAdapter, MEMORY_ADAPTER_REF } from "./memory-adapter";
import { describeWorldAdapter, WORLD_ADAPTER_REF } from "./world-adapter";
import {
	describeServiceTestsAdapter,
	SERVICE_TESTS_ADAPTER_REF,
} from "./service-tests-adapter";
import {
	describeSettingsAdapter,
	SETTINGS_ADAPTER_REF,
} from "./settings-adapter";
import { describeRecordsAdapter, RECORDS_ADAPTER_REF } from "./records-adapter";
import {
	describeInferenceAdapter,
	INFERENCE_ADAPTER_REF,
} from "./inference-adapter";
import {
	describeMusicScreenAdapter,
	MUSIC_SCREEN_ADAPTER_REF,
} from "./music-screen-adapter";
import {
	describeImageScreenAdapter,
	IMAGE_SCREEN_ADAPTER_REF,
} from "./image-screen-adapter";

/** `domain:` result schemas registered by the host's adapters. */
const domainSchemas: Readonly<Record<string, ZodType>> = {
	...timerDomainSchemas,
};

/** What this host can execute, for checking bundles before they are registered. */
export function bundleHostOf(
	registry:
		| Pick<AdapterRegistry, "all">
		| Array<Pick<DomainAdapter, "ref" | "describe">>,
): BundleHost {
	const adapters = (Array.isArray(registry) ? registry : registry.all()).map(
		(a) => [a, a.describe()] as const,
	);
	return {
		adapters: new Map(
			adapters.map(([a, d]) => [
				a.ref,
				{
					operations: d.operations,
					queries: d.queries,
					documents: d.documents,
					conditions: d.conditions,
					structures: d.structures,
				},
			]),
		),
		availability: new Set(adapters.map(([, d]) => d.availability)),
		inputAdapters: new Set(
			adapters.flatMap(([, d]) => [...d.inputAdapters.keys()]),
		),
		projections: new Set(adapters.flatMap(([, d]) => [...d.projections])),
		domainSchemas: new Set(Object.keys(domainSchemas)),
		connections: new Set(),
	};
}

/**
 * What every adapter this host can register offers, without its domain service. Used where
 * bundles are checked or registered without running the domains (evaluation, bundle tooling).
 * A new domain adapter adds one entry here and one to the registry in `toolchain.ts`.
 */
export const hostAdapterDescriptions: Array<
	Pick<DomainAdapter, "ref" | "describe">
> = [
	{ ref: TIMER_ADAPTER_REF, describe: describeTimerAdapter },
	{ ref: SETTINGS_ADAPTER_REF, describe: describeSettingsAdapter },
	{ ref: RECORDS_ADAPTER_REF, describe: describeRecordsAdapter },
	{ ref: INFERENCE_ADAPTER_REF, describe: describeInferenceAdapter },
	{ ref: MUSIC_SCREEN_ADAPTER_REF, describe: describeMusicScreenAdapter },
	{ ref: IMAGE_SCREEN_ADAPTER_REF, describe: describeImageScreenAdapter },
	{ ref: TTS_DICTIONARY_ADAPTER_REF, describe: describeTtsDictionaryAdapter },
	{ ref: MEMORY_ADAPTER_REF, describe: describeMemoryAdapter },
	{ ref: WORLD_ADAPTER_REF, describe: describeWorldAdapter },
	{ ref: SERVICE_TESTS_ADAPTER_REF, describe: describeServiceTestsAdapter },
	{ ref: DOTS_ADAPTER_REF, describe: describeDotsAdapter },
];

/** The bundle host as if every adapter were registered (see `hostAdapterDescriptions`). */
export const offlineBundleHost = () => bundleHostOf(hostAdapterDescriptions);

/**
 * Registered schemas by reference: repository validators (`builtin:`), host domain schemas
 * (`domain:`) and bundle JSON Schemas (`schema:`, read from capabilities once and cached; a
 * stored schema revision never changes).
 */
export function createSchemaProvider(capabilities: Capabilities) {
	const bundled = new Map<string, ZodType>();
	function cached(ref: string): ZodType | undefined {
		if (ref.startsWith("builtin:")) {
			const key = ref.slice(8);
			return Object.hasOwn(validators, key)
				? (validators[key as SchemaKey] as ZodType)
				: undefined;
		}
		if (ref.startsWith("domain:"))
			return Object.hasOwn(domainSchemas, ref) ? domainSchemas[ref] : undefined;
		return bundled.get(ref);
	}
	return {
		/** A schema the caller already loaded (builtin/domain always; bundle after `load`). */
		get: cached,
		/** Resolve within a transaction, loading bundle schemas on first use. */
		resolveInTransaction(db: Database, ref: string): ZodType | undefined {
			const known = cached(ref);
			if (known || !ref.startsWith("schema:")) return known;
			const schema = capabilities.schemaInTransaction(
				db,
				ref,
			) as ZodType | null;
			if (schema) bundled.set(ref, schema);
			return schema ?? undefined;
		},
	};
}
export type SchemaProvider = ReturnType<typeof createSchemaProvider>;

/**
 * The conversation's local actions: the agent runtime's verified tool execution reaches the
 * binding's adapter. The saved human origin of the run is checked here, never taken from input.
 */
export function createRegistryActions(
	registry: AdapterRegistry,
	agents: () => AgentRuntime,
): ActionAdapter {
	const adapterOf = (ref: string): DomainAdapter => {
		const adapter = registry.get(ref);
		if (!adapter) throw new Error("capability_unavailable");
		return adapter;
	};
	return {
		executeInTransaction(db, request) {
			agents().validateActionOwnerInTransaction(db, request.owner);
			const [runId, epoch] = request.originToken.split(":");
			if (
				runId !== request.owner.rootRunId ||
				Number(epoch) !== request.owner.cancelEpoch
			)
				throw new Error("origin_invalid");
			const source = readActionOriginInTransaction(db, runId!);
			if (!source || source.taskId !== request.owner.taskId)
				throw new Error("origin_invalid");
			const adapter = adapterOf(request.adapterRef);
			if (!adapter.describe().operations.has(request.operationName))
				throw new Error("capability_unavailable");
			const saved = adapter.invokeInTransaction(db, {
				operationName: request.operationName,
				input: request.arguments,
				requestId: request.requestId,
				issuedAt: request.issuedAt,
				origin: {
					kind: "conversation",
					owner: request.owner,
					runId: request.owner.rootRunId,
					conversationId: source.conversationId,
					messageId: source.messageId,
				},
			});
			return {
				kind: "local_action",
				adapterRef: adapter.ref,
				version: 1,
				operationId: saved.receiptRef.operationId,
				receiptDigest: saved.receiptRef.digest,
				payload: saved.receipt,
				answerContext: saved.answerContext,
			};
		},
		readInTransaction(db, operationId, _owner, adapterRef) {
			const saved = adapterOf(adapterRef).readInTransaction(db, operationId);
			if (!saved) return null;
			return {
				kind: "local_action",
				adapterRef,
				version: 1,
				operationId: saved.receiptRef.operationId,
				receiptDigest: saved.receiptRef.digest,
				payload: saved.receipt,
				answerContext: saved.answerContext,
			};
		},
	};
}

/**
 * The timer question source reads dialogue's open interaction lazily: the dialogue service is
 * assembled after the toolchain.
 */
export type InteractionViews = {
	viewInTransaction(
		db: Database,
		id: string,
	): { revision: number; status: string; question: unknown } | null;
};
export function questionReader(
	interactions: () => InteractionViews | undefined,
) {
	return () => {
		const current = interactions();
		return (
			current && {
				questionInTransaction(db: Database, id: string) {
					const view = current.viewInTransaction(db, id);
					// Only the question part leaves: not the chain, conversation or receipt refs.
					return view?.question
						? {
								revision: view.revision,
								data: { status: view.status, question: view.question },
							}
						: null;
				},
			}
		);
	};
}

/** Periodic retention of interaction bodies and UI action acceptances (30 + 30 days). */
export function toolchainMaintenance(
	s: {
		dialogue: { interactions: { maintenance(): Promise<unknown> } };
		toolchain: { actionRequests: { maintenance(): Promise<unknown> } };
	},
	log: {
		warn(event: string, fields: { reason: string }, error?: unknown): void;
	},
) {
	const run = (name: string, target: { maintenance(): Promise<unknown> }) =>
		target
			.maintenance()
			.catch((error) =>
				log.warn(
					`${name}.maintenance_failed`,
					{ reason: "maintenance_failed" },
					error,
				),
			);
	return [
		run("toolchain_interactions", s.dialogue.interactions),
		run("toolchain_actions", s.toolchain.actionRequests),
	];
}
