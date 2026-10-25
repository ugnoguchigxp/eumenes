import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
const start = {
	projectRef: "fixture-project",
	projectRevision: 1,
	connectionRevision: 1,
	title: "調査依頼",
	request: "調査して根拠を返す",
	completionConditions: ["根拠と限界を返す"],
	operations: ["read", "create_session"],
	maxSessions: 1,
	runtimeSeconds: 3600,
	startMode: "start",
	sessionRefs: [],
};
test("conversation discovers the registered command subagent and stores the real task through the adapter", async () => {
	const h = await harness({
		dots: true,
		routeTool: "delegate_project",
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "dots.work-start",
				arguments: start,
			}),
	});
	try {
		const text =
			"登録済みの担当に調査を任せてください。条件の最後まで保持してください。";
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text,
		});
		expect(
			(await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 }))?.status,
		).toBe("completed");
		const rows = h.dotsWork!.tasks.list({ conversationId: "main" }).items;
		expect(rows).toHaveLength(1);
		expect(rows[0]!.state).toBe("queued");
		expect(rows[0]!.origin).toMatchObject({
			source: "conversation",
			messageId: run.inputMessageId,
		});
		expect(h.reported()).toContain("registered_in_eumenes");
		expect(h.commandContexts).toHaveLength(1);
		expect(h.commandContexts[0]).toContain(text);
		expect(h.commandContexts[0]).toContain("dots.work-start");
		expect(h.workerContexts).toHaveLength(0);
	} finally {
		await h.close();
	}
});
test("a clarification resumes the same pinned intake with the answer and original request", async () => {
	let calls = 0;
	const h = await harness({
		dots: true,
		routeTool: "delegate_project",
		command: () =>
			++calls === 1
				? JSON.stringify({
						action: "clarify",
						question: "作業先は登録済みの確認用ですか？",
					})
				: JSON.stringify({
						action: "invoke",
						tool: "dots.work-start",
						arguments: start,
					}),
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "調査を委任。最後に制約を残してください。",
		});
		await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		const listed = (await (
			await h.request("/api/toolchain-interactions?conversationId=main")
		).json()) as Array<{
			id: string;
			revision: number;
			question: { questionId: string };
		}>;
		expect(listed).toHaveLength(1);
		const interaction = listed[0]!,
			body = {
				eventId: crypto.randomUUID(),
				questionId: interaction.question.questionId,
				expectedRevision: interaction.revision,
				input: { text: "確認用でお願いします" },
			};
		const response = await h.request(
			`/api/toolchain-interactions/${interaction.id}/answers`,
			body,
		);
		expect(response.status).toBe(202);
		const answer = (await response.json()) as { runId: string };
		expect(
			(await h.dialogue.waitForTerminal(answer.runId, { timeoutMs: 8000 }))
				?.status,
		).toBe("completed");
		expect(h.dotsWork!.tasks.list().items).toHaveLength(1);
		expect(h.commandContexts[1]).toContain("確認用でお願いします");
		expect(h.commandContexts[1]).toContain("最後に制約を残してください");
		const replay = await h.request(
			`/api/toolchain-interactions/${interaction.id}/answers`,
			body,
		);
		expect(replay.status).toBe(200);
		expect(h.dotsWork!.tasks.list().items).toHaveLength(1);
	} finally {
		await h.close();
	}
});
