import { expect, test } from "bun:test";
import { commandInputMessageIdsInTransaction } from "../service/action-origin";
import { setup, until } from "./command-interactions.fixture";

test("確認を複数回行ったcommandの原発言と回答を、非同期実行の照合用に公開する", async () => {
	const h = await setup();
	try {
		const first = await h.asked("色は？", "builtin:answerText");
		const original = h.conversation
			.get("main")
			.messages.find((m) => m.runId === first.id && m.role === "user")!;
		h.state.commands.push({
			action: "clarify",
			question: "操作は？",
			answerSchema: "builtin:answerText",
		});
		const question = h.interaction()!;
		const answer = await h.interactions.answer(question.id, {
			eventId: crypto.randomUUID(),
			questionId: question.question!.questionId,
			expectedRevision: question.revision,
			input: { text: "青" },
		});
		const firstIds = h.store.read((db) =>
			commandInputMessageIdsInTransaction(db, answer.runId),
		);
		expect(firstIds).toContain(original.id);
		expect(firstIds).toHaveLength(2);
		await until(
			() =>
				h.interaction()?.status === "waiting_input" &&
				h.interaction()!.questionCount === 2,
		);
		h.state.commands.push({
			action: "invoke",
			tool: "fake.start",
			arguments: { seconds: 90 },
		});
		const second = h.interaction()!;
		const answered = await h.interactions.answer(second.id, {
			eventId: crypto.randomUUID(),
			questionId: second.question!.questionId,
			expectedRevision: second.revision,
			input: { text: "矢印キー" },
		});
		const secondIds = h.store.read((db) =>
			commandInputMessageIdsInTransaction(db, answered.runId),
		);
		expect(secondIds).toHaveLength(3);
		expect(secondIds).toEqual(expect.arrayContaining(firstIds));
		expect(
			h.store.read((db) => commandInputMessageIdsInTransaction(db, "absent")),
		).toEqual([]);
	} finally {
		await h.close();
	}
});
