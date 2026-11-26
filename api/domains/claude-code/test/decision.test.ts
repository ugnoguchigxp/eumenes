import { expect, test } from "bun:test";
import type { Work } from "../contracts";
import { decide } from "../decision";

/** A work whose last execution came back with a long report and many read results, as a goal's read does. */
const work = {
	id: "work-1",
	request:
		"設定画面の背景色の実装と関連する試験を読み取り、現状を報告してください。",
	references: [],
	profile: "利用者の目的と権限を保ち、Claude Code へまとまった作業を依頼する。",
	skills: ["元の依頼と途中の条件を保つ。"],
	deadline: Date.now() + 600_000,
	generation: 0,
	memo: "読取のみ",
	answers: [],
	amendments: [],
	calls: 2,
	maxCalls: 24,
	executions: 1,
	maxExecutions: 8,
	decisionMode: "work",
	mode: "read",
	eventExcerpts: [],
	knownEvidenceRefs: Array.from({ length: 24 }, (_, n) => `evidence:${n}`),
	observation: {
		executionId: "execution-1",
		state: "completed",
		summary: `読み取った結果：${"設定画面の表示設定に背景色の選択があり、保存と復元の試験がある。".repeat(160)}結論：既存の実装で条件を満たす。`,
		evidence: Array.from({ length: 8 }, (_, n) => ({
			ref: `read:${n}`,
			text: "背景色".repeat(200),
		})),
	},
} as unknown as Work;

test("a long report of the last execution is shortened to its opening and end, not refused", async () => {
	let sent = "";
	const inference = {
		async executeControl(_id: string, messages: unknown) {
			sent = JSON.stringify(messages);
			return { value: { decision: { kind: "finish", summary: "済" } } };
		},
	} as never;
	await decide(
		inference,
		"decision-1",
		work,
		new AbortController().signal,
	).catch(() => {});
	expect(sent).not.toBe("");
	expect(Buffer.byteLength(sent)).toBeLessThanOrEqual(12_000);
	expect(sent).toContain("…");
	expect(sent).toContain("読み取った結果");
	expect(sent).toContain("結論：既存の実装で条件を満たす。");
});
