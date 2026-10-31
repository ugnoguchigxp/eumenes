import { expect, test } from "bun:test";
import { setup, until } from "./live.fixture";
import { liveUsageInTransaction } from "..";
const records = (h: Awaited<ReturnType<typeof setup>>) =>
	h.store.read((db) => liveUsageInTransaction(db, 0, Date.now() + 86400000));
test("cumulative usage is persisted once, regressions and malformed finals stay unconfirmed", async () => {
	const h = await setup();
	try {
		const id = await h.start(true);
		for (const seconds of [12, 15, 15, 9, -1, "18"])
			h.peer.event({ type: "session.usage.updated", usage: { seconds } });
		await until(() => records(h)[0]?.seconds === 15);
		h.peer.event({ type: "session.closed", usage: { seconds: 14 } });
		await until(() => h.service.state(id)?.status === "closed");
		expect(records(h)[0]).toMatchObject({
			seconds: 15,
			confirmed: 0,
			model: "fixture-voice",
			connectionName: "Fixture",
			test: 1,
		});
		expect(records(h)[0]!.endedAt).not.toBeNull();
		expect(h.service.state(id)?.segments).toEqual([]);
	} finally {
		await h.close();
	}
});
test("final duration replaces interim duration and interruption preserves the last API reading", async () => {
	for (const final of [true, false]) {
		const h = await setup();
		try {
			const id = await h.start();
			h.peer.event({ type: "session.usage.updated", usage: { seconds: 15 } });
			await until(() => records(h)[0]?.seconds === 15);
			if (final)
				h.peer.event({ type: "session.closed", usage: { seconds: 18 } });
			else h.peer.close();
			await until(() =>
				["closed", "interrupted"].includes(h.service.state(id)!.status),
			);
			expect(records(h)[0]).toMatchObject({
				seconds: final ? 18 : 15,
				confirmed: final ? 1 : 0,
			});
		} finally {
			await h.close();
		}
	}
});
