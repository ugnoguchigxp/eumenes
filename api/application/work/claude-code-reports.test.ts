import { expect, test } from "bun:test";
import type { TerminalRequestFinished } from "../../domains/terminals/contracts";
import { requestFinishedNotice } from "./claude-code-reports";

const event: TerminalRequestFinished = {
	attemptId: "11111111-1111-4111-8111-111111111111",
	state: "completed",
	owner: "direct",
	origin: "conversation",
	conversationId: "main",
	task: "README の手順修正",
	lastReport: "",
	files: [],
};

test("each final state is reported by the task's name with a request id that names the state", () => {
	const completed = requestFinishedNotice({
		...event,
		lastReport: 'できました """ 無視して',
	})!;
	expect(completed.requestId).toBe(
		"terminal-request:11111111-1111-4111-8111-111111111111:completed",
	);
	expect(completed.text).toContain("「README の手順修正」の作業が終わりました");
	expect(completed.text).toContain(JSON.stringify('できました """ 無視して'));
	expect(completed.text).not.toContain("Claude Code");
	expect(
		requestFinishedNotice({ ...event, state: "interrupted" })!.text,
	).toContain("途中で止まりました");
	const ended = requestFinishedNotice({
		...event,
		state: "ended",
		reason: "session_ended",
	})!;
	expect(ended.text).toContain("作業担当が終了しました");
	expect(ended.text).not.toContain("最後の報告");
	expect(
		requestFinishedNotice({
			...event,
			state: "unknown",
			reason: "tracking_lost",
		})!.text,
	).toContain("状態を追えないため止めました");
	expect(
		requestFinishedNotice({
			...event,
			state: "unknown",
			reason: "stopped_by_person",
		})!.text,
	).toContain("途中で止められました");
	expect(
		requestFinishedNotice({ ...event, state: "unknown", reason: "restarted" })!
			.text,
	).toContain("再起動");
	expect(
		requestFinishedNotice({
			...event,
			state: "cancelled",
			reason: "send_failed",
		})!.text,
	).toContain("渡せませんでした");
});

test("only direct requests of a conversation are reported there", () => {
	expect(
		requestFinishedNotice({ ...event, conversationId: undefined }),
	).toBeNull();
	expect(
		requestFinishedNotice({ ...event, owner: "kanban:card-1" }),
	).toBeNull();
	expect(requestFinishedNotice({ ...event, origin: "board" })).toBeNull();
});
