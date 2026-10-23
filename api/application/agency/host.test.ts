import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmPort, LlmRequest } from "eumenes-agency";
import {
	createConversationService,
	migrations,
} from "../../domains/conversation";
import type { MemoryItemDto } from "../../domains/memory";
import { settle, waitFor } from "../../infrastructure/wait-for";
import { openStore } from "../../infrastructure/sqlite";
import { createAgencyHost, type AgencySettings } from "./host";
import { AgencyRouteRefusedError } from "./llm-port";

const T0 = Date.parse("2026-10-22T09:00:00Z");
const baseSettings: AgencySettings = {
	enabled: true,
	resourceId: null,
	idleSec: 20,
	maxUnanswered: 1,
	interests: [],
};

/** What the fake background model answers for one purpose. */
type Reply = (request: LlmRequest<unknown>) => unknown | Promise<unknown>;
const update: Reply = () => ({
	summary: "s",
	missingInfo: null,
	focusRefs: [],
	ops: [],
	reconciliations: [],
});
const choice = (
	action: "speak" | "wait",
	over: { utterance?: string; refs?: string[] } = {},
) => ({
	action,
	candidateRef: null,
	utterance:
		action === "speak"
			? (over.utterance ?? "ねえ、さっきの話の続きは？")
			: null,
	toolName: null,
	toolInput: null,
	evidenceRefs: over.refs ?? [],
	valueNow: "v",
	userBurden: "b",
	lossIfWait: "l",
	conflicts: null,
	reason: "テストの理由",
});
const wait: Reply = () => choice("wait");

const memoryItem = (over: Partial<MemoryItemDto>): MemoryItemDto => ({
	id: "m1",
	kind: "preference",
	semanticKey: "k",
	text: "コーヒーが好き",
	polarity: "affirmed",
	status: "active",
	origin: "agent",
	revision: 1,
	sourceMessageIds: [],
	validFromMs: null,
	validUntilMs: null,
	evidence: [],
	validity: null,
	capturedBy: "agent",
	...over,
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function harness(
	options: {
		settings?: Partial<AgencySettings>;
		select?: Reply;
		update?: Reply;
		memory?: MemoryItemDto[];
		busy?: () => boolean;
		start?: boolean;
		llm?: (
			next: Parameters<Parameters<typeof createAgencyHost>[0]["createLlm"]>[0],
		) => LlmPort;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-agency-host-"));
	const store = openStore(join(dir, "test.sqlite3"), migrations);
	const conversation = createConversationService(store, {
		requireOutbox: true,
	});
	let agency: AgencySettings = { ...baseSettings, ...options.settings };
	const listeners = new Set<() => void>();
	let now = T0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	let timerId = 0;
	const calls = { update: 0, select: 0, respond: 0 };
	const requests: LlmRequest<unknown>[] = [];
	const identities: Array<{ decisionId: string; generation: number }> = [];
	let select = options.select ?? wait;
	const inference = { busy: false };
	const memoryReads = { count: 0 };
	const host = createAgencyHost({
		store,
		conversation,
		inference: { foregroundBusy: () => inference.busy },
		settings: {
			get: () => ({ agency }),
			inTransaction: () => ({ agency }),
			onChange: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		memory: {
			status: () => ({ enabled: true, healthy: true }),
			list: () => {
				memoryReads.count++;
				return options.memory ?? [];
			},
		},
		conversationBusy: () => options.busy?.() ?? false,
		createLlm:
			options.llm ??
			((next) => ({
				async complete<T>(request: LlmRequest<T>) {
					identities.push(next(request as LlmRequest<unknown>));
					calls[request.purpose]++;
					requests.push(request as LlmRequest<unknown>);
					const reply =
						request.purpose === "update" ? (options.update ?? update) : select;
					const value = request.schema.parse(
						await reply(request as LlmRequest<unknown>),
					);
					return {
						value,
						model: "fake",
						inputTokens: 10,
						outputTokens: 5,
						cacheReadTokens: 0,
						latencyMs: 1,
					};
				},
			})),
		nowMs: () => now,
		setTimer: (fn, ms) => {
			timers.set(++timerId, { at: now + ms, fn });
			return timerId;
		},
		clearTimer: (handle) => {
			timers.delete(handle as number);
		},
	});
	if (options.start !== false) host.start();
	cleanups.push(async () => {
		await host.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const message = (
		conversationId: string,
		id: string,
		role: "user" | "assistant",
		text: string,
		runId: string | null = null,
	) => ({
		id,
		conversationId,
		role,
		text,
		createdAt: new Date(now).toISOString(),
		runId,
	});
	return {
		store,
		conversation,
		host,
		calls,
		requests,
		identities,
		inference,
		memoryReads,
		setSelect: (reply: Reply) => {
			select = reply;
		},
		setAgency: (over: Partial<AgencySettings>) => {
			agency = { ...agency, ...over };
			for (const listener of listeners) listener();
		},
		/** The committed setting changes before the listeners hear of it. */
		setAgencyUnannounced: (over: Partial<AgencySettings>) => {
			agency = { ...agency, ...over };
		},
		/** Settings changed somewhere else (cloud allowed, a connection, a model). */
		announceSettings: () => {
			for (const listener of listeners) listener();
		},
		say: (
			id: string,
			role: "user" | "assistant",
			text: string,
			runId: string | null = null,
			conversationId = "c1",
		) => conversation.append(message(conversationId, id, role, text, runId)),
		message,
		texts: (conversationId = "c1") =>
			conversation.get(conversationId).messages.map((m) => m.id),
		/** Runs the fake timers due within `ms`, in order, letting each cycle finish. */
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, t]) => t.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = Math.max(now, due[1].at);
				due[1].fn();
				await settle();
			}
			now = end;
		},
		pendingTimers: () => timers.size,
		setNow: (value: number) => {
			now = value;
		},
		advanceClock: (ms: number) => {
			now += ms;
		},
	};
}
type Harness = ReturnType<typeof harness>;

/** A user message and the run answer that ends the turn. */
async function exchange(h: Harness, n: number, conversationId = "c1") {
	await h.say(`u${n}`, "user", `こんにちは${n}`, null, conversationId);
	await h.say(`a${n}`, "assistant", `はい${n}`, `run-${n}`, conversationId);
}

describe("OFF", () => {
	test("observes nothing, calls no model, appends nothing and leaves the context port empty", async () => {
		const h = harness({
			settings: { enabled: false, interests: ["My Melody"] },
			select: () => choice("speak", { refs: ["u1"] }),
		});
		await exchange(h, 1);
		await settle();
		await h.advance(10 * 60_000);
		expect(h.calls).toEqual({ update: 0, select: 0, respond: 0 });
		expect(h.texts()).toEqual(["u1", "a1"]);
		expect(h.host.inspect("c1")).toBeNull();
		expect(h.pendingTimers()).toBe(0);
		expect(
			h.store.read((db) =>
				h.host.dialoguePort.recentForContextInTransaction(db, "c1"),
			),
		).toBeNull();
	});

	test("turning ON starts at the end of the feed and OFF applies at once", async () => {
		const h = harness({ settings: { enabled: false } });
		await exchange(h, 1);
		h.setAgency({ enabled: true });
		await settle();
		// What was said before ON is never read.
		expect(h.host.inspect("c1")).toBeNull();
		expect(h.calls.select).toBe(0);
		await exchange(h, 2);
		await waitFor(() => h.calls.select === 1);
		const ids = h.host.inspect("c1")?.snapshot.observations.map((o) => o.id);
		expect(ids).toEqual(["u2", "a2"]);
		h.setAgency({ enabled: false });
		expect(h.host.inspect("c1")).toBeNull();
		await exchange(h, 3);
		await settle();
		expect(h.calls.select).toBe(1);
	});

	test("switching OFF while a decision is pending appends nothing", async () => {
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
		h.setAgency({ enabled: false });
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

describe("route", () => {
	test("a refused cloud route stops agency for the conversation and never falls back", async () => {
		let attempts = 0;
		const h = harness({
			llm: () => ({
				async complete() {
					attempts++;
					throw new AgencyRouteRefusedError("cloud_not_allowed");
				},
			}),
		});
		await exchange(h, 1);
		await waitFor(() => h.host.inspect("c1")?.stopped !== null);
		expect(h.host.inspect("c1")?.stopped).toBe(
			"route_refused:cloud_not_allowed",
		);
		const seen = attempts;
		await exchange(h, 2);
		await settle();
		await h.advance(3_600_000);
		expect(attempts).toBe(seen);
		expect(h.texts()).toEqual(["u1", "a1", "u2", "a2"]);
	});

	test("changing the settings clears the stop", async () => {
		let refuse = true;
		const h = harness({
			llm: () => ({
				async complete() {
					if (refuse) throw new AgencyRouteRefusedError("resource_missing");
					throw new Error("not reached in this test");
				},
			}),
		});
		await exchange(h, 1);
		await waitFor(() => h.host.inspect("c1")?.stopped !== null);
		refuse = false;
		h.setAgency({ resourceId: "11111111-1111-4111-8111-111111111111" });
		expect(h.host.inspect("c1")).toBeNull();
	});
});

describe("context port", () => {
	test("shows what was said on its own since the user's previous message, and the interests", async () => {
		const h = harness({
			settings: { interests: ["My Melody"] },
			select: () => choice("speak", { refs: ["u1"] }),
		});
		const recent = () =>
			h.store.read((db) =>
				h.host.dialoguePort.recentForContextInTransaction(db, "c1"),
			);
		await exchange(h, 1);
		await waitFor(() => h.texts().length === 3);
		await h.say("u2", "user", "なあに");
		expect(recent()?.interests).toEqual(["My Melody"]);
		expect(recent()?.utterances.map((u) => [u.text, u.heard])).toEqual([
			["ねえ、さっきの話の続きは？", "full"],
		]);
		// Answered in the next turn: no longer shown.
		await h.say("a2", "assistant", "うん", "run-2");
		await h.say("u3", "user", "ありがとう");
		expect(recent()?.utterances).toEqual([]);
		expect(recent()?.interests).toEqual(["My Melody"]);
	});

	test("is empty without utterances and interests", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		expect(
			h.store.read((db) =>
				h.host.dialoguePort.recentForContextInTransaction(db, "c1"),
			),
		).toBeNull();
	});
});

/** A model port that answers like the harness default and enforces inference's per-subject idempotency. */
function strictLlm(
	h: { refuse?: () => boolean } = {},
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
				if (h.refuse?.())
					throw new AgencyRouteRefusedError("cloud_not_allowed");
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

	test("a stopped conversation gets a fresh start when settings change elsewhere", async () => {
		let refuse = true;
		const strict = strictLlm({ refuse: () => refuse });
		const h = harness({ llm: strict.llm });
		await exchange(h, 1);
		await waitFor(() => h.host.inspect("c1")?.stopped !== null);
		expect(h.host.inspect("c1")?.idle.blockedBy).toBe("stopped");
		refuse = false;
		h.announceSettings();
		const fresh = h.host.inspect("c1");
		expect(fresh?.stopped).toBeNull();
		expect(fresh?.idle.blockedBy).toBeNull();
		await exchange(h, 2);
		await waitFor(
			() => (h.host.inspect("c1")?.snapshot.observations.length ?? 0) >= 2,
		);
		await waitFor(
			() => strict.log.ids.filter((id) => id.includes("select")).length >= 1,
		);
		expect(h.host.inspect("c1")?.stopped).toBeNull();
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
		// OFF is committed but the change has not been announced yet.
		h.setAgencyUnannounced({ enabled: false });
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

	test("a corrected agency utterance updates what the host remembers saying", async () => {
		const h = harness({
			settings: { interests: ["x"] },
			select: () => choice("speak", { refs: ["u1"] }),
		});
		await exchange(h, 1);
		await waitFor(() => h.texts().length === 3);
		const id = h.texts()[2] as string;
		await h.conversation.correct({ messageId: id, text: "言い直しました" });
		await waitFor(
			() => h.host.inspect("c1")?.delivered[0]?.text === "言い直しました",
		);
		await h.say("u2", "user", "なあに");
		expect(
			h.store.read((db) =>
				h.host.dialoguePort.recentForContextInTransaction(db, "c1"),
			)?.utterances[0]?.text,
		).toBe("言い直しました");
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

	test("the context layer shows only for conversations the host tracks", async () => {
		const h = harness({ settings: { interests: ["My Melody"] } });
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		const recent = (id: string) =>
			h.store.read((db) =>
				h.host.dialoguePort.recentForContextInTransaction(db, id),
			);
		expect(recent("c1")?.interests).toEqual(["My Melody"]);
		expect(recent("never-seen")).toBeNull();
	});
});

describe("work reports (spec agency-work-reports-design-2026-10-24)", () => {
	/** A fake work port: held reports per conversation; records what was released. */
	function fakeWork(h: Harness) {
		const held: Array<{
			eventId: string;
			executionId: string;
			conversationId: string;
			heldAt: number;
		}> = [];
		const released: string[] = [];
		const take = (pick: (r: (typeof held)[number]) => boolean) => {
			let n = 0;
			for (const r of held.filter(pick)) {
				held.splice(held.indexOf(r), 1);
				released.push(r.executionId);
				n++;
			}
			return n;
		};
		const work = {
			todosInTransaction: (_db: unknown, conversationId: string) =>
				held
					.filter((r) => r.conversationId === conversationId)
					.map((r) => ({
						id: r.executionId,
						title: "楽曲の生成",
						status: "done" as const,
						outcome: "succeeded" as const,
						result: "3分の曲",
						requestedAt: T0,
						doneAt: r.heldAt,
					})),
			heldInTransaction: (_db: unknown, conversationId?: string) =>
				held.filter(
					(r) =>
						conversationId === undefined || r.conversationId === conversationId,
				),
			releaseInTransaction: (
				_db: unknown,
				conversationId: string,
				ids: readonly string[],
			) =>
				take(
					(r) =>
						r.conversationId === conversationId && ids.includes(r.executionId),
				),
			releaseAllInTransaction: (_db: unknown, conversationId?: string) =>
				take(
					(r) =>
						conversationId === undefined || r.conversationId === conversationId,
				),
			releaseStaleInTransaction: () => 0,
		};
		h.host.attachWork(work as never);
		return {
			held,
			released,
			/** A result is held now and a commit announces it. */
			async hold(executionId: string, conversationId = "c1", at?: number) {
				held.push({
					eventId: `ev-${executionId}`,
					executionId,
					conversationId,
					heldAt: at ?? Date.now(),
				});
				// A real change, as the hold's INSERT is (a write without changes notifies nobody).
				await h.store.write((db) => {
					db.exec("CREATE TABLE IF NOT EXISTS held_probe(x INTEGER)");
					db.query("INSERT INTO held_probe VALUES(1)").run();
				});
				await settle();
			},
		};
	}

	test("a held report opens a result_received decision; reporting it releases the notice and appends nothing", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		const w = fakeWork(h);
		h.setNow(T0 + 60_000);
		h.setSelect(() => choice("speak", { refs: ["todo:x1"] }));
		await w.hold("x1", "c1", T0 + 60_000);
		await waitFor(() => w.released.length === 1);
		expect(w.released).toEqual(["x1"]);
		const prompt = String(h.requests.at(-1)?.prompt ?? "");
		expect(prompt).toContain("trigger=result_received");
		expect(prompt).toContain("[todo:x1] 完了（成功）: 楽曲の生成");
		// The conversation answers the released notice; the agency wrote nothing itself.
		expect(h.texts()).toEqual(["u1", "a1"]);
	});

	test("waiting rechecks the held report after one silence interval", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		const w = fakeWork(h);
		h.setNow(T0 + 60_000);
		await w.hold("x1", "c1", T0 + 60_000);
		await waitFor(() => h.calls.select === 2);
		h.setSelect(() => choice("speak", { refs: ["todo:x1"] }));
		await h.advance(20_000);
		await waitFor(() => w.released.length === 1);
		expect(w.released).toEqual(["x1"]);
	});

	test("held reports nobody watches are sent at once: agency OFF, another conversation, held too long", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		const w = fakeWork(h);
		// another conversation than the active one
		await w.hold("x2", "c2", Date.now());
		await waitFor(() => w.released.includes("x2"));
		// held too long
		h.setNow(T0 + 40 * 60_000);
		await w.hold("x3", "c1", T0);
		await waitFor(() => w.released.includes("x3"));
		// agency OFF
		h.setAgency({ enabled: false });
		await w.hold("x4", "c1", T0 + 40 * 60_000);
		await waitFor(() => w.released.includes("x4"));
		expect(h.texts()).toEqual(["u1", "a1"]);
	});

	test("reports are held only for the watched conversation with the setting ON", async () => {
		const h = harness();
		fakeWork(h);
		const holds = (id: string) =>
			h.store.read((db) => h.host.holdsReportsInTransaction(db, id));
		expect(holds("c1")).toBe(false); // nobody spoke yet
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		expect(holds("c1")).toBe(true);
		expect(holds("c2")).toBe(false);
		h.setAgency({ enabled: false });
		expect(holds("c1")).toBe(false);
	});
	test("held reports expire without a later commit even when idle opportunities are disabled", async () => {
		const h = harness({ settings: { idleSec: 0 } });
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		const w = fakeWork(h);
		await w.hold("expires", "c1", T0);
		await h.advance(30 * 60_000);
		await waitFor(() => w.released.includes("expires"));
	});
	test("disabling agency releases an already held report without a later commit", async () => {
		const h = harness();
		await exchange(h, 1);
		await waitFor(() => h.calls.select === 1);
		const w = fakeWork(h);
		await w.hold("disabled", "c1", T0);
		h.setAgency({ enabled: false });
		await waitFor(() => w.released.includes("disabled"));
	});
});
