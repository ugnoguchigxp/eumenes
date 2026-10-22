import { expect, test } from "bun:test";
import {
	executionStatusText,
	executionStoppedReply,
} from "../service/execution-notices";
import { harness } from "../../../application/toolchain/toolchain.fixture";

test("status text describes the adopted state rather than the requested control", () => {
	expect(
		executionStatusText({
			id: crypto.randomUUID(),
			conversationId: "main",
			request: "request",
			revision: 1,
			status: "completed",
			deadline: 1,
			question: null,
			result: {
				status: "completed",
				summary: "実際の結果",
				fulfilled: [],
				missing: [],
				refs: [],
			},
		}),
	).toBe("完了しました。\n実際の結果");
});
test("revoking a queued execution notice prevents any late conversation adoption", async () => {
	const h = await harness();
	try {
		const eventId = `execution:${crypto.randomUUID()}:final`;
		const run = await h.store.write((db) => {
			const notice = h.dialogue.notifyInTransaction(db, {
				requestId: eventId,
				conversationId: "main",
				text: "derived result",
			});
			h.dialogue.revokeExecutionNoticeInTransaction(db, eventId);
			return notice;
		});
		expect(h.dialogue.get(run.id)).toMatchObject({
			status: "cancelled",
			answerMessageId: null,
			error: "execution_source_forgotten",
		});
		expect(h.dialogue.noticeDeliveryInTransaction).toBeFunction();
		expect(
			h.store.read((db) => h.dialogue.noticeDeliveryInTransaction(db, eventId)),
		).toBe("failed");
	} finally {
		await h.close();
	}
});

test("a host question notice loses adoption permission after the question is answered, and user JSON never becomes a host notice", async () => {
	const { executionNoticeInTransaction, validExecutionNotice } =
		await import("../service/execution-notices");
	const id = crypto.randomUUID(),
		questionId = crypto.randomUUID();
	const view: any = {
		id,
		conversationId: "main",
		revision: 0,
		status: "waiting_user",
		question: { id: questionId, prompt: "confirm", expiresAt: 2000 },
		result: null,
	};
	const deps: any = {
		clock: () => new Date(1000).toISOString(),
		agents: { executions: { viewInTransaction: () => view } },
		conversation: {
			messageInTransaction: () => ({
				message: {
					text: JSON.stringify({
						kind: "task_question",
						workRef: id,
						revision: 0,
						question: { id: questionId },
						result: null,
					}),
				},
			}),
		},
	};
	const db = {} as import("bun:sqlite").Database,
		run: any = {
			sourceKind: "notice",
			conversationId: "main",
			inputMessageId: "notice",
		};
	const notice = executionNoticeInTransaction(deps, db, run)!;
	expect(notice.stale).toBe(false);
	if (notice.stale) throw Error("fixture_notice_invalid");
	view.question = null;
	view.status = "waiting_child";
	expect(validExecutionNotice(deps, db, "main", notice.binding)).toBe(false);
	expect(
		executionNoticeInTransaction(deps, db, { ...run, sourceKind: "manual" }),
	).toBeNull();
});

test("unfinished results keep the bounded execution report, including confirmed partial results", () => {
	const view: any = {
		kind: "task_result",
		status: "partial",
		question: null,
		result: {
			status: "partial",
			summary: "execution_reference_not_offered",
			code: "execution_reference_not_offered",
			fulfilled: [],
			missing: [],
			refs: [],
		},
	};
	expect(executionStoppedReply(view)).toBe("要求を完了できませんでした。");
	view.result.code = "operation_stop_unconfirmed";
	expect(executionStoppedReply(view)).toContain(
		"停止できたか確認できていません",
	);
	view.result.fulfilled = ["confirmed"];
	delete view.result.code;
	view.result.summary = "候補を取得しました。再生は行っていません。";
	expect(executionStoppedReply(view)).toContain("再生は行っていません。");
	view.kind = "task_question";
	view.result.fulfilled = [];
	expect(executionStoppedReply(view)).toBeUndefined();
	view.kind = "task_result";
	view.status = "completed";
	expect(executionStoppedReply(view)).toBeUndefined();
});

test("a failed parent delivers its host status without another inference inventing results", async () => {
	const { analysisArgs } = await import("./analysis.fixture");
	const { waitFor } = await import("../../../infrastructure/wait-for");
	const h = await harness({
		everyday: true,
		firstRound: () => ({
			name: "execute_task",
			args: {
				...analysisArgs({ kind: "action", impact: "none" }),
				request: "複数の操作を依頼する",
				contextRefs: [],
				announcement: "順に進めます。",
			},
		}),
		taskStep: () => ({ name: "unoffered_function", arguments: {} }),
		parent: () => {
			throw Error("unexpected_result_inference");
		},
	});
	try {
		await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "複数の操作を依頼する",
		});
		await waitFor(
			() =>
				h.conversation
					.get("main")
					.messages.some((m) => m.text === "要求を完了できませんでした。"),
			{ timeout: 5000 },
		);
		expect(h.toolchain.agents.executions.list("main")[0]?.status).toBe(
			"partial",
		);
		expect(h.parentContexts).toHaveLength(0);
	} finally {
		await h.close();
	}
}, 10000);

test("a partial result with confirmed facts is delivered verbatim without returning to the original request", async () => {
	const { analysisArgs } = await import("./analysis.fixture");
	const { waitFor } = await import("../../../infrastructure/wait-for");
	const summary = "候補を一件取得しました。再生は行っていません。";
	const h = await harness({
		everyday: true,
		firstRound: () => ({
			name: "execute_task",
			args: {
				...analysisArgs({ kind: "action", impact: "none" }),
				request: "候補を探して再生",
				contextRefs: [],
				announcement: "候補を探して再生します。",
			},
		}),
		taskStep: () => ({
			name: "report_partial",
			arguments: {
				summary,
				fulfilled: ["候補一件"],
				missing: ["再生"],
				refs: [],
			},
		}),
		parent: () => {
			throw Error("unexpected_partial_rephrasing");
		},
	});
	try {
		await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: "候補を探して再生",
		});
		await waitFor(
			() =>
				h.conversation
					.get("main")
					.messages.some(
						(m) => m.text === `要求を完了できませんでした。\n${summary}`,
					),
			{ timeout: 5000 },
		);
		expect(h.parentContexts).toHaveLength(0);
		expect(h.toolchain.agents.executions.list("main")[0]?.result).toMatchObject(
			{
				status: "partial",
				summary,
				fulfilled: ["候補一件"],
				missing: ["再生"],
			},
		);
	} finally {
		await h.close();
	}
}, 10000);

test("a stopped pipeline's reply names the step it stopped at and why, in the host's words", () => {
	const view = (code: string) => ({
		id: crypto.randomUUID(),
		conversationId: "main",
		request: "茹で時間を調べてタイマーと曲",
		revision: 0,
		status: "partial" as const,
		deadline: 0,
		question: null,
		pipeline: true as const,
		result: {
			status: "partial" as const,
			summary: "茹で時間を調べる: 約9分",
			fulfilled: ["茹で時間を調べる"],
			missing: ["タイマー", "曲"],
			refs: [],
			code,
		},
	});
	expect(executionStatusText(view("pipeline_step_failed"))).toBe(
		"要求を完了できませんでした。\n茹で時間を調べる: 約9分\n「タイマー」で止まりました。その手順が完了しませんでした。",
	);
	expect(
		executionStatusText(view("pipeline_extract_invalid_too_big")),
	).toContain("前の結果から値を取り出せませんでした");
});
