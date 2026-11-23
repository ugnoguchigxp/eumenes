import { afterEach, expect, test } from "bun:test";
import { closeUnit, insertUnit, touchPosition } from "../repository";
import {
	candidatesOf,
	closeSleepHarnesses,
	setupSleep as setup,
} from "./sleep.fixture";
import type { StewardHarness } from "./steward.fixture";

afterEach(closeSleepHarnesses);

/** `count` conversations the steward has worked in before: a user message each, a closed unit, a known position. */
async function manyConversations(h: StewardHarness, count: number) {
	const at = new Date(h.time.ms - 3_600_000).toISOString();
	await h.store.write((db) => {
		for (let i = 0; i < count; i++) {
			const conversationId = `bulk-${i}`;
			const messageId = `bulk-msg-${i}`;
			h.conversation.appendInTransaction(db, {
				id: messageId,
				conversationId,
				role: "user",
				text: `話${i}`,
				createdAt: at,
				runId: `bulk-run-${i}`,
			});
			const id = `bulk-unit-${i}`;
			insertUnit(db, {
				id,
				conversationId,
				kind: "requests",
				step: "curate-memory",
				slot: "reflect",
				targets: {},
				attempt: 0,
				createdAt: at,
			});
			closeUnit(db, id, "applied", at);
			touchPosition(db, conversationId);
		}
	});
}

/** Counts the calls a test is about, whatever they are made for. */
function counting<T extends (...args: never[]) => unknown>(
	owner: Record<string, unknown>,
	name: string,
) {
	const original = owner[name] as T;
	const counter = { calls: 0 };
	owner[name] = (...args: Parameters<T>) => {
		counter.calls++;
		return original.apply(owner, args);
	};
	return counter;
}

test("looking at the whole steward with hundreds of conversations does one pass over the sleep layer: its cost stays linear", async () => {
	const h = await setup();
	await manyConversations(h, 500);
	const seqReads = counting(
		h.continuity.events as unknown as Record<string, unknown>,
		"latestSeqInTransaction",
	);
	const started = performance.now();
	await h.kick();
	const took = performance.now() - started;
	expect(took).toBeLessThan(1000);
	// One pass over the conversations it watches (and not one pass for each conversation with a unit).
	expect(seqReads.calls).toBeLessThanOrEqual(502);
	expect(h.units()).toHaveLength(500);
});

test("when something is due, the rest of every conversation is looked at once for the whole look", async () => {
	const h = await setup();
	await manyConversations(h, 500);
	await candidatesOf(h, 10);
	h.time.ms += 3_600_000;
	const running = counting(
		h.foreground as unknown as Record<string, unknown>,
		"has",
	);
	const started = performance.now();
	await h.kick();
	const took = performance.now() - started;
	expect(took).toBeLessThan(1000);
	expect(running.calls).toBeLessThanOrEqual(502);
	expect(h.units().filter((u) => u.step === "shallow")).toHaveLength(1);
});
