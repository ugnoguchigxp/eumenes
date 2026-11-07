import { afterEach, expect, test } from "bun:test";
import {
	setup,
	until,
	ADAPTER,
	type Harness,
} from "./command-interactions.fixture";

let h: Harness | undefined;
afterEach(async () => {
	await h?.close();
	h = undefined;
});

function structure(raw: string) {
	const original = h!.larm.executeControl!.bind(h!.larm);
	const snapshot = h!.larm.snapshotInTransaction!.bind(h!.larm);
	const prompts: string[] = [];
	Object.assign(h!.larm, {
		snapshotInTransaction: (tx: never) => {
			const saved = snapshot(tx);
			return {
				...saved,
				router: { ...saved.router, entry: "routeStructured" },
			};
		},
		captureBackgroundControlInTransaction: () => "structure-fixture",
		executeControl: async (...args: Parameters<typeof original>) => {
			if (args[0] !== "structure-fixture") return original(...args);
			prompts.push(args[1].at(-1)!.content);
			return {
				requestId: args[0],
				attemptId: "structure",
				value: JSON.stringify({ decision: JSON.parse(raw) }),
			};
		},
	});
	return prompts;
}

test("a structured answer resumes the same question and work once, without a new routing score", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const before = h.interaction()!;
	const todoId = h.todos()[0]!.id;
	const scores = h.state.routerAsked.length;
	const prompts = structure('{"answer":{"ref":"t1.answer","text":"15秒です"}}');
	h.state.commands.push({
		action: "invoke",
		tool: "fake.start",
		arguments: { seconds: 15 },
	});
	h.state.outcome = {
		state: "saved",
		adapterRef: ADAPTER,
		operationId: "fixture-op",
		digest: "fixture-digest",
	};
	await h.say("15秒です");
	await until(() => h!.interaction()?.status === "completed");
	expect(h.interaction()!.id).toBe(before.id);
	expect(h.archived().map((todo) => todo.id)).toEqual([todoId]);
	expect(h.started).toHaveLength(1);
	expect(h.state.routerAsked).toHaveLength(scores);
	expect(JSON.parse(prompts[0]!).pending).toEqual([
		{ ref: "t1.answer", title: h.archived()[0]!.title, question: "何秒ですか" },
	]);
	expect(JSON.stringify(h.commandPrompts.at(-1))).toContain("15秒です");
});

test("a mixed reply asks about the whole unperformed scope and leaves the existing question open", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const before = h.interaction()!;
	structure(
		'{"clarify":{"question":"回答と新しい依頼を順に進めてよいですか？","unhandled":["15秒です","天気も調べて"]}}',
	);
	const run = await h.say("15秒です。天気も調べて");
	expect(h.dialogue.answerText(run.id)).toContain("まだ実施していない依頼");
	expect(h.dialogue.answerText(run.id)).toContain("天気も調べて");
	expect(h.dialogue.answerText(run.id)).not.toContain(
		"S11TNEXT_DELIMITED_CONTEXT",
	);
	expect(h.interaction()).toMatchObject({
		id: before.id,
		status: "waiting_input",
		revision: before.revision,
	});
	expect(h.todos()).toHaveLength(1);
	expect(h.started).toHaveLength(0);
});

test("an invented question reference fails before answering or starting a replacement job", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const before = h.interaction()!;
	structure('{"answer":{"ref":"t9.answer","text":"15秒です"}}');
	const run = await h.say("15秒です");
	expect(h.dialogue.answerText(run.id)).toContain(
		"今回の作業はまだ実施していません",
	);
	expect(h.interaction()).toMatchObject({
		id: before.id,
		status: "waiting_input",
		revision: before.revision,
	});
	expect(h.todos()).toHaveLength(1);
	expect(h.started).toHaveLength(0);
});

test("structured cancellation reaches the same command and rejects a later answer to its closed question", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const todo = h.todos()[0]!;
	const interaction = h.interaction()!;
	const scores = h.state.routerAsked.length;
	const prompts = structure(
		'{"control":{"ref":"t1.cancel","text":"その作業を取り消してください"}}',
	);
	await h.say("その作業を取り消してください");
	expect(h.todos()).toHaveLength(0);
	expect(h.archived()).toMatchObject([{ id: todo.id, outcome: "cancelled" }]);
	expect(h.interaction()?.status).toBe("cancelled");
	await expect(
		h.interactions.answer(interaction.id, {
			eventId: crypto.randomUUID(),
			questionId: interaction.question!.questionId,
			expectedRevision: interaction.revision,
			input: "15秒です",
		}),
	).rejects.toThrow("interaction_closed");
	expect(h.state.routerAsked).toHaveLength(scores);
	expect(JSON.parse(prompts[0]!).controls).toEqual([
		{ ref: "t1.cancel", title: todo.title },
	]);
	const after = structure('{"answer":{"ref":"t1.answer","text":"15秒です"}}');
	await h.say("15秒です");
	expect(JSON.parse(after[0]!).pending).toEqual([]);
	expect(JSON.parse(after[0]!).controls).toEqual([]);
	expect(h.archived()).toHaveLength(1);
	expect(h.started).toHaveLength(0);
});

test("a model's partial answer or cancellation cannot omit the rest of the utterance", async () => {
	h = await setup({ questions: [] });
	await h.asked("何秒ですか", "builtin:answerText");
	const before = h.interaction()!;
	const scores = h.state.routerAsked.length;
	for (const [text, raw] of [
		[
			"15秒です。それとは別に天気を調べてください。",
			'{"answer":{"ref":"t1.answer","text":"15秒です"}}',
		],
		[
			"その話は後にして、少し話を聞いてください。",
			'{"control":{"ref":"t1.cancel","text":"その話は後にして"}}',
		],
	]) {
		structure(raw!);
		const run = await h.say(text!);
		expect(h.dialogue.answerText(run.id)).toContain(
			"今回の作業はまだ実施していません",
		);
		expect(h.interaction()).toMatchObject({
			id: before.id,
			status: "waiting_input",
			revision: before.revision,
		});
	}
	expect(h.todos()).toHaveLength(1);
	expect(h.started).toHaveLength(0);
	expect(h.state.routerAsked).toHaveLength(scores);
});
