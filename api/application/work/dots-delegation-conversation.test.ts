import { expect, test } from "bun:test";
import { replyWith } from "../agency/always-on.fixture";
import {
	ask,
	assignmentAgenda,
	card,
	ended,
	executions,
	items,
	until,
	userWords,
} from "../media/assignment.fixture";
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
const text =
	"登録済みの担当に調査を任せてください。条件の最後まで保持してください。";

test("the registered command subagent is the agent's assignment and stores the real task through the adapter", async () => {
	const a = await assignmentAgenda({
		harness: {
			dots: true,
			routeTool: "delegate_project",
			command: () =>
				JSON.stringify({
					action: "invoke",
					tool: "dots.work-start",
					arguments: start,
				}),
		},
	});
	const h = a.h;
	try {
		await a.start();
		const { source } = await ask(a, "dots.delegate", text);
		await until(a, () => ended(a));
		expect(executions(a)).toMatchObject([{ status: "completed" }]);
		const rows = h.dotsWork!.tasks.list({ conversationId: "ao" }).items;
		expect(rows).toHaveLength(1);
		expect(rows[0]!.state).toBe("queued");
		expect(rows[0]!.origin).toMatchObject({
			messageId: source.messageId,
		});
		expect(h.reported("ao")).toContain("registered_in_eumenes");
		expect(h.commandContexts).toHaveLength(1);
		expect(h.commandContexts[0]).toContain(text);
		expect(h.commandContexts[0]).toContain("dots.work-start");
		expect(h.workerContexts).toHaveLength(0);
	} finally {
		await a.close();
	}
}, 30_000);
test("a clarification is the assignment's question, and its answer resumes the same intake with the original request", async () => {
	let calls = 0;
	const a = await assignmentAgenda({
		harness: {
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
		},
	});
	const h = a.h;
	try {
		await a.start();
		await ask(a, "dots.delegate", "調査を委任。最後に制約を残してください。");
		await until(a, () => !!items(a)[0]?.question);
		const asked = items(a)[0]!;
		expect(asked.question).toBe("作業先は登録済みの確認用ですか？");
		expect(h.dotsWork!.tasks.list().items).toHaveLength(0);
		const answer = await userWords(a, "確認用でお願いします");
		const { seen } = await replyWith(
			a,
			[
				{
					name: "assignment",
					arguments: {
						id: asked.id,
						action: "answer",
						text: "確認用でお願いします",
					},
				},
			],
			{ runId: "run-answer", messageIds: [answer.messageId] },
		);
		expect(
			seen[1]!.filter((m) => m.role === "tool").map((m) => m.content),
		).toEqual([`answered: ${card(a, "dots.delegate").title}に回答を渡した`]);
		await until(a, () => ended(a));
		expect(h.dotsWork!.tasks.list().items).toHaveLength(1);
		expect(h.commandContexts[1]).toContain("確認用でお願いします");
		expect(h.commandContexts[1]).toContain("最後に制約を残してください");
		// An ended assignment is no longer an open item.
		expect(items(a)).toHaveLength(0);
	} finally {
		await a.close();
	}
}, 30_000);
