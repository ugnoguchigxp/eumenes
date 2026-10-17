import type { SqliteStore } from "../../../../infrastructure/sqlite";
import type { ConversationService } from "../../../conversation";
import type { MemoryService, WindowSnapshot } from "../../../memory";
import type { ContextBlock } from "../../../inference";
import type { ContextGoalEntry, Run } from "../../contracts";
import { insert } from "../../repository";
import type { ContextAssembly } from "../../service/context-assembly";
import {
	hostTextBlock,
	operationBlock,
	researchFailureBlock,
	researchResultBlock,
	specialistBlock,
	type OperationSource,
} from "../../service/context-blocks";
import { compileAssembly } from "../../service/context-compiler";
import { renderGoalsLayer } from "../../service/goals-layer";
import { worldNamesHint } from "../../service/topic-texts";
import type { ContextCase, Seed } from "./case-schema";
import { recallBlockText, recallMinute } from "./recall-text";

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

export type Materialized = {
	case: ContextCase;
	runId: string;
	/** The product assembly of this turn: every arm renders this same content. */
	assembly: ContextAssembly;
	/** Every message the prompt shows verbatim, this input included. */
	shownMessageIds: string[];
	window: WindowSnapshot | null;
	/** Releases the temp store. */
	close(): Promise<void>;
};

export const at = (iso: string | undefined) => iso ?? "2026-10-13T00:00:00.000Z";

export async function appendExchange(
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

export function runRow(id: string, n: number, time: string, completed: boolean): Run {
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

export const dispose = (
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
 * Seeds `testCase` into the wiring's store and assembles the context of its current turn.
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
	// Notices and the recalled exchanges travel in the window the way the memory step publishes them. The recall
	// is seeded as the prefetch text directly: there are no embeddings offline (see recall-text.ts).
	const recalled = (seed.recall ?? []).map((entry) => ({
		at: recallMinute(entry.at),
		...(entry.user === undefined ? {} : { user: entry.user }),
		...(entry.assistant === undefined ? {} : { assistant: entry.assistant }),
	}));
	const recallText = recalled.length ? recallBlockText(recalled) : "";
	const window = await store.write((db) =>
		memory.publishWindowInTransaction(db, CONVERSATION_ID, {
			...(seed.notices?.length ? { addNotices: seed.notices } : {}),
			...(recallText
				? {
						prefetch: {
							text: recallText,
							pins: [],
							bytes: Buffer.byteLength(recallText),
						},
					}
				: {}),
		}),
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
	const run = {
		id: `r${current}`,
		conversationId: CONVERSATION_ID,
		inputMessageId: `u${current}`,
	} as Run;
	const compiled = await store.write((db) =>
		compileAssembly(
			db,
			run,
			conversation,
			seed.persona ?? { agentName: "", userName: "", persona: "butler" },
			memory.windowForRunInTransaction(db, CONVERSATION_ID) ?? window,
			memory,
			renderGoalsLayer(goals)?.block,
		),
	);
	const assembly = assembleVolatile(compiled.assembly, seed, Date.parse(now));
	return {
		case: testCase,
		runId: run.id,
		assembly,
		shownMessageIds: compiled.shownMessageIds,
		window,
		close: () => wiring.close(),
	};
}

const OPERATION_SOURCE: Record<
	NonNullable<Seed["operation"]>["kind"],
	OperationSource
> = {
	image: "operation.image",
	music: "operation.music",
	drawing: "operation.drawing",
	recognition: "operation.recognition",
	delegation: "operation.delegation",
};

/** The parts of a seed that make a turn's volatile blocks. */
export type VolatileSeed = Pick<
	Seed,
	"world" | "specialist" | "operation" | "research"
>;

/** The specialist records of a seed, as the blocks `specialistWorkBlock`, `viewingBlock` and the handoff make. */
function specialistBlocks(specialist: NonNullable<Seed["specialist"]>) {
	const blocks: ContextBlock[] = [];
	if (specialist.work)
		blocks.push(specialistBlock("specialist.work", specialist.work));
	if (specialist.viewing)
		blocks.push(specialistBlock("specialist.viewing", specialist.viewing));
	if (specialist.handoff)
		blocks.push(hostTextBlock("specialist.handoff", specialist.handoff));
	return blocks;
}

/**
 * What holds for this call only, in the order `createPrepare` shows it: the notices and the prefetch memory decided
 * (none for a failed research answer), the World names, the specialist records, the operation results, the
 * research report. A research answer has no specialist records; a failed one has no World names either. The block
 * builders are the product's; the sequence is `createPrepare`'s, which needs the full dependency set to run.
 */
export function assembleVolatile(
	compiled: ContextAssembly,
	seed: VolatileSeed,
	nowMs: number,
): ContextAssembly {
	const research = seed.research;
	const failed = research?.failureCode !== undefined;
	const worldHint = failed
		? null
		: worldNamesHint((seed.world ?? []).map((target) => target.name));
	const volatile: ContextBlock[] = [
		...(failed ? [] : compiled.volatile),
		...(worldHint ? [hostTextBlock("world.names", worldHint.content)] : []),
		...(research || !seed.specialist ? [] : specialistBlocks(seed.specialist)),
		...(seed.operation
			? [
					operationBlock(
						OPERATION_SOURCE[seed.operation.kind],
						seed.operation.result,
					),
				]
			: []),
		...(research
			? [
					failed
						? researchFailureBlock(
								research.failureCode!,
								research.projection === undefined
									? undefined
									: typeof research.projection === "string"
										? research.projection
										: JSON.stringify(research.projection),
								nowMs,
							)
						: researchResultBlock(research.projection ?? {}, nowMs),
				]
			: []),
	];
	return {
		...compiled,
		stage: research || seed.operation ? "result" : "initial",
		volatile,
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
