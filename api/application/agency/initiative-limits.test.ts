import { expect, test } from "bun:test";
import { settle, waitFor } from "../../infrastructure/wait-for";
import {
	harness,
	choice,
	exchange,
	attachLedger,
	ledgerTodo,
	updated,
	pendingUpdate,
} from "./host.fixture";

test("three invalid idle selections consume only their bounded technical retries", async () => {
	let valid = false;
	const h = harness({
		update: (r) => {
			const data = JSON.parse(r.prompt);
			return data.state.candidates.length ? updated() : pendingUpdate(data);
		},
		select: () =>
			valid ? choice("wait") : choice("speak", { refs: ["unknown"] }),
	});
	await exchange(h, 1);
	await waitFor(() => h.calls.select === 1);
	await settle();
	for (const span of [20000, 40000, 80000]) await h.advance(span);
	expect(h.host.inspect("c1")?.idle).toMatchObject({
		blockedBy: "retry_limit",
		level: 0,
		unanswered: 0,
	});
	expect(h.spoke).toHaveLength(0);
	const calls = h.calls.select;
	await h.advance(120000);
	expect(h.calls.select).toBe(calls);
	valid = true;
	await exchange(h, 2);
	await waitFor(() => h.calls.select > calls);
	await settle();
	await h.advance(20000);
	expect(h.host.inspect("c1")?.idle).toMatchObject({
		blockedBy: null,
		level: 1,
	});
});

for (const persistent of [false, true]) {
	test(`slow selection respects the actual delivery interval (durable=${persistent})`, async () => {
		let first = true;
		const h = harness({
			persistent,
			settings: { maxUnanswered: 3 },
			select: () => {
				if (first) {
					first = false;
					h.advanceClock(70000);
				}
				return choice("speak", { refs: ["u1"] });
			},
		});
		let ask = false;
		attachLedger(h, () =>
			ask ? [ledgerTodo("t", "waiting", { question: "question" })] : [],
		);
		await exchange(h, 1);
		await waitFor(() => h.spoke.length === 1);
		await settle();
		ask = true;
		h.advanceClock(1);
		await h.store.write((db) => {
			db.run("CREATE TABLE standin(x int)");
			db.run("INSERT INTO standin VALUES (1)");
			h.host.dialoguePort.workChangedInTransaction(db, "c1");
		});
		await waitFor(() => h.calls.select === 2);
		await settle();
		expect(h.spoke).toHaveLength(1);
		await h.advance(60000);
		await waitFor(() => h.spoke.length === 2);
		const times = h.spoke.map((x) => Date.parse(String(x.at)));
		expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(60000);
	});
}
