import type { StewardHarness } from "./steward.fixture";
import { setupSteward, topicEmbed } from "./steward.fixture";
import { readSleepState } from "../repository";
import type { MemoryPressure } from "../service/sleep/policy";

/** The harnesses of a sleep test file: its `afterEach` closes them. */
export const sleepHarnesses: StewardHarness[] = [];
export async function closeSleepHarnesses() {
	for (const h of sleepHarnesses.splice(0)) await h.close();
}
/** A steward with the sleep layer on and turns that can be embedded. `pressure` is what the memory reports to the steward: a test changes it. */
export async function setupSleep(
	options: Parameters<typeof setupSteward>[0] = {},
) {
	const pressure: MemoryPressure = { activeItems: 0, similarPairs: 0 };
	const h = await setupSteward({
		embed: topicEmbed,
		sleep: {},
		...options,
		wrapMemory: (memory) => {
			const wrapped = options.wrapMemory?.(memory) ?? memory;
			return {
				...wrapped,
				consolidationPressureInTransaction: () => ({ ...pressure }),
			};
		},
	});
	Object.assign(h, { pressure });
	sleepHarnesses.push(h);
	// The judge of duplicates finds none unless a test says otherwise.
	h.inference.answer("sleep", { groups: [] });
	// The conversation is known to the steward (a run of it ended).
	await h.kick("c1");
	return h as typeof h & { pressure: MemoryPressure };
}
/** 03:30 in Asia/Tokyo: inside the default time window. */
export const JST_0330 = Date.parse("2026-10-14T18:30:00.000Z");
export const stepsOf = (h: StewardHarness, step: string) =>
	h.units().filter((u) => u.step === step);
export const sleepState = (h: StewardHarness) =>
	h.store.read((db) => readSleepState(db));

let candidates = 0;
/** One open candidate (L1), observed in the user's own message. */
export async function candidate(h: StewardHarness, conversationId = "c1") {
	const n = ++candidates;
	const text = `夜に散歩する${n}`;
	const messageId = await h.say("user", `${text}ことが多い`, conversationId);
	const outcome = await h.store.write((db) =>
		h.memory.recordCandidateInTransaction(db, {
			conversationId,
			sourceRunId: `run-candidate-${n}`,
			kind: "habit",
			semanticKey: `habit.walk${n}`,
			subject: "self",
			text,
			polarity: "affirmed",
			evidence: [{ messageId, quote: text }],
		}),
	);
	if (outcome.status !== "recorded") throw new Error(outcome.reason);
}
export const candidatesOf = async (h: StewardHarness, count: number) => {
	for (let i = 0; i < count; i++) await candidate(h);
};
/** `count` exchanges: each leaves two events in the log. */
export async function talk(
	h: StewardHarness,
	count: number,
	conversationId = "c1",
) {
	for (let i = 0; i < count; i++)
		await h.exchange(`話${i}`, `返事${i}`, { conversationId });
}
