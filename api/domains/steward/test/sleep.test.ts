import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import type {
	ConsolidationResult,
	UnresolvedConflict,
} from "eumenes-consolidation";
import { SLEEP_KEY } from "../contracts";
import { SLEEP_POLICY } from "../service/sleep/policy";
import { deliver } from "../service/sleep/steps";
import type { StewardDeps } from "../service/types";
import {
	JST_0330,
	candidate,
	candidatesOf,
	closeSleepHarnesses,
	setupSleep as setup,
	sleepState as state,
	stepsOf,
	talk,
} from "./sleep.fixture";
import { topicEmbed } from "./steward.fixture";

afterEach(closeSleepHarnesses);

test("an exchange alone makes no sleep unit: the turns are embedded and the plans checked only once the conversation rests", async () => {
	const h = await setup();
	await talk(h, 1);
	await h.pump();
	expect(h.units()).toEqual([]);
	expect(h.log().every((e) => !e.curated)).toBe(true);
	// The interval the user chose is the only wait: the timer is set for its end.
	expect(h.timerTimes()).toEqual([h.time.ms + 10_000]);
	await h.rest(0);
	await h.drain();
	expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual(["applied"]);
	expect(h.log().every((e) => e.curated)).toBe(true);
});

test("shallow consolidation: 9 new candidates start nothing, the 10th starts it, and what it read is not counted again", async () => {
	const h = await setup();
	await candidatesOf(h, SLEEP_POLICY.shallowCandidates - 1);
	await h.rest();
	expect(stepsOf(h, "shallow")).toEqual([]);
	expect(state(h).shallowWatermark).toBe(0);

	await candidate(h);
	await h.rest();
	const [unit] = stepsOf(h, "shallow");
	expect(unit).toMatchObject({
		kind: "sleep",
		conversationId: SLEEP_KEY,
		state: "applied",
	});
	expect(JSON.parse(unit!.targets)).toMatchObject({ consolidate: true });
	// The library's answer was adopted and its watermark is kept: the same candidates are not new again.
	expect(state(h).shallowWatermark).toBeGreaterThan(0);
	expect(h.inference.callsOf("sleep").length).toBeGreaterThan(0);
	const decision = h.steward
		.decisions(SLEEP_KEY)
		.find((d) => d.step === "shallow")!;
	expect(decision.errorCode).toBeNull();
	expect(decision.results).toMatchObject({
		consolidation: { adopted: true },
	});
	await candidatesOf(h, SLEEP_POLICY.shallowCandidates - 1);
	await h.rest();
	expect(stepsOf(h, "shallow")).toHaveLength(1);
	await candidate(h);
	await h.rest();
	expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual([
		"applied",
		"applied",
	]);
});

test("the sleep layer waits while a run goes and until the user's own interval is past; nothing is delayed by a fixed timer", async () => {
	const h = await setup({ restMs: 60_000 });
	await candidatesOf(h, SLEEP_POLICY.shallowCandidates);
	const spoke = h.time.ms;
	h.foreground.add("c1");
	await h.kick();
	await h.pump();
	expect(stepsOf(h, "shallow")).toEqual([]);
	// The run ends but the user spoke a moment ago: the timer is for the end of their interval.
	h.foreground.clear();
	h.time.ms += 5_000;
	await h.kick();
	await h.pump();
	expect(stepsOf(h, "shallow")).toEqual([]);
	expect(h.timerTimes()).toContain(spoke + 60_000);
	expect(h.futureJobs()).toEqual([]);
	await h.fireTimer();
	await h.drain();
	expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual(["applied"]);
	expect(h.time.ms).toBeGreaterThanOrEqual(spoke + 60_000);
});

test("one more at once: candidates that came while a unit ran start the next unit when it ends", async () => {
	const h = await setup();
	await candidatesOf(h, SLEEP_POLICY.shallowCandidates);
	let came = false;
	h.inference.answer("sleep", async () => {
		if (!came) {
			came = true;
			await candidatesOf(h, SLEEP_POLICY.shallowCandidates);
		}
		return { groups: [] };
	});
	await h.rest();
	await h.drain();
	// The user spoke again meanwhile: the second one waits for the rest, then follows without anything else to start it.
	await h.rest();
	expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual([
		"applied",
		"applied",
	]);
});

test("a model failure ends the unit and is counted; a yield to the conversation is not; the watermark waits for an adopted run", async () => {
	const h = await setup();
	await candidatesOf(h, SLEEP_POLICY.shallowCandidates);
	h.inference.script(
		"sleep",
		new Error("larm_preempted"),
		new Error("provider_rejected"),
	);
	await h.rest();
	await h.drain();
	const shallow = stepsOf(h, "shallow");
	expect(shallow.map((u) => [u.state, u.attempt])).toEqual([
		["failed", 0],
		["failed", 0],
		["applied", 1],
	]);
	expect(
		h.steward
			.decisions(SLEEP_KEY)
			.filter((d) => d.step === "shallow")
			.map((d) => String(d.errorCode))
			.sort(),
	).toEqual(["larm_preempted", "null", "provider_rejected"]);
	expect(state(h).shallowWatermark).toBeGreaterThan(0);
	expect(h.inference.statuses("pending")).toBe(0);
});

test("deep consolidation: only inside the user's time window, with enough new events, once a day", async () => {
	const h = await setup();
	// Outside the window (21:00 JST): enough events, but the timer waits for the window.
	await talk(h, SLEEP_POLICY.deepEvents / 2);
	await h.rest();
	expect(stepsOf(h, "deep")).toEqual([]);
	// The timer of the interval has run out; what is left to wait for is the window.
	await h.fireTimer();
	const windowStart = Date.parse("2026-10-14T18:00:00.000Z");
	expect(h.timerTimes()).toEqual([windowStart]);
	await h.fireTimer();
	await h.drain();
	expect(stepsOf(h, "deep").map((u) => [u.kind, u.state])).toEqual([
		["sleep", "applied"],
	]);
	expect(JSON.parse(stepsOf(h, "deep")[0]!.targets)).toMatchObject({
		supplement: false,
		positions: { c1: SLEEP_POLICY.deepEvents },
	});
	expect(state(h).deepDay).toBe("2026-10-15");
	// The same day, in the window, with enough new events again: not twice.
	h.time.ms = JST_0330 + 3_600_000;
	await talk(h, SLEEP_POLICY.deepEvents / 2);
	await h.rest();
	expect(stepsOf(h, "deep")).toHaveLength(1);
	// The next day it runs again.
	h.time.ms = JST_0330 + 24 * 3_600_000;
	await h.rest();
	expect(stepsOf(h, "deep").map((u) => u.state)).toEqual([
		"applied",
		"applied",
	]);
	expect(state(h).deepDay).toBe("2026-10-16");
});

test("19 new events are not enough for the deep consolidation", async () => {
	const h = await setup();
	h.time.ms = JST_0330;
	await talk(h, 9);
	await h.exchange("もう一言", null);
	await h.rest();
	expect(stepsOf(h, "deep")).toEqual([]);
	await h.exchange("もう一言", "はい");
	await h.rest();
	expect(stepsOf(h, "deep")).toHaveLength(1);
});

test("deep consolidation without the window: 200 new events and a resting conversation start the supplement", async () => {
	const h = await setup();
	await talk(h, SLEEP_POLICY.supplementEvents / 2 - 1);
	await h.rest();
	expect(stepsOf(h, "deep")).toEqual([]);
	await talk(h, 1);
	await h.rest();
	const [deep] = stepsOf(h, "deep");
	expect(deep).toMatchObject({ state: "applied" });
	expect(JSON.parse(deep!.targets)).toMatchObject({ supplement: true });
	// The window's day is not used up by the supplement.
	expect(state(h).deepDay).toBeNull();
});

test("the plans past their date wait for the user's confirmation once the conversation rests", async () => {
	const h = await setup();
	const said = await h.exchange("来月の予定", "はい");
	const plan = await h.store.write((db) =>
		h.continuity.plans.addInTransaction(db, {
			conversationId: "c1",
			kind: "plan",
			text: "歯医者",
			dueAt: "2026-10-01",
			evidence: { messages: [{ messageId: said.inputMessageId }] },
		}),
	);
	await h.rest();
	const listed = h.store.read((db) =>
		h.continuity.plans.listInTransaction(db, { conversationId: "c1" }),
	);
	expect(listed.find((p) => p.id === plan.id)?.state).toBe(
		"awaiting_confirmation",
	);
});

test("what an adopted run instructs goes to its outlets: plans to the plan store, the rest to the outlets that wait to be built", async () => {
	const seen: Record<string, number> = {};
	const count = (name: string) => () => {
		seen[name] = (seen[name] ?? 0) + 1;
	};
	const h = await setup({
		sleep: {
			outlets: {
				plansDue: count("plans"),
				unresolved: count("unresolved"),
				prep: count("prep"),
				goals: count("goals"),
				relinks: count("relinks"),
			},
		},
	});
	const record = { id: "i1", layer: "L2" as const, text: "x" };
	const result: ConsolidationResult = {
		runId: "run",
		adopted: true,
		applied: [],
		instructions: {
			plans: [{ planRef: "p1", to: "awaiting-confirmation" }],
			goals: [
				{ goalId: "g", finding: "may-be-completed", basedOn: [], reason: "r" },
			],
			unresolved: [
				{
					a: record,
					b: record,
					sources: [[], []],
					origin: "detected",
					note: "n",
				},
			],
			prep: [{ kind: "plan", target: "p1", points: ["a"], basedOn: [] }],
			relinks: [{ fromItemId: "i1", toItemId: "i2" }],
		},
		notAdopted: [],
		changes: [],
		llmCalls: 0,
	};
	const deps = {
		nowMs: () => h.time.ms,
		continuity: h.continuity,
		sleep: {
			window: () => ({ start: "03:00", end: "05:00" }),
			outlets: {
				plansDue: count("plans"),
				unresolved: count("unresolved"),
				prep: count("prep"),
				goals: count("goals"),
				relinks: count("relinks"),
			},
		},
	} as unknown as StewardDeps;
	await h.store.write((db) => {
		deliver({ db, deps, conversationId: SLEEP_KEY }, result, { deep: false });
	});
	// A shallow run hands on plans, unresolved contradictions and relinks; preparations and goals are deep's.
	expect(seen).toEqual({ plans: 1, unresolved: 1, relinks: 1 });
	await h.store.write((db) => {
		deliver({ db, deps, conversationId: SLEEP_KEY }, result, { deep: true });
	});
	expect(seen).toEqual({
		plans: 2,
		unresolved: 2,
		relinks: 2,
		prep: 1,
		goals: 1,
	});
});

test("unresolved contradictions and goal findings are saved once each as open questions on the records and the user's messages", async () => {
	const h = await setup();
	const coffee = await h.seedMemory({
		user: "コーヒーはブラックで飲む",
		text: "コーヒーはブラックで飲む",
		key: "drink.coffee",
	});
	const latte = await h.seedMemory({
		user: "最近はカフェラテばかり",
		text: "コーヒーはカフェラテで飲む",
		key: "drink.coffee.now",
	});
	const goalText = "毎朝ストレッチを続ける";
	const result = (over: Partial<ConsolidationResult["instructions"]>) =>
		({
			runId: "run",
			adopted: true,
			applied: [],
			instructions: {
				plans: [],
				goals: [],
				unresolved: [],
				prep: [],
				relinks: [],
				...over,
			},
			notAdopted: [],
			changes: [],
			llmCalls: 0,
		}) satisfies ConsolidationResult;
	const a = {
		id: coffee.itemId,
		layer: "L2" as const,
		text: "コーヒーはブラックで飲む",
	};
	const b = {
		id: latte.itemId,
		layer: "L2" as const,
		text: "コーヒーはカフェラテで飲む",
	};
	const conflict: UnresolvedConflict = {
		a,
		b,
		sources: [
			[{ conversationId: "c1", messageId: coffee.inputMessageId }],
			[{ conversationId: "c1", messageId: latte.inputMessageId }],
		],
		origin: "detected",
		note: "n",
	};
	const finding = {
		goalId: "goal-1",
		finding: "may-be-completed" as const,
		basedOn: [a],
		reason: "r",
	};
	const deps = {
		nowMs: () => h.time.ms,
		continuity: h.continuity,
		conversation: h.conversation,
		memory: h.memory,
		sleep: { window: () => ({ start: "03:00", end: "05:00" }) },
	} as unknown as StewardDeps;
	const goals = [{ id: "goal-1", text: goalText, state: "adopted" }];
	const deliverTwice = async () => {
		for (let i = 0; i < 2; i++)
			await h.store.write((db) => {
				deliver(
					{ db, deps, conversationId: SLEEP_KEY },
					result({ unresolved: [conflict], goals: [finding] }),
					{ deep: true, goals },
				);
			});
	};
	await deliverTwice();
	const questions = h.store.read((db) =>
		h.continuity.plans.listInTransaction(db, { kinds: ["open_question"] }),
	);
	// Delivered twice: still one question for the pair and one for the goal.
	expect(questions).toHaveLength(2);
	const pair = questions.find((q) => q.text.includes("食い違い"))!;
	expect(pair).toMatchObject({ conversationId: "c1", state: "open" });
	expect([...pair.memoryItemIds].sort()).toEqual(
		[coffee.itemId, latte.itemId].sort(),
	);
	expect(pair.evidence.map((e) => e.messageId).sort()).toEqual(
		[coffee.inputMessageId, latte.inputMessageId].sort(),
	);
	const goal = questions.find((q) => q.text.includes(goalText))!;
	expect(goal.text).toContain("達成できたか");
	expect(goal.memoryItemIds).toEqual([coffee.itemId]);
	// Neither record was changed.
	expect(
		h.memory
			.list()
			.map((i) => i.id)
			.sort(),
	).toEqual([coffee.itemId, latte.itemId].sort());
	// Forgetting a record the question stands on takes the question with it.
	await h.memory.forget({
		conversationId: "c1",
		itemIds: [coffee.itemId],
		messageIds: [],
	});
	expect(
		h.store.read((db) =>
			h.continuity.plans.listInTransaction(db, { kinds: ["open_question"] }),
		),
	).toEqual([]);
});

/** The judge of the deep run: what is observed in two conversations is a tendency (L4); the rest waits. */
const tendencyJudge = (data: Record<string, unknown>) => {
	const payload = JSON.parse(String(data.user)) as {
		records?: Array<{ ref: string; layer: string; conversations?: number }>;
		minConversations?: number;
		maxAreaSize?: number;
	};
	const records = payload.records ?? [];
	// The areas judgement is the one that names a size; the promotion judgement names the conversations it needs.
	if (payload.maxAreaSize !== undefined)
		return { areas: [{ label: "all", refs: records.map((r) => r.ref) }] };
	if (payload.minConversations === undefined)
		return { groups: [], pairs: [], items: [], findings: [] };
	return {
		decisions: records
			.filter((r) => r.layer === "L1")
			.map((r) =>
				(r.conversations ?? 0) >= payload.minConversations!
					? {
							ref: r.ref,
							decision: "promote",
							target: "L4",
							reason: "習慣として続いている",
						}
					: {
							ref: r.ref,
							decision: "hold",
							target: null,
							reason: "観測が足りない",
						},
			),
	};
};

test("a candidate observed in two conversations is promoted to a tendency by the deep run, and written to memory with its evidence", async () => {
	const h = await setup();
	h.inference.answer("sleep", tendencyJudge);
	const text = "夜に散歩する";
	for (const conversationId of ["c1", "c2"]) {
		await h.kick(conversationId);
		const messageId = await h.say("user", `${text}ことが多い`, conversationId);
		const outcome = await h.store.write((db) =>
			h.memory.recordCandidateInTransaction(db, {
				conversationId,
				sourceRunId: `run-${conversationId}`,
				kind: "habit",
				semanticKey: "evening.walk",
				subject: "self",
				text,
				polarity: "affirmed",
				evidence: [{ messageId, quote: text }],
			}),
		);
		if (outcome.status !== "recorded") throw new Error(outcome.reason);
	}
	// A run of the time window (03:30 JST) with enough new events, once the conversation rests.
	h.time.ms = JST_0330;
	await talk(h, SLEEP_POLICY.deepEvents / 2);
	await h.rest();
	expect(stepsOf(h, "deep").map((u) => u.state)).toEqual(["applied"]);
	const tendencies = h.memory.tendencies();
	expect(tendencies.map((t) => t.text)).toEqual([text]);
	// A tendency is not a long-term record: nothing reaches `## Memory` through it.
	expect(h.memory.list().map((i) => i.text)).toEqual([]);
	const decision = h.steward
		.decisions(SLEEP_KEY)
		.find((d) => d.step === "deep")!;
	expect(decision.errorCode).toBeNull();
	expect(decision.results).toMatchObject({
		consolidation: { adopted: true, applied: { tendency: 1 } },
	});
});

/** A judge that merges the candidate texts it is told to, so a test can move the ground under its write. */
const dedupeOf =
	(drop: string, keep: string, beforeAnswer: () => Promise<void> | void) =>
	async (data: Record<string, unknown>) => {
		const payload = JSON.parse(String(data.user)) as {
			records?: Array<{ ref: string; text: string }>;
		};
		const refOf = (text: string) =>
			payload.records?.find((r) => r.text === text)?.ref;
		const a = refOf(keep);
		const b = refOf(drop);
		await beforeAnswer();
		return a && b
			? { groups: [{ keep: a, drop: [b], reason: "言い換え" }] }
			: { groups: [] };
	};

test("a write of the sleep run finds a forget since prepare: nothing is written, the unit is stale, not a failure, and it reads again", async () => {
	const h = await setup();
	await candidatesOf(h, SLEEP_POLICY.shallowCandidates);
	const seeded = await h.seedMemory({
		user: "住所は東京都です",
		text: "住所は東京都",
		key: "address",
	});
	let forgotten = false;
	h.inference.answer(
		"sleep",
		dedupeOf("none", "none", async () => {
			if (forgotten) return;
			forgotten = true;
			await h.memory.forget({
				conversationId: "c1",
				itemIds: [seeded.itemId],
				messageIds: [],
			});
		}),
	);
	await h.rest();
	await h.drain();
	const shallow = stepsOf(h, "shallow");
	expect(shallow.map((u) => [u.state, u.attempt])).toEqual([
		["stale", 0],
		["applied", 0],
	]);
	const stale = h.steward
		.decisions(SLEEP_KEY)
		.find((d) => d.errorCode === "stale_forget");
	expect(stale).toBeDefined();
	// The second unit read what is now and was adopted.
	expect(state(h).shallowWatermark).toBeGreaterThan(0);
});

test("a conversation run that begins while the sleep run works fences its write; the run's end starts it again", async () => {
	const h = await setup();
	await candidatesOf(h, SLEEP_POLICY.shallowCandidates);
	let begun = false;
	h.inference.answer(
		"sleep",
		dedupeOf("none", "none", () => {
			if (begun) return;
			begun = true;
			h.foreground.add("c1");
		}),
	);
	await h.rest();
	expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual(["stale"]);
	expect(state(h).shallowWatermark).toBe(0);
	expect(
		h.steward
			.decisions(SLEEP_KEY)
			.some((d) => d.errorCode === "foreground_active"),
	).toBe(true);
	// While the run goes nothing starts; once it ends the layer reads again.
	await h.kick();
	await h.pump();
	expect(stepsOf(h, "shallow")).toHaveLength(1);
	h.foreground.clear();
	await h.rest();
	expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual([
		"stale",
		"applied",
	]);
});

test("embedding that fails leaves the events unhandled and counts as a failure; the retry handles them", async () => {
	let broken = true;
	const h = await setup({
		embed: async (texts, type, signal) => {
			if (broken) throw new Error("embedding_down");
			return topicEmbed(texts, type, signal);
		},
	});
	await talk(h, 1);
	await h.rest();
	expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual(["failed"]);
	expect(h.log().every((e) => !e.curated)).toBe(true);
	expect(
		h.steward
			.decisions(SLEEP_KEY)
			.some((d) => d.errorCode === "embedding_failed"),
	).toBe(true);
	broken = false;
	await h.drain();
	expect(stepsOf(h, "shallow").map((u) => [u.state, u.attempt])).toEqual([
		["failed", 0],
		["applied", 1],
	]);
	expect(h.log().every((e) => e.curated)).toBe(true);
});

test("with no embedder set up the events are handled without vectors: nothing fails and the shallow layer goes on", async () => {
	const h = await setup({ embed: undefined });
	await talk(h, 1);
	await h.rest();
	expect(stepsOf(h, "shallow").map((u) => [u.state, u.attempt])).toEqual([
		["applied", 0],
	]);
	expect(h.log().every((e) => e.curated)).toBe(true);
	expect(
		h.steward
			.decisions(SLEEP_KEY)
			.some((d) => d.errorCode === "embedding_failed"),
	).toBe(false);
	// The layer is not stopped: candidates still start their consolidation.
	await candidatesOf(h, SLEEP_POLICY.shallowCandidates);
	await h.rest();
	expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual([
		"applied",
		"applied",
	]);
});

test("a step given up after three failures says so once, however often the steward looks", async () => {
	const h = await setup();
	await candidatesOf(h, SLEEP_POLICY.shallowCandidates);
	const lines: string[] = [];
	configureLogging({
		level: "warn",
		destination: { write: (line: string) => void lines.push(line) },
	});
	try {
		const failure = new Error("provider_rejected");
		h.inference.answer("sleep", failure);
		await h.rest();
		// Each failure waits for its retry delay; the timer brings the next try.
		for (let i = 0; i < 2; i++) {
			await h.fireTimer();
			await h.pump();
		}
		for (let i = 0; i < 4; i++) {
			await h.kick();
			await h.pump();
		}
		expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual([
			"failed",
			"failed",
			"failed",
		]);
		expect(
			lines.filter((l) => l.includes("steward.sleep_given_up")),
		).toHaveLength(1);
	} finally {
		configureLogging({ level: "silent" });
	}
});

test("candidates the host can not read still move the watermark, so they are not counted new again", async () => {
	const h = await setup();
	const messageIds: string[] = [];
	for (let i = 0; i < SLEEP_POLICY.shallowCandidates; i++) {
		const text = `朝に走る${i}`;
		const messageId = await h.say("user", `${text}ことが多い`, "c1");
		messageIds.push(messageId);
		const outcome = await h.store.write((db) =>
			h.memory.recordCandidateInTransaction(db, {
				conversationId: "c1",
				sourceRunId: `run-unreadable-${i}`,
				kind: "habit",
				semanticKey: `habit.run${i}`,
				subject: "self",
				text,
				polarity: "affirmed",
				evidence: [{ messageId, quote: text }],
			}),
		);
		if (outcome.status !== "recorded") throw new Error(outcome.reason);
	}
	// The messages are retracted: the library still lists the candidates, the host can not read their words.
	for (const messageId of messageIds)
		await h.conversation.retract({ messageId });
	await h.rest();
	expect(stepsOf(h, "shallow").map((u) => u.state)).toEqual(["applied"]);
	expect(state(h).shallowWatermark).toBeGreaterThan(0);
	await h.kick();
	await h.rest();
	expect(stepsOf(h, "shallow")).toHaveLength(1);
});

test("a refused tendency holds its candidate alone: the deep run is adopted and the other promotion goes on", async () => {
	const h = await setup({
		sleep: {
			outlets: {
				writeTendency: () => {
					throw new Error("tendency_refused");
				},
			},
		},
	});
	h.inference.answer("sleep", tendencyJudge);
	const texts = ["夜に散歩する", "朝に走る"];
	for (const [i, text] of texts.entries())
		for (const conversationId of ["c1", "c2"]) {
			await h.kick(conversationId);
			const messageId = await h.say(
				"user",
				`${text}ことが多い`,
				conversationId,
			);
			const outcome = await h.store.write((db) =>
				h.memory.recordCandidateInTransaction(db, {
					conversationId,
					sourceRunId: `run-${i}-${conversationId}`,
					kind: "habit",
					semanticKey: `habit.k${i}`,
					subject: "self",
					text,
					polarity: "affirmed",
					evidence: [{ messageId, quote: text }],
				}),
			);
			if (outcome.status !== "recorded") throw new Error(outcome.reason);
		}
	h.inference.answer("sleep", (data) => {
		const judged = tendencyJudge(data) as {
			decisions?: Array<{ ref: string; target?: string | null }>;
		};
		// The judge sends the first one to L4 (refused) and the other to the long-term layer.
		const records =
			(
				JSON.parse(String(data.user)) as {
					records?: Array<{ ref: string; text: string }>;
				}
			).records ?? [];
		for (const decision of judged.decisions ?? []) {
			const text = records.find((r) => r.ref === decision.ref)?.text;
			if (decision.target === "L4" && text === "朝に走る")
				decision.target = "L2";
		}
		return judged;
	});
	h.time.ms = JST_0330;
	await talk(h, SLEEP_POLICY.deepEvents / 2);
	await h.rest();
	const [unit] = stepsOf(h, "deep");
	expect(unit).toMatchObject({ state: "applied", attempt: 0 });
	expect(h.memory.tendencies()).toEqual([]);
	expect(h.memory.list().map((i) => i.text)).toEqual(["朝に走る"]);
	const decision = h.steward
		.decisions(SLEEP_KEY)
		.find((d) => d.step === "deep")!;
	expect(decision.errorCode).toBeNull();
});
