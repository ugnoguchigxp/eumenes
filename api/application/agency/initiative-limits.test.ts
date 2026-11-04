import { expect, test } from "bun:test";
import { settle, waitFor } from "../../infrastructure/wait-for";
import {
	harness,
	choice,
	exchange,
	attachLedger,
	ledgerTodo,
} from "./host.fixture";

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
