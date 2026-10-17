/**
 * Seed materializer: builds the real ContextWindow inputs for a case on a temp SQLite store with the real
 * conversation and memory services, then runs the CURRENT production `compileContext` on it.
 * Offline evaluation only. The store wiring (which needs domains below dialogue's own dependencies) is injected.
 */
import type { SqliteStore } from "../../../../infrastructure/sqlite";
import type { ConversationService } from "../../../conversation";
import type { MemoryService, WindowSnapshot } from "../../../memory";
import type { ContextGoalEntry, Run } from "../../contracts";
import { insert } from "../../repository";
import type { ChatMessage } from "../../service/context";
import { compileContext } from "../../service/context-compiler";
import { renderGoalsLayer } from "../../service/goals-layer";
import { worldNamesHint } from "../../service/topic-texts";
import type { ContextCase, Seed } from "./case-schema";

export const CONVERSATION_ID = "main";
const SEED_SOURCE_MESSAGE = "seed-source";

/** What the materializer needs from the host: a real store and services. */
export interface SeedWiring {
	store: SqliteStore;
	conversation: ConversationService;
	memory: MemoryService;
	saveItem(input: {
		conversationId: string;
		messageId: string;
		quote: string | null;
		kind: "preference" | "personal_fact" | "constraint" | "habit";
		semanticKey: string;
		text: string;
		validFrom?: string;
		validUntil?: string;
	}): Promise<unknown>;
	addNote(
		conversationId: string,
		input: {
			kind: "goal" | "decision" | "open_question" | "activity" | "memo";
			text: string;
		},
	): Promise<unknown>;
	close(): Promise<void>;
}

type General = Parameters<typeof compileContext>[3];
type Compiled = ReturnType<typeof compileContext>;

/** Seed parts the baseline arm cannot show yet; they travel as data so a later renderer can place them. */
export type CarriedSeed = Pick<
	Seed,
	"operation" | "research" | "specialist" | "recall"
>;

export type Materialized = {
	case: ContextCase;
	runId: string;
	/** The result of the current production `compileContext` on the seeded store. */
	compiled: Compiled;
	/** The goals layer message exactly as generation-prepare derives it from the adopted goals, or null. */
	goalsLayer: ChatMessage | null;
	/** The World name hint line, or null. */
	worldHint: ChatMessage | null;
	window: WindowSnapshot | null;
	general: General;
	carried: CarriedSeed;
	/** Releases the temp store. */
	close(): Promise<void>;
};

const at = (iso: string | undefined) => iso ?? "2026-10-13T00:00:00.000Z";

async function appendExchange(
	wiring: SeedWiring,
	n: number,
	exchange: {
		user: string;
		assistant?: string | undefined;
		at: string;
	},
) {
	const { store, conversation, memory } = wiring;
	const runId = `r${n}`;
	await store.write((db) => {
		conversation.appendInTransaction(db, {
			id: `u${n}`,
			conversationId: CONVERSATION_ID,
			role: "user",
			text: exchange.user,
			createdAt: exchange.at,
			runId,
		});
		if (exchange.assistant !== undefined)
			conversation.appendInTransaction(db, {
				id: `a${n}`,
				conversationId: CONVERSATION_ID,
				role: "assistant",
				text: exchange.assistant,
				createdAt: exchange.at,
				runId,
			});
		insert(db, runRow(runId, n, exchange.at, exchange.assistant !== undefined));
		memory.recordExchangeInTransaction(db, {
			conversationId: CONVERSATION_ID,
			runId,
			inputMessageId: `u${n}`,
			answerMessageId: exchange.assistant !== undefined ? `a${n}` : null,
			outcome: exchange.assistant !== undefined ? "answered" : "failed",
		});
	});
	return {
		input: `u${n}`,
		answer: exchange.assistant !== undefined ? `a${n}` : null,
	};
}

function runRow(id: string, n: number, time: string, completed: boolean): Run {
	return {
		id,
		agentTaskId: null,
		specialistSessionId: null,
		requestId: `req${n}`,
		conversationId: CONVERSATION_ID,
		utteranceId: null,
		status: completed ? "completed" : "running",
		revision: 1,
		inputMessageId: `u${n}`,
		answerMessageId: completed ? `a${n}` : null,
		error: null,
		jobId: null,
		deadlineAt: null,
		sourceKind: "manual",
		scheduleId: null,
		occurrenceId: null,
		createdAt: time,
		updatedAt: time,
	} as Run;
}

const dispose = (
	wiring: SeedWiring,
	inputMessageId: string,
	disposition: "keep" | "summarize" | "drop",
) =>
	wiring.store.write((db) => {
		wiring.memory.setDispositionInTransaction(db, inputMessageId, disposition);
		for (const step of ["curated", "disposed"] as const)
			wiring.memory.markExchangeStepInTransaction(
				db,
				inputMessageId,
				step,
				"done",
			);
	});

/**
 * Seeds `testCase` into the wiring's store and compiles the context of its current turn.
 * The caller closes the result (which closes the wiring).
 */
async function seedAndCompile(
	testCase: ContextCase,
	wiring: SeedWiring,
): Promise<Materialized> {
	const { store, conversation, memory, saveItem, addNote } = wiring;
	const seed = testCase.seed;
	const base = at(seed.exchanges?.[0]?.at);
	const ids: Array<{ layer: string; input: string }> = [];
	let n = 0;
	for (const exchange of seed.exchanges ?? []) {
		const made = await appendExchange(wiring, ++n, exchange);
		ids.push({ layer: exchange.layer, input: made.input });
		if (exchange.layer === "keep") await dispose(wiring, made.input, "keep");
	}
	// Source message for the memory items: a message of the conversation that no run owns, so no history shows it.
	await store.write((db) =>
		conversation.appendInTransaction(db, {
			id: SEED_SOURCE_MESSAGE,
			conversationId: CONVERSATION_ID,
			role: "user",
			text: "覚えておいてください",
			createdAt: base,
			runId: null,
		}),
	);
	for (const item of seed.longTerm ?? [])
		await saveItem({
			conversationId: CONVERSATION_ID,
			messageId: SEED_SOURCE_MESSAGE,
			quote: item.quote ?? null,
			kind: item.kind,
			semanticKey: item.key,
			text: item.text,
			...(item.validFrom ? { validFrom: item.validFrom } : {}),
			...(item.validUntil ? { validUntil: item.validUntil } : {}),
		});
	if (seed.longTerm?.length)
		await store.write((db) =>
			memory.publishWindowInTransaction(db, CONVERSATION_ID, {
				republishLongTerm: true,
			}),
		);
	for (const note of seed.notes ?? [])
		await addNote(CONVERSATION_ID, { kind: note.kind, text: note.text });
	if (seed.summary) {
		const covered = ids
			.filter((e) => e.layer === "summarized")
			.map((e) => e.input);
		const written = await store.write((db) =>
			memory.writeSummaryInTransaction(db, {
				conversationId: CONVERSATION_ID,
				text: seed.summary!.text,
				included: covered,
				expectedRevision: 0,
			}),
		);
		if (!written.ok) throw new Error(`seed_summary_rejected:${written.reason}`);
	}
	const window = await store.write((db) =>
		memory.publishWindowInTransaction(
			db,
			CONVERSATION_ID,
			seed.notices?.length ? { addNotices: seed.notices } : {},
		),
	);

	// The current turn: the last message, with its run still running.
	const current = ++n;
	const now = at(seed.exchanges?.at(-1)?.at ?? base);
	await store.write((db) => {
		conversation.appendInTransaction(db, {
			id: `u${current}`,
			conversationId: CONVERSATION_ID,
			role: "user",
			text: testCase.input,
			createdAt: now,
			runId: `r${current}`,
		});
		insert(db, runRow(`r${current}`, current, now, false));
	});

	const goals: ContextGoalEntry[] = (seed.goals ?? []).map((goal, index) => ({
		goalId: `goal-${index + 1}`,
		priority: goal.priority,
		desiredState: goal.text,
		revision: 1,
	}));
	const goalsLayer = renderGoalsLayer(goals)?.message ?? null;
	const general: General = seed.persona ?? {
		agentName: "",
		userName: "",
		persona: "butler",
	};
	const compiled = await store.write((db) =>
		compileContext(
			db,
			{
				id: `r${current}`,
				conversationId: CONVERSATION_ID,
				inputMessageId: `u${current}`,
			} as Run,
			conversation,
			general,
			memory.windowForRunInTransaction(db, CONVERSATION_ID) ?? window,
			memory,
			goalsLayer,
		),
	);
	return {
		case: testCase,
		runId: `r${current}`,
		compiled,
		goalsLayer,
		worldHint: worldNamesHint((seed.world ?? []).map((t) => t.name)),
		window,
		general,
		carried: {
			...(seed.operation ? { operation: seed.operation } : {}),
			...(seed.research ? { research: seed.research } : {}),
			...(seed.specialist ? { specialist: seed.specialist } : {}),
			...(seed.recall ? { recall: seed.recall } : {}),
		},
		close: () => wiring.close(),
	};
}

/** Materializes `testCase`; if seeding or compiling throws, the store is closed before the error propagates. */
export async function materialize(
	testCase: ContextCase,
	wiring: SeedWiring,
): Promise<Materialized> {
	try {
		return await seedAndCompile(testCase, wiring);
	} catch (error) {
		await wiring.close().catch(() => {});
		throw error;
	}
}
