/**
 * What the pieces of a session share: the services, the stand-ins for the ports the case decides, the clock-free
 * counters that make ids deterministic, and the table of `@key` references.
 */
import type { Database } from "bun:sqlite";
import { jstSeconds } from "../../../../infrastructure/jst-time";
import type { ToolchainCard } from "../../../capabilities";
import type { InferencePort } from "../../../inference";
import type { QueueService } from "../../../queue";
import type { ContextGoalEntry } from "../../contracts";
import type { DialogueDeps } from "../../service/context";
import { createPrepare } from "../../service/generation-prepare";
import { createWorkLedger } from "../../service/work-ledger";
import { evalConversationAgent } from "./conversation-agent";
import type { EvalCard, Persona, SeedWiring } from "./session-types";

const REF = /^@([A-Za-z0-9_-]+)$/;

function cardOf(
	catalog: readonly EvalCard[],
	revisionId: string,
): ToolchainCard {
	const id = revisionId.replace(/^rev-/, "");
	const found = catalog.find((card) => card.id === id);
	return {
		revisionId,
		id,
		functionName: id,
		title: found?.title ?? id,
		summary: found?.summary ?? id,
		useWhen: found?.useWhen ?? [],
		redirects: [],
		score: { rank: 1, ftsRank: null, similarity: null, fromHistory: false },
	};
}

export function createSessionContext(
	wiring: SeedWiring,
	options: { catalog?: readonly EvalCard[] },
) {
	const { store, conversation, continuity, memory } = wiring;
	const catalog = options.catalog ?? [];
	const ports = {
		modelWindow: null as number | null,
		persona: {
			agentName: "",
			userName: "",
			persona: "butler",
		} as Persona,
		goals: [] as ContextGoalEntry[],
		worldNames: [] as string[],
		interests: [] as string[],
	};
	let ids = 0;
	let messages = 0;
	let runs = 0;
	const uuid = () =>
		`00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
	/** `@key` of a seeded event or TODO -> the id the services gave it. */
	const refs = new Map<string, string>();
	const resolve = (value: unknown): unknown => {
		if (typeof value === "string") {
			const key = REF.exec(value)?.[1];
			if (key === undefined) return value;
			const id = refs.get(key);
			if (id === undefined) throw new Error(`context_eval_unknown_ref:${key}`);
			return id;
		}
		if (Array.isArray(value)) return value.map(resolve);
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, resolve(v)]),
			);
		return value;
	};
	const larm = {
		requestFor: () => "eval-request",
		llmContextWindowInTransaction: () => ports.modelWindow,
		setContextPolicyInTransaction: () => {},
		snapshotInTransaction: () => ({ general: ports.persona }),
	} as unknown as InferencePort;
	const deps: DialogueDeps = {
		store,
		conversation,
		larm,
		queue: {} as QueueService,
		clock: () => wiring.now(),
		id: uuid,
		continuity,
		memory,
		toolchains: {
			cardInTransaction: (_db: Database, revisionId: string) =>
				cardOf(catalog, revisionId),
		} as unknown as NonNullable<DialogueDeps["toolchains"]>,
		goals: {
			adoptedForContextInTransaction: () => ports.goals,
			existingInTransaction: () => new Set(ports.goals.map((g) => g.goalId)),
		},
		conversationAgent: evalConversationAgent,
		agency: {
			stateForContextInTransaction: () => ports.interests,
			workChangedInTransaction: () => {},
		},
		worldContext: {
			knownNamesInTransaction: () => ports.worldNames,
		},
	};
	const work = createWorkLedger(deps);
	deps.work = work;
	return {
		wiring,
		store,
		conversation,
		events: continuity.events,
		deps,
		work,
		ports,
		refs,
		resolve,
		prepare: createPrepare(deps)!,
		nextMessage: () => `m${++messages}`,
		nextRun: () => ++runs,
		jst: (iso: string) => jstSeconds(Date.parse(iso)),
	};
}
export type SessionContext = ReturnType<typeof createSessionContext>;
