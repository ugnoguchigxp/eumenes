import { expect, test } from "bun:test";
import { createReportIdlePlanner } from "./report-idle";
import {
	attachLedger,
	choice,
	exchange,
	harness,
	ledgerTodo,
} from "./host.fixture";
import { settle, waitFor } from "../../infrastructure/wait-for";

test("completed work can be reported after social speech exhausted its allowance, and keeps pause and busy fences", () => {
	let pending = false;
	const planner = createReportIdlePlanner(
		{ idleSec: 20, maxUnanswered: 1 },
		0,
		() => pending,
	);
	planner.proactiveSpoke(0);
	expect(planner.delayMs(20_000)).toBeNull();
	pending = true;
	expect(planner.delayMs(20_000)).toBe(0);
	expect(planner.reportsOnly()).toBe(true);
	planner.reportSpoke(20_000);
	expect(planner.delayMs(40_000)).toBe(0);
	planner.enter();
	expect(planner.delayMs(40_000)).toBeNull();
	planner.leave(40_000);
	planner.setPaused(true, 40_000);
	expect(planner.delayMs(60_000)).toBeNull();
	planner.setPaused(false, 60_000);
	pending = false;
	expect(planner.blockedBy()).toBe("unanswered");
});

test("two completed TODO reports do not consume the social allowance", async () => {
	const h = harness();
	let ready = false;
	attachLedger(h, () =>
		ready
			? ["first", "second"]
					.filter(
						(id) =>
							!h.spoke.some((s) =>
								(s.todoRefs as string[] | undefined)?.includes(id),
							),
					)
					.map((id) =>
						ledgerTodo(id, "done", {
							outcome: "succeeded",
							result: { summary: "完了" },
						}),
					)
			: [],
	);
	await exchange(h, 1);
	await waitFor(() => h.calls.select === 1);
	await settle();
	ready = true;
	h.advanceClock(60_000);
	h.setSelect((request) =>
		choice("speak", {
			utterance: "仕事ができました。",
			refs: [
				String(request.prompt).includes("[todo:first]")
					? "todo:first"
					: "todo:second",
			],
		}),
	);
	await h.store.write((db) => {
		db.run("CREATE TABLE changed(n INTEGER)");
		db.run("INSERT INTO changed VALUES (1)");
		h.host.dialoguePort.workChangedInTransaction(db, "c1");
	});
	await waitFor(() => h.spoke.length === 1);
	await settle();
	await h.advance(60_000);
	expect(h.spoke).toHaveLength(2);
	expect(h.spoke.map((s) => s.todoRefs)).toEqual([["first"], ["second"]]);
	expect(h.host.inspect("c1")?.idle.unanswered).toBe(0);
});

test("after social allowance is exhausted, a report opportunity cannot emit unrelated chatter", async () => {
	const h = harness({ select: () => choice("speak", { refs: ["u1"] }) });
	await exchange(h, 1);
	await waitFor(() => h.spoke.length === 1);
	await settle();
	expect(h.host.inspect("c1")?.idle.blockedBy).toBe("unanswered");
	attachLedger(h, () => [
		ledgerTodo("report", "done", {
			outcome: "succeeded",
			result: { summary: "完了" },
		}),
	]);
	h.advanceClock(60_000);
	await h.store.write((db) => {
		db.run("CREATE TABLE changed(n INTEGER)");
		db.run("INSERT INTO changed VALUES (1)");
		h.host.dialoguePort.workChangedInTransaction(db, "c1");
	});
	await waitFor(() => h.calls.select === 2);
	await settle();
	expect(h.spoke).toHaveLength(1);
	h.setSelect(() =>
		choice("speak", { utterance: "報告します。", refs: ["todo:report"] }),
	);
	await h.advance(60_000);
	expect(h.spoke).toHaveLength(2);
	expect(h.spoke[1]?.todoRefs).toEqual(["report"]);
});
