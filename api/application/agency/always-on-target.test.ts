import { expect, test } from "bun:test";
import { settle } from "../../infrastructure/wait-for";
import { saveItem } from "../../domains/memory/test/memory.fixture";
import { agendaFixture, type CallKind } from "./always-on.fixture";

type Fixture = Awaited<ReturnType<typeof agendaFixture>>;

/** A user's message and the memory items the resolution may pick from. */
async function setup(f: Fixture) {
	await f.start();
	await f.user("user-a", "ao", "コーヒーはブラックで飲む。猫を飼っている");
	const save = (semanticKey: string, text: string) =>
		saveItem(f.h.store, f.h.memory!, {
			conversationId: "ao",
			messageId: "user-a",
			kind: "preference",
			semanticKey,
			text,
		});
	const coffee = await save("drink.coffee", "コーヒーはブラックで飲む");
	const cat = await save("pet.cat", "猫を飼っている");
	await f.user("user-b", "ao", "コーヒーの話は忘れて");
	return { coffee, cat };
}
const picks = (targets: string[], term: string | null = null) => ({
	targets: targets.map((ref) => ({ ref, reason: "fixture" })),
	term,
});
const targetScript = (value: unknown) => (kind: CallKind) =>
	kind === "target" ? value : undefined;
const texts = (f: Fixture) => f.h.memory!.list().map((i) => i.text);
type Request = Parameters<
	Fixture["host"]["memoryTargets"]["requestInTransaction"]
>[1];
let requests = 0;

/** The steward's inbox and the dialogue's side, as the agency reads and tells them. */
function inbox(f: Fixture) {
	const state = {
		pending: [] as Request[],
		excluded: [] as unknown[],
		settled: [] as Array<{ id: string; outcome: string }>,
		hidden: [] as string[][],
		told: [] as string[],
	};
	(f.deps as { steward?: unknown }).steward = {
		pendingTargetsInTransaction: () =>
			state.pending.map((request) => ({ id: request.requestId, request })),
		settleTargetInTransaction: (
			_db: unknown,
			input: { id: string; outcome: string },
		) => {
			state.settled.push(input);
			state.pending = state.pending.filter((r) => r.requestId !== input.id);
		},
		excludedInTransaction: (_db: unknown, input: { id: string }) => {
			state.excluded.push(input);
			state.pending = state.pending.filter((r) => r.requestId !== input.id);
			return true;
		},
	};
	(f.deps as { dialogueTargets?: unknown }).dialogueTargets = {
		hideExcludedInTransaction: (
			_db: unknown,
			input: { messageIds: string[] },
		) => state.hidden.push(input.messageIds),
		targetsSettled: (conversationId: string) => state.told.push(conversationId),
	};
	return state;
}
const requestOf = (over: Partial<Request> = {}): Request => ({
	conversationId: "ao",
	runId: "run-t",
	kind: "forget",
	what: "コーヒーの話",
	messageIds: ["user-b"],
	requestId: `request-${++requests}`,
	...over,
});
/** The request the conversation agent makes: in the steward's inbox, and the port told in the same transaction. */
const ask = async (
	f: Fixture,
	state: ReturnType<typeof inbox>,
	over: Partial<Request> = {},
) => {
	const request = requestOf(over);
	state.pending.push(request);
	// The transaction of the run's tool call writes something (here: a message), so its commit is announced.
	await f.h.store.write((db) => {
		f.h.conversation.appendInTransaction(db, {
			id: `note-${request.requestId}`,
			conversationId: "ao",
			role: "assistant",
			text: "了解です。",
			runId: null,
			createdAt: new Date(f.now).toISOString(),
		});
		f.host.memoryTargets.requestInTransaction(db, request);
	});
	await settle();
	await settle();
	return request;
};

test("a forget picks the target from the candidates the host showed, excludes it, tells the steward and the dialogue, and the others stay", async () => {
	const f = await agendaFixture({ script: targetScript(picks(["m1"])) });
	try {
		const state = inbox(f);
		const { coffee } = await setup(f);
		const request = await ask(f, state, { requestId: "steward-request" });
		expect(texts(f)).toEqual(["猫を飼っている"]);
		// The steward's request waits for the closure delete of what was excluded, under its own id.
		expect(state.excluded).toMatchObject([
			{
				id: "steward-request",
				conversationId: "ao",
				exclusion: { itemIds: [coffee.id], goalIds: [] },
			},
		]);
		// The messages the excluded record stands on are hidden in the same transaction; the dialogue is told after.
		expect(state.hidden).toEqual([["user-a"]]);
		expect(state.told).toEqual(["ao"]);
		expect(state.pending).toEqual([]);
		expect(request.requestId).toBe("steward-request");
		// The call was shown the candidates by their short references, not their ids.
		const [call] = f.calls("target");
		expect(call!.prompt).toContain("コーヒーはブラックで飲む");
		expect(call!.prompt).not.toContain(coffee.id);
	} finally {
		await f.close();
	}
});

test("a reference the call was not shown is not accepted: nothing changes, and the request is settled as unresolved", async () => {
	const f = await agendaFixture({ script: targetScript(picks(["m9", "x1"])) });
	try {
		const state = inbox(f);
		await setup(f);
		const request = await ask(f, state);
		expect(f.calls("target")).toHaveLength(1);
		expect(texts(f)).toHaveLength(2);
		expect(state.settled).toEqual([
			{ id: request.requestId, outcome: "unresolved" },
		]);
		expect(state.told).toEqual(["ao"]);
	} finally {
		await f.close();
	}
});

test("with nothing that bears on the request no call is made, and it is settled as unresolved", async () => {
	const f = await agendaFixture({ script: targetScript(picks(["m1"])) });
	try {
		const state = inbox(f);
		await setup(f);
		await ask(f, state, { what: "zzzz", messageIds: [] });
		expect(f.calls("target")).toHaveLength(0);
		expect(texts(f)).toHaveLength(2);
		expect(state.settled.map((s) => s.outcome)).toEqual(["unresolved"]);
	} finally {
		await f.close();
	}
});

test("a call that fails resolves nothing and is not tried again", async () => {
	const f = await agendaFixture({
		script: (kind: CallKind) => {
			if (kind === "target") throw new Error("fixture_failure");
			return undefined;
		},
	});
	try {
		const state = inbox(f);
		await setup(f);
		await ask(f, state);
		expect(f.calls("target")).toHaveLength(1);
		expect(texts(f)).toHaveLength(2);
		expect(state.settled.map((s) => s.outcome)).toEqual(["unresolved"]);
		f.setBusy(false);
		await settle();
		expect(f.calls("target")).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("a suppression marks the fact, or stores a topic word the user said when no record stands for it; both are settled as applied", async () => {
	let answer: unknown = picks(["m1"]);
	const f = await agendaFixture({
		script: (kind) => (kind === "target" ? answer : undefined),
	});
	try {
		const state = inbox(f);
		await setup(f);
		const first = await ask(f, state, { kind: "suppress" });
		const suppressed = () =>
			f.h.store.read((db) => f.deps.memory.suppressionsInTransaction(db));
		expect(suppressed().facts).toEqual([
			{ subject: "self", kind: "preference", semanticKey: "drink.coffee" },
		]);
		expect(state.settled).toEqual([
			{ id: first.requestId, outcome: "applied" },
		]);
		// A word that is not in what the user said is no topic.
		answer = picks([], "天気");
		await ask(f, state, { kind: "suppress", what: "zzzz", messageIds: [] });
		expect(suppressed().terms).toEqual([]);
		answer = picks([], "ゴルフ");
		await f.user("user-c", "ao", "ゴルフの話はもう出さないで");
		await ask(f, state, {
			kind: "suppress",
			what: "ゴルフの話",
			messageIds: ["user-c"],
		});
		expect(suppressed().terms).toEqual(["ゴルフ"]);
		expect(state.settled.map((s) => s.outcome)).toEqual([
			"applied",
			"unresolved",
			"applied",
		]);
	} finally {
		await f.close();
	}
});

test("a correction replaces the one version named, with the user's words as the evidence, and is settled as applied", async () => {
	const f = await agendaFixture({ script: targetScript(picks(["m1"])) });
	try {
		const state = inbox(f);
		const { coffee } = await setup(f);
		await f.user("user-d", "ao", "コーヒーはミルク入りに変えた");
		const request = await ask(f, state, {
			kind: "correct",
			what: "コーヒーの飲み方",
			messageIds: ["user-d"],
			quote: "ミルク入りに変えた",
			memory: { text: "コーヒーはミルク入りで飲む" },
		});
		expect(texts(f)).toContain("コーヒーはミルク入りで飲む");
		expect(texts(f)).not.toContain("コーヒーはブラックで飲む");
		expect(
			f.h.memory!.list(true).find((i) => i.id === coffee.id)?.status,
		).not.toBe("active");
		expect(state.settled).toEqual([
			{ id: request.requestId, outcome: "applied" },
		]);
	} finally {
		await f.close();
	}
});

test("the queue's flow: a request is put in the inbox, the call the main conversation called off waits for its run to end, then it excludes, hides, settles and tells the dialogue; a restart takes up what is still pending", async () => {
	let busyCalls = 0;
	const f = await agendaFixture({
		script: (kind) => {
			if (kind !== "target") return undefined;
			// The main conversation is writing a reply: the call is called off (the scheduler yields the model).
			if (f.busy()) {
				busyCalls++;
				throw new DOMException("preempted", "AbortError");
			}
			return picks(["m1"]);
		},
	});
	try {
		const state = inbox(f);
		const { coffee } = await setup(f);
		f.setBusy(true);
		const request = await ask(f, state, { requestId: "flow-request" });
		// Called off: nothing settled, nothing hidden, the request still waits in the inbox, the dialogue still waits.
		expect(busyCalls).toBe(1);
		expect(state.pending.map((r) => r.requestId)).toEqual(["flow-request"]);
		expect(state.settled).toEqual([]);
		expect(state.hidden).toEqual([]);
		expect(state.told).toEqual([]);
		expect(texts(f)).toHaveLength(2);
		// No timer: time passing while the conversation is busy does not try again.
		await f.advance(60_000);
		expect(busyCalls).toBe(1);
		// The run ends: at once, the target is resolved.
		f.setBusy(false);
		await settle();
		await settle();
		expect(texts(f)).toEqual(["猫を飼っている"]);
		expect(state.excluded).toMatchObject([
			{ id: "flow-request", exclusion: { itemIds: [coffee.id] } },
		]);
		expect(state.hidden).toEqual([["user-a"]]);
		expect(state.told).toEqual(["ao"]);
		expect(state.pending).toEqual([]);
		expect(request.requestId).toBe("flow-request");
		// A request that was in the inbox when the host went down is taken up when it starts again.
		state.pending.push(
			requestOf({
				requestId: "after-restart",
				kind: "suppress",
				what: "猫の話",
			}),
		);
		await f.restart();
		await settle();
		await settle();
		expect(state.settled.map((s) => s.id)).toContain("after-restart");
		expect(state.pending).toEqual([]);
	} finally {
		await f.close();
	}
});
