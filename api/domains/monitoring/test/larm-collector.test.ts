import { expect, test } from "bun:test";
import { collectorHarness, idleSnapshot, eventsPage } from "./larm.fixture";
test("demand starts collection; screens share it; restart retains cursor, cadence and deduplicated cancellation", async () => {
	const h = collectorHarness();
	expect(h.calls).toHaveLength(0);
	const [a, b] = await Promise.all([h.collector.read(), h.collector.read()]);
	expect(a).toEqual(b);
	expect(h.calls).toHaveLength(2);
	expect(a.history.results).toEqual({
		succeeded: "0",
		failed: "0",
		timed_out: "0",
		cancelled: "1",
		rejected: "0",
	});
	expect(JSON.stringify(a)).not.toContain("existing-control-canary");
	expect(JSON.stringify(a)).not.toContain("nextCursor");
	await h.reopen();
	await h.collector.read();
	expect(h.calls).toHaveLength(2);
	h.advance();
	await h.collector.read();
	expect(h.calls).toHaveLength(4);
	expect(h.calls[3]!.searchParams.get("cursor")).toBe(eventsPage().nextCursor);
	expect((await h.collector.read()).history.results.cancelled).toBe("1");
});
test("a failed page resumes its checkpoint next minute without replay", async () => {
	const h = collectorHarness();
	let page = 0;
	h.setEvents(async (url) => {
		page++;
		if (page === 2) return Response.json({}, { status: 503 });
		const p = eventsPage();
		p.hasMore = page === 1;
		p.nextCursor = page === 1 ? "page-1" : "end";
		if (page === 3) {
			expect(url.searchParams.get("cursor")).toBe("page-1");
			p.events = [];
		}
		return Response.json(p);
	});
	const a = await h.collector.read();
	expect(a.eventsStatus.status).toBe("unavailable");
	expect(a.snapshotStatus.status).toBe("ok");
	expect(a.history.hasMore).toBe(true);
	await h.collector.read();
	expect(page).toBe(2);
	h.advance();
	const b = await h.collector.read();
	expect(b.history.hasMore).toBe(false);
	expect(b.history.results.cancelled).toBe("1");
});
test("410 and boot changes record gaps; recovery waits for the next poll and never mixes epochs", async () => {
	const h = collectorHarness();
	await h.collector.read();
	h.advance();
	h.setEvents(async () =>
		Response.json(
			{
				error: {
					code: "monitoring_cursor_expired",
					message: "expired",
					bootEpoch: "epoch-example",
					reasonCode: "retention_expired",
					supportedContractVersions: ["larm-monitoring.v1"],
					recovery: "restart_window",
				},
			},
			{ status: 410 },
		),
	);
	const a = await h.collector.read();
	expect(a.gaps.map((g) => g.reason)).toContain("monitoring_cursor_expired");
	const count = h.calls.length;
	await h.collector.read();
	expect(h.calls).toHaveLength(count);
	h.advance();
	h.setEvents(async (url) => {
		expect(url.searchParams.has("cursor")).toBe(false);
		return Response.json(eventsPage());
	});
	await h.collector.read();
	h.advance();
	h.setSnapshot(async () => {
		const s = idleSnapshot();
		s.bootEpoch = "new-epoch";
		s.eventStream.streamId = "new-stream";
		return Response.json(s);
	});
	const b = await h.collector.read();
	expect(b.eventsStatus.status).toBe("epoch_mismatch");
	expect(b.history.faults).toHaveLength(0);
	expect(b.gaps.map((g) => g.reason)).toContain("monitoring_epoch_changed");
});
test("Retry-After is respected and snapshot failure does not discard event results", async () => {
	const h = collectorHarness();
	h.setSnapshot(async () =>
		Response.json({}, { status: 429, headers: { "Retry-After": "120" } }),
	);
	const a = await h.collector.read();
	expect(a.snapshotStatus.status).toBe("rate_limited");
	expect(a.eventsStatus.status).toBe("ok");
	h.advance();
	await h.collector.read();
	expect(h.calls).toHaveLength(2);
	h.advance();
	await h.collector.read();
	expect(h.calls).toHaveLength(4);
});
test("a changed source cancels an old pending fetch and rejects its late result", async () => {
	const h = collectorHarness();
	let release!: (r: Response) => void;
	h.setSnapshot(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const pending = h.collector.read();
	while (!h.calls.length) await Bun.sleep(1);
	h.configure({ baseUrl: null, token: "existing-control-canary" });
	release(Response.json(idleSnapshot()));
	const a = await pending;
	expect(a.snapshot).toBeUndefined();
	expect(a.snapshotStatus.status).toBe("unconfigured");
	expect(h.calls).toHaveLength(1);
});
test("a delayed success cannot replace a cancellation; coverage gaps remain visible", async () => {
	const h = collectorHarness();
	h.setEvents(async () => {
		const p = eventsPage(),
			e = structuredClone(p.events[1]!);
		e.id = "epoch-example:43";
		e.sequence = "43";
		e.outcome = "succeeded";
		p.window.highWaterSequence = "43";
		p.events.push(e);
		p.coverage[0]!.status = "error";
		return Response.json(p);
	});
	const a = await h.collector.read();
	expect(a.history.results.cancelled).toBe("1");
	expect(a.history.results.succeeded).toBe("0");
	expect(a.history.coverageComplete).toBe(false);
	expect(a.gaps.map((g) => g.reason)).toContain("coverage_gap");
});
