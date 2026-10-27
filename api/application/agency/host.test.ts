import { describe, expect, test } from "bun:test";
import type { LlmPort, LlmRequest } from "eumenes-agency";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { createAgencyHost } from "./host";
import {
	update,
	choice,
	wait,
	memoryItem,
	harness,
	exchange,
} from "./host.fixture";

describe("start and settings", () => {
	test("the feed starts at its end: what was said before start is never read", async () => {
		const h = harness({ start: false });
		await exchange(h, 1);
		h.host.start();
		await settle();
		expect(h.host.inspect("c1")).toBeNull();
		expect(h.calls.select).toBe(0);
		await exchange(h, 2);
		await waitFor(() => h.calls.select === 1);
		expect(
			h.host.inspect("c1")?.snapshot.observations.map((o) => o.id),
		).toEqual(["u2", "a2"]);
	});

	test("a change of the agency settings applies at once: every conversation starts over", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		expect(h.host.inspect("c1")).not.toBeNull();
		h.setAgency({ idleSec: 30 });
		expect(h.host.inspect("c1")).toBeNull();
		// What was said before the change is not read again; what follows is.
		await exchange(h, 2);
		await waitFor(() => h.calls.select === 2);
		expect(
			h.host.inspect("c1")?.snapshot.observations.map((o) => o.id),
		).toEqual(["u2", "a2"]);
	});

	test("settings that are not the agency's change nothing", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		h.announceSettings();
		expect(h.host.inspect("c1")).not.toBeNull();
	});

	test("switching the settings while a decision is pending appends nothing", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const h = harness({
			select: async () => {
				await gate;
				return choice("speak", { refs: ["u1"] });
			},
		});
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		h.setAgency({ interests: ["My Melody"] });
		release();
		await settle();
		expect(h.texts()).toEqual(["u1", "a1"]);
	});
});

describe("opportunities", () => {
	test("one reply makes one turn-end decision and the user message alone calls no model", async () => {
		const h = harness();
		await h.say("u1", "user", "こんにちは");
		await settle();
		expect(h.calls).toEqual({ update: 0, select: 0, respond: 0 });
		await h.say("a1", "assistant", "はい", "run-1");
		await waitFor(() => h.calls.select === 1);
		await settle();
		expect(h.calls).toEqual({ update: 1, select: 1, respond: 0 });
		// Every call has its own decision id and carries the conversation generation.
		expect(new Set(h.identities.map((i) => i.decisionId)).size).toBe(2);
		expect(h.identities.every((i) => i.generation >= 1)).toBe(true);
		expect(h.texts()).toEqual(["u1", "a1"]);
	});

	test("a runless assistant message (a timer's) is observed but opens no opportunity", async () => {
		const h = harness();
		await h.say("u1", "user", "タイマーお願い");
		await h.say("timer-completion:1", "assistant", "3分経ちました");
		await settle();
		expect(h.calls.select).toBe(0);
		expect(
			h.host.inspect("c1")?.snapshot.observations.map((o) => [o.id, o.actor]),
		).toEqual([
			["u1", "user"],
			["timer-completion:1", "agent"],
		]);
	});

	test("the user's active State items reach the decision as topics, bounded and stable", async () => {
		const items = [
			memoryItem({ id: "m1", text: "コーヒーが好き" }),
			memoryItem({ id: "m2", kind: "constraint", text: "夜は電話しない" }),
			memoryItem({ id: "m3", polarity: "negated", text: "辛い物が嫌い" }),
			memoryItem({ id: "m4", kind: "personal_fact", text: "猫を飼っている" }),
		];
		const h = harness({ memory: items });
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		const prompt = h.requests.find((r) => r.purpose === "select")?.prompt ?? "";
		expect(prompt).toContain("コーヒーが好き");
		expect(prompt).toContain("猫を飼っている");
		expect(prompt).not.toContain("夜は電話しない");
		expect(prompt).not.toContain("辛い物が嫌い");
		expect(prompt).toContain("memory:m1");
	});

	test("two events of one commit are both observed, in order, and open one cycle", async () => {
		const h = harness();
		await h.store.write((db) => {
			h.conversation.appendInTransaction(
				db,
				h.message("c1", "u1", "user", "やあ"),
			);
			h.conversation.appendInTransaction(
				db,
				h.message("c1", "a1", "assistant", "どうも", "run-1"),
			);
		});
		await waitFor(() => h.calls.select === 1);
		await settle();
		expect(
			h.host.inspect("c1")?.snapshot.observations.map((o) => [o.seq, o.id]),
		).toEqual([
			[1, "u1"],
			[2, "a1"],
		]);
		expect(h.calls.select).toBe(1);
	});

	test("a corrected message becomes a correction observation", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await h.conversation.correct({ messageId: "u1", text: "こんばんは" });
		await waitFor(
			() =>
				h.host
					.inspect("c1")
					?.snapshot.observations.some((o) => o.kind === "correction") ?? false,
		);
		const correction = h.host
			.inspect("c1")
			?.snapshot.observations.find((o) => o.kind === "correction");
		expect(correction?.text).toBe("こんばんは");
		expect(correction?.actor).toBe("user");
	});

	test("a retraction starts the conversation's runtime over", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		expect(h.host.inspect("c1")?.snapshot.observations).toHaveLength(2);
		const before = h.host.inspect("c1")?.generation ?? 0;
		await h.conversation.retract({ messageId: "u1" });
		await waitFor(
			() => h.host.inspect("c1")?.snapshot.observations.length === 0,
		);
		expect(h.host.inspect("c1")?.generation).toBeGreaterThan(before);
		// The new runtime sees only what follows.
		await exchange(h, 2);
		await waitFor(() => h.calls.select === 2);
		expect(
			h.host.inspect("c1")?.snapshot.observations.map((o) => o.id),
		).toEqual(["u2", "a2"]);
	});
});

describe("delivery", () => {
	test("a spoken ticket becomes one runless assistant message with one terminal receipt", async () => {
		const h = harness({ select: () => choice("speak", { refs: ["u1"] }) });
		await exchange(h, 1);
		await waitFor(() => h.texts().length === 3);
		const spoken = h.conversation.get("c1").messages[2];
		expect(spoken).toMatchObject({
			role: "assistant",
			runId: null,
			text: "ねえ、さっきの話の続きは？",
		});
		expect(spoken?.id.startsWith("agency:")).toBe(true);
		await settle();
		const snapshot = h.host.inspect("c1")?.snapshot;
		expect(snapshot?.state.attempts.map((a) => a.status)).toEqual([
			"succeeded",
		]);
		expect(
			snapshot?.observations.filter((o) => o.kind === "delivery.observed"),
		).toHaveLength(1);
		// Its own utterance is not fed back as an observation.
		expect(snapshot?.observations.some((o) => o.id.startsWith("agency:"))).toBe(
			false,
		);
	});

	test("with emotion on, the utterance's feeling is stored as its host delivery; without one, none", async () => {
		const h = harness({
			settings: { emotion: true },
			select: (request) => {
				expect(request.system).toContain("【発話の気持ち】");
				return { ...choice("speak", { refs: ["u1"] }), emotion: "🙂" };
			},
		});
		await exchange(h, 1);
		await waitFor(() => h.texts().length === 3);
		const spoken = h.conversation.get("c1").messages[2];
		expect(spoken?.delivery).toMatchObject({
			source: "host",
			emotion: "none",
			tone: "natural",
		});
		// Every other feeling keeps its name as the delivery emotion.
		const joy = harness({
			settings: { emotion: true },
			select: () => ({ ...choice("speak", { refs: ["u1"] }), emotion: "😊" }),
		});
		await exchange(joy, 1);
		await waitFor(() => joy.texts().length === 3);
		expect(joy.conversation.get("c1").messages[2]?.delivery).toMatchObject({
			source: "host",
			emotion: "joy",
		});
		const plain = harness({
			settings: { emotion: true },
			select: () => ({ ...choice("speak", { refs: ["u1"] }), emotion: null }),
		});
		await exchange(plain, 1);
		await waitFor(() => plain.texts().length === 3);
		expect(plain.conversation.get("c1").messages[2]?.delivery).toBeUndefined();
	});

	test("with emotion off, the select is asked without the feeling rules", async () => {
		const h = harness({
			select: (request) => {
				expect(request.system).not.toContain("発話の気持ち");
				return choice("speak", { refs: ["u1"] });
			},
		});
		await exchange(h, 1);
		await waitFor(() => h.texts().length === 3);
		expect(h.conversation.get("c1").messages[2]?.delivery).toBeUndefined();
	});

	test("S5: a user message arriving during the decision appends nothing", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const h = harness({
			select: async () => {
				await gate;
				return choice("speak", { refs: ["u1"] });
			},
		});
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await h.say("u2", "user", "まって");
		release();
		await settle();
		expect(h.texts()).toEqual(["u1", "a1", "u2"]);
		const attempts = h.host.inspect("c1")?.snapshot.state.attempts ?? [];
		expect(attempts.every((a) => a.status !== "succeeded")).toBe(true);
	});

	test("S5: something said after the opportunity (without new input) interrupts the ticket", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const h = harness({
			select: async () => {
				await gate;
				return choice("speak", { refs: ["u1"] });
			},
		});
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await h.say("timer-completion:9", "assistant", "時間です");
		release();
		await waitFor(
			() => h.host.inspect("c1")?.snapshot.state.attempts.length === 1,
		);
		await settle();
		expect(h.texts()).toEqual(["u1", "a1", "timer-completion:9"]);
		expect(
			h.host.inspect("c1")?.snapshot.state.attempts.map((a) => a.status),
		).toEqual(["interrupted"]);
	});

	test("S5: a run still queued or running at the delivery time interrupts the ticket", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		let busy = false;
		const h = harness({
			busy: () => busy,
			select: async () => {
				await gate;
				return choice("speak", { refs: ["u1"] });
			},
		});
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		busy = true;
		release();
		await waitFor(
			() => h.host.inspect("c1")?.snapshot.state.attempts.length === 1,
		);
		await settle();
		expect(h.texts()).toEqual(["u1", "a1"]);
		expect(
			h.host.inspect("c1")?.snapshot.state.attempts.map((a) => a.status),
		).toEqual(["interrupted"]);
	});

	test("a foreground request in progress blocks the opportunity without a model choice", async () => {
		const h = harness({ select: () => choice("speak", { refs: ["u1"] }) });
		h.inference.busy = true;
		await exchange(h, 1);
		await waitFor(() => h.calls.update === 1);
		await settle();
		expect(h.calls.select).toBe(0);
		expect(h.texts()).toEqual(["u1", "a1"]);
	});

	test("S6: the same text at another opportunity is another ticket and another message", async () => {
		const h = harness({
			settings: { idleSec: 70, maxUnanswered: 2 },
			select: () => choice("speak", { utterance: "同じ一言", refs: ["u1"] }),
		});
		await exchange(h, 1);
		await waitFor(() => h.texts().length === 3);
		await h.advance(70_000);
		await waitFor(() => h.texts().length === 4);
		const [first, second] = h.conversation
			.get("c1")
			.messages.filter((m) => m.id.startsWith("agency:"));
		expect(first?.text).toBe("同じ一言");
		expect(second?.text).toBe("同じ一言");
		expect(first?.id).not.toBe(second?.id);
		const attempts = h.host.inspect("c1")?.snapshot.state.attempts ?? [];
		expect(new Set(attempts.map((a) => a.id)).size).toBe(2);
		expect(attempts.map((a) => a.opportunityId)).toEqual(["o1", "o2"]);
	});
});

describe("idle", () => {
	test("silence is retried at 20s, 40s, 80s and then given up", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await settle();
		await h.advance(19_000);
		expect(h.calls.select).toBe(1);
		await h.advance(1_000);
		expect(h.calls.select).toBe(2);
		await h.advance(39_000);
		expect(h.calls.select).toBe(2);
		await h.advance(1_000);
		expect(h.calls.select).toBe(3);
		await h.advance(79_000);
		expect(h.calls.select).toBe(3);
		await h.advance(1_000);
		expect(h.calls.select).toBe(4);
		await h.advance(3_600_000);
		expect(h.calls.select).toBe(4);
		expect(h.pendingTimers()).toBe(0);
		expect(h.host.inspect("c1")?.idle.blockedBy).toBe("exhausted");
	});

	test("one unanswered spoken remark ends automatic idle until the user speaks again", async () => {
		const h = harness({ select: () => choice("speak", { refs: ["u1"] }) });
		await exchange(h, 1);
		await waitFor(() => h.texts().length === 3);
		await h.advance(3_600_000);
		expect(h.calls.select).toBe(1);
		expect(h.host.inspect("c1")?.idle.blockedBy).toBe("unanswered");
		await h.say("u2", "user", "うん");
		expect(h.host.inspect("c1")?.idle.blockedBy).toBeNull();
	});

	test("only the conversation the user spoke in last gets idle cycles", async () => {
		const h = harness();
		await exchange(h, 1, "c1");
		await waitFor(() => h.calls.select === 1);
		await exchange(h, 2, "c2");
		await waitFor(() => h.calls.select === 2);
		await settle();
		await h.advance(20_000);
		expect(h.calls.select).toBe(3);
		expect(h.host.inspect("c1")?.idle.blockedBy).toBe("paused");
		expect(h.host.inspect("c2")?.idle.blockedBy).toBeNull();
	});

	test("a busy moment defers the cycle without spending the backoff", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await settle();
		h.inference.busy = true;
		await h.advance(20_000);
		expect(h.calls.select).toBe(1);
		expect(h.host.inspect("c1")?.idle.level).toBe(0);
		h.inference.busy = false;
		await h.advance(20_000);
		expect(h.calls.select).toBe(2);
		expect(h.host.inspect("c1")?.idle.level).toBe(1);
	});

	test("a new user message cancels the pending idle and restarts the silence", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await settle();
		await h.advance(15_000);
		await h.say("u2", "user", "ねえ");
		await h.advance(10_000);
		expect(h.calls.select).toBe(1);
		await h.advance(10_000);
		expect(h.calls.select).toBe(2);
	});
});

/** A model port that answers like the harness default and enforces inference's per-subject idempotency. */
function strictLlm(
	log: { ids: string[]; conflicts: number } = { ids: [], conflicts: 0 },
) {
	return {
		log,
		llm: (
			next: Parameters<Parameters<typeof createAgencyHost>[0]["createLlm"]>[0],
		): LlmPort => ({
			async complete<T>(request: LlmRequest<T>) {
				const identity = next(request as LlmRequest<unknown>);
				// background-control.ts: the same subject with another binding throws for good.
				if (log.ids.includes(identity.decisionId)) {
					log.conflicts++;
					throw new Error("background_control_conflict");
				}
				log.ids.push(identity.decisionId);
				const value = request.schema.parse(
					request.purpose === "update"
						? update(request as never)
						: wait(request as never),
				);
				return {
					value,
					model: "fake",
					inputTokens: 1,
					outputTokens: 1,
					cacheReadTokens: 0,
					latencyMs: 1,
				};
			},
		}),
	};
}

describe("review fixes", () => {
	test("decision ids stay unique when runtimes are recreated by settings changes and retractions", async () => {
		const strict = strictLlm();
		const h = harness({ llm: strict.llm });
		await exchange(h, 1);
		await waitFor(() => strict.log.ids.length >= 2);
		h.setAgency({ idleSec: 30 });
		await exchange(h, 2);
		await waitFor(() => strict.log.ids.length >= 4);
		await h.conversation.retract({ messageId: "u2" });
		await waitFor(
			() => h.host.inspect("c1")?.snapshot.observations.length === 0,
		);
		await exchange(h, 3);
		await waitFor(() => strict.log.ids.length >= 6);
		await settle();
		expect(strict.log.conflicts).toBe(0);
		expect(new Set(strict.log.ids).size).toBe(strict.log.ids.length);
		for (const id of strict.log.ids) {
			expect(id.length).toBeLessThanOrEqual(160);
			expect(id).toMatch(/^[a-zA-Z0-9_.:-]{1,160}$/);
		}
	});

	test("close waits for an idle cycle in flight and nothing is written after it", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		let selects = 0;
		const h = harness({
			select: async () => {
				if (++selects < 2) return choice("wait");
				await gate;
				return choice("speak", { refs: ["u1"] });
			},
		});
		await exchange(h, 1);
		await waitFor(() => selects === 1);
		await settle();
		await h.advance(20_000);
		await waitFor(() => selects === 2);
		let closed = false;
		const closing = h.host.close().then(() => (closed = true));
		await settle();
		expect(closed).toBe(false);
		release();
		await closing;
		expect(closed).toBe(true);
		expect(h.texts()).toEqual(["u1", "a1"]);
	});

	test("a retraction gives the conversation a new idle planner", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await settle();
		await h.advance(20_000 + 40_000 + 80_000 + 1_000);
		expect(h.host.inspect("c1")?.idle.blockedBy).toBe("exhausted");
		await h.conversation.retract({ messageId: "u1" });
		await waitFor(
			() => h.host.inspect("c1")?.snapshot.observations.length === 0,
		);
		expect(h.host.inspect("c1")?.idle).toMatchObject({
			blockedBy: null,
			level: 0,
		});
		await h.advance(20_000);
		expect(h.calls.select).toBe(5);
	});

	test("the delivery fence reads the committed setting, not the cached one", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const h = harness({
			select: async () => {
				await gate;
				return choice("speak", { refs: ["u1"] });
			},
		});
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		// A new setting is committed but the change has not been announced yet.
		h.setAgencyUnannounced({ interests: ["My Melody"] });
		release();
		await waitFor(
			() => h.host.inspect("c1")?.snapshot.state.attempts.length === 1,
		);
		await settle();
		expect(h.texts()).toEqual(["u1", "a1"]);
		expect(
			h.host.inspect("c1")?.snapshot.state.attempts.map((a) => a.status),
		).toEqual(["interrupted"]);
	});

	test("a replaced runtime neither delivers nor receives a receipt", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const h = harness({
			select: async () => {
				await gate;
				return choice("speak", { refs: ["u1"] });
			},
		});
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await h.conversation.retract({ messageId: "u1" });
		await waitFor(
			() => h.host.inspect("c1")?.snapshot.observations.length === 0,
		);
		release();
		await settle();
		expect(h.texts()).toEqual(["a1"]);
		expect(h.host.inspect("c1")?.snapshot.state.attempts).toEqual([]);
	});

	test("topics are cached for 30 seconds and re-read after a memory forget", async () => {
		const h = harness({ memory: [memoryItem({})] });
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		await settle();
		expect(h.memoryReads.count).toBe(1);
		await h.advance(20_000);
		expect(h.calls.select).toBe(2);
		expect(h.memoryReads.count).toBe(1);
		h.host.invalidateTopics();
		await h.advance(40_000);
		expect(h.calls.select).toBe(3);
		expect(h.memoryReads.count).toBe(2);
		await h.advance(80_000);
		expect(h.memoryReads.count).toBe(3);
	});

	test("idle conversations are forgotten and the tracked set is bounded", async () => {
		const h = harness();
		await h.say("u1", "user", "やあ", null, "old");
		await settle();
		expect(h.host.inspect("old")).not.toBeNull();
		h.advanceClock(31 * 60_000);
		await h.say("u2", "user", "やあ", null, "now");
		await settle();
		expect(h.host.inspect("old")).toBeNull();
		expect(h.host.inspect("now")).not.toBeNull();
		for (let i = 0; i < 25; i++) {
			h.advanceClock(1_000);
			await h.say(`b${i}`, "user", "やあ", null, `conv-${i}`);
		}
		await settle();
		const tracked = Array.from({ length: 25 }, (_, i) =>
			h.host.inspect(`conv-${i}`),
		).filter((c) => c !== null);
		expect(tracked.length).toBeLessThanOrEqual(20);
		// The newest (active) one stays.
		expect(h.host.inspect("conv-24")).not.toBeNull();
	});
});
