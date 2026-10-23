import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ExecutionWorkItem } from "../../domains/agent-runtime";
import { createAgencyWork, hostTodoOf } from "./work";

const item = (over: Partial<ExecutionWorkItem>): ExecutionWorkItem => ({
	id: "e1",
	conversationId: "c1",
	request: "夜のドライブ向けの曲を作って",
	status: "completed",
	pipeline: false,
	resultSummary: "3分12秒の曲ができた",
	createdAt: 100,
	updatedAt: 200,
	heldEventId: "ev1",
	...over,
});

test("work items map to agency TODOs: open → todo, held → done with outcome and result", () => {
	expect(hostTodoOf(item({ heldEventId: null, status: "deciding" }))).toEqual({
		id: "e1",
		title: "夜のドライブ向けの曲を作って",
		status: "todo",
		requestedAt: 100,
	});
	expect(hostTodoOf(item({ pipeline: true }))).toEqual({
		id: "e1",
		title: "（パイプライン）夜のドライブ向けの曲を作って",
		status: "done",
		outcome: "succeeded",
		result: "3分12秒の曲ができた",
		requestedAt: 100,
		doneAt: 200,
	});
	expect(hostTodoOf(item({ status: "partial" })).outcome).toBe("partial");
	expect(hostTodoOf(item({ status: "interrupted" })).outcome).toBe("failed");
	expect(hostTodoOf(item({ resultSummary: null }))).not.toHaveProperty(
		"result",
	);
	expect(hostTodoOf(item({ request: "あ".repeat(100) })).title.length).toBe(60);
});

test("releasing sends the held notice once; a report without a dialogue source is settled instead", () => {
	const held = [
		{ eventId: "ev1", executionId: "e1", conversationId: "c1", heldAt: 1 },
		{ eventId: "ev2", executionId: "e2", conversationId: "c1", heldAt: 2 },
	];
	const released = new Set<string>();
	const settled: string[] = [];
	const notices: Array<{ requestId: string; conversationId: string }> = [];
	const work = createAgencyWork({
		agents: {
			executions: {
				workItemsInTransaction: () => [],
				heldReportsInTransaction: () =>
					held.filter((r) => !released.has(r.eventId)),
				releaseReportInTransaction: (_db: Database, eventId: string) =>
					released.has(eventId) ? false : (released.add(eventId), true),
				settleEventInTransaction: (_db: Database, eventId: string) => {
					settled.push(eventId);
				},
				viewInTransaction: (_db: Database, id: string) =>
					({
						id,
						conversationId: "c1",
						request: "r",
						revision: 0,
						status: "completed",
						deadline: 0,
						question: null,
						result: null,
					}) as never,
				sourceRunInTransaction: (_db: Database, id: string) =>
					id === "e1" ? "run-1" : null,
			} as never,
		},
		dialogue: {
			executionSourceInTransaction: ((_db: Database, runId: string) =>
				runId === "run-1" ? ({} as never) : null) as never,
			notifyInTransaction: ((
				_db: Database,
				input: { requestId: string; conversationId: string },
			) => {
				notices.push({
					requestId: input.requestId,
					conversationId: input.conversationId,
				});
				return {} as never;
			}) as never,
		},
	});
	const db = {} as Database;
	expect(work.releaseInTransaction(db, "c1", ["e1", "e2"])).toBe(1);
	expect(notices).toEqual([{ requestId: "ev1", conversationId: "c1" }]);
	expect(settled).toEqual(["ev2"]);
	// already released: nothing more
	expect(work.releaseAllInTransaction(db)).toBe(0);
	expect(notices).toHaveLength(1);
});
