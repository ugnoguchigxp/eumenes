/**
 * Seeds a case into the session's services and runs the production prepare for its turn. The result is the
 * generation the product would send: the messages, the window plan, the document and the window version.
 */
import { estimateTextTokens } from "../../../inference";
import { renderRecallBlock } from "../../../memory";
import type { GenerateInput } from "../../service/context";
import { type ContextCase, type Seed, seedEventsOf } from "./case-schema";
import { recallMinute } from "./recall-text";
import {
	CONVERSATION_ID,
	DEFAULT_START,
	type EvalCard,
	type Generated,
	type Session,
	SEED_SOURCE_MESSAGE,
	type SeedWiring,
	createSession,
} from "./session";

export { CONVERSATION_ID, type SeedWiring } from "./session";

export type Materialized = {
	case: ContextCase;
	runId: string;
	input: GenerateInput;
	reconstruction: Generated["reconstruction"];
	/** Releases the temp store. */
	close(): Promise<void>;
};

/** The time of the generation: just after the newest thing the seed records. */
export function generationTime(seed: Seed): string {
	const times = [
		...seedEventsOf(seed).map((e) => e.at),
		...(seed.pending ?? []).map((p) => p.at),
		...(seed.work ?? []).flatMap((w) => [w.at, w.updatedAt ?? w.at]),
		...(seed.recall ?? []).map((r) => r.at),
	].map((time) => Date.parse(time));
	const newest = times.length ? Math.max(...times) : Date.parse(DEFAULT_START);
	return new Date(newest + 1000).toISOString();
}

/** The user message every State item stands on, written once. */
async function ensureSeedSource(session: Session, now: string) {
	const { store, conversation } = session.wiring;
	await store.write((db) => {
		if (!conversation.messageInTransaction(db, SEED_SOURCE_MESSAGE))
			conversation.appendInTransaction(db, {
				id: SEED_SOURCE_MESSAGE,
				conversationId: CONVERSATION_ID,
				role: "user",
				text: "覚えておいてください",
				createdAt: now,
				runId: null,
			});
	});
}

/** Saves State items through the steward's curation contract (as requests the user made); returns their ids by key. */
export async function saveLongTerm(
	session: Session,
	items: readonly NonNullable<Seed["longTerm"]>[number][],
	now: string,
): Promise<Map<string, string>> {
	const { wiring } = session;
	const { store, memory } = wiring;
	wiring.setNow(now);
	await ensureSeedSource(session, now);
	const ids = new Map<string, string>();
	for (const item of items)
		await store.write((db) => {
			const [result] = memory.applyCurationInTransaction(db, {
				conversationId: CONVERSATION_ID,
				items: [
					{
						op: "remember",
						kind: item.kind,
						key: item.key,
						text: item.text,
						messageId: SEED_SOURCE_MESSAGE,
						quote: item.quote ?? null,
						...(item.validFrom ? { validFrom: item.validFrom } : {}),
						...(item.validUntil ? { validUntil: item.validUntil } : {}),
						explicit: true,
					},
				],
			});
			if (!result || result.status !== "applied" || !result.id)
				throw new Error(`context_eval_seed_item_rejected:${item.key}`);
			ids.set(item.key, result.id);
		});
	return ids;
}

/**
 * Notices and the recalled exchanges travel in the window the way the memory step publishes them. The recall is
 * seeded as the prefetch text directly: there are no embeddings offline (see recall-text.ts). A step replaces the
 * prefetch.
 */
export async function publishStep(
	session: Session,
	step: {
		notices?: readonly string[] | undefined;
		recall?: Seed["recall"];
		/** The steward asks for the profile to be republished at the next re-construction (it took in new State). */
		requestRepublish?: boolean;
	},
	now: string,
) {
	const { wiring } = session;
	wiring.setNow(now);
	const recalled = (step.recall ?? []).map((entry) => ({
		at: recallMinute(entry.at),
		...(entry.user === undefined ? {} : { user: entry.user }),
		...(entry.assistant === undefined ? {} : { assistant: entry.assistant }),
	}));
	const recallText = recalled.length ? renderRecallBlock(recalled) : "";
	if (recallText || step.notices?.length || step.requestRepublish)
		await wiring.store.write((db) =>
			wiring.memory.publishWindowInTransaction(db, CONVERSATION_ID, {
				...(step.requestRepublish ? { requestRepublish: true } : {}),
				...(step.notices?.length ? { addNotices: [...step.notices] } : {}),
				...(recallText
					? {
							prefetch: {
								text: recallText,
								pins: [],
								tokens: estimateTextTokens(recallText),
							},
						}
					: {}),
			}),
		);
}

/** Writes the seed's State, the notes and the memory step's publications. */
async function applyMemorySeed(session: Session, seed: Seed, now: string) {
	const { wiring } = session;
	const { store, memory } = wiring;
	const items = seed.longTerm ?? [];
	const ids = await saveLongTerm(
		session,
		items.filter((i) => i.published),
		now,
	);
	for (const tendency of seed.tendencies ?? [])
		await store.write((db) => {
			const [result] = memory.applyCurationInTransaction(db, {
				conversationId: CONVERSATION_ID,
				items: [
					{
						op: "tendency_add",
						text: tendency.text,
						evidence: tendency.from.map((key) => ({
							namespace: "state" as const,
							id: ids.get(key)!,
						})),
					},
				],
			});
			if (!result || result.status !== "applied")
				throw new Error(
					`context_eval_seed_tendency_rejected:${JSON.stringify(result)}`,
				);
		});
	// The profile is published once; what is saved after waits in `state.newMemories` (section 5.4).
	await store.write((db) =>
		memory.republishWindowInTransaction(db, CONVERSATION_ID),
	);
	await saveLongTerm(
		session,
		items.filter((i) => !i.published),
		now,
	);
	// Notes carry the time they were added; one millisecond apart keeps their order the seed's.
	for (const [index, note] of (seed.notes ?? []).entries()) {
		wiring.setNow(new Date(Date.parse(now) + index).toISOString());
		await store.write((db) =>
			wiring.continuity.addByAgentInTransaction(db, CONVERSATION_ID, {
				kind: note.kind,
				text: note.text,
				sourceMessageIds: ["note-source"],
			}),
		);
	}
	await publishStep(
		session,
		{ notices: seed.notices, recall: seed.recall },
		now,
	);
}

/** The seed's ports and its history: work first (events refer to it), then the episode, then the log. */
export async function applySeed(session: Session, seed: Seed, now: string) {
	session.ports.modelWindow = seed.modelWindow ?? null;
	if (seed.persona) session.ports.persona = seed.persona;
	session.ports.goals = (seed.goals ?? []).map((goal, index) => ({
		goalId: `goal-${index + 1}`,
		priority: goal.priority,
		desiredState: goal.text,
		revision: 1,
	}));
	session.ports.worldNames = (seed.world ?? []).map((target) => target.name);
	session.ports.interests = seed.agencyInterests ?? [];
	await applyMemorySeed(session, seed, now);
	for (const work of seed.work ?? []) await session.addWork(work);
	await session.appendEpisode(seed.episode ?? []);
	await session.appendEvents(seed.events ?? []);
	for (const confirmation of seed.confirmations ?? [])
		await session.addConfirmation(confirmation, now);
	session.wiring.setNow(now);
}

/** Materializes `testCase` into `wiring` and prepares its generation; the caller closes the result. */
export async function materialize(
	testCase: ContextCase,
	wiring: SeedWiring,
	options: { catalog?: readonly EvalCard[] } = {},
): Promise<Materialized> {
	try {
		const session = createSession(wiring, options);
		const now = generationTime(testCase.seed);
		await applySeed(session, testCase.seed, now);
		const generated = await session.generate({
			at: now,
			utterance: testCase.input,
			...(testCase.trigger
				? {
						trigger: session.resolve(testCase.trigger) as Record<
							string,
							unknown
						>,
					}
				: {}),
			...(testCase.seed.pending ? { pending: testCase.seed.pending } : {}),
		});
		return {
			case: testCase,
			runId: generated.runId,
			input: generated.input,
			reconstruction: generated.reconstruction,
			close: () => wiring.close(),
		};
	} catch (error) {
		await wiring.close().catch(() => {});
		throw error;
	}
}
