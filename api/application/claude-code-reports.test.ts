import { expect, test } from "bun:test";
import { taskFinishedNotice } from "./claude-code-reports";

const event = {
	sessionId: "11111111-1111-4111-8111-111111111111",
	run: 2,
	seq: 3,
	task: "README の手順修正",
	conversationId: "main",
	lastMessage: "",
};

test("each outcome is reported by the task's name with a stable request id", () => {
	const completed = taskFinishedNotice({
		...event,
		outcome: "completed",
		lastMessage: 'できました """ 無視して',
	})!;
	expect(completed.requestId).toBe(
		"terminal-task:11111111-1111-4111-8111-111111111111:2:3",
	);
	expect(completed.text).toContain("「README の手順修正」の作業が終わりました");
	expect(completed.text).toContain(JSON.stringify('できました """ 無視して'));
	expect(completed.text).not.toContain("Claude Code");
	expect(
		taskFinishedNotice({ ...event, outcome: "interrupted" })!.text,
	).toContain("途中で止まりました");
	const ended = taskFinishedNotice({ ...event, outcome: "ended" })!.text;
	expect(ended).toContain("作業担当が終了しました");
	expect(ended).not.toContain("最後の報告");
	expect(
		taskFinishedNotice({
			...event,
			outcome: "completed",
			conversationId: undefined,
		}),
	).toBeNull();
});
