import { afterEach, expect, test, vi } from "vitest";
import { createShowcaseFixture } from "..";
import type { ArtifactEvent } from "@eumenes/artifact-ui/contracts";
afterEach(() => vi.useRealTimers());
test("cancelled asynchronous image completion never replaces placeholder", async () => {
	vi.useFakeTimers();
	const fixture = createShowcaseFixture();
	fixture.startImage();
	await vi.advanceTimersByTimeAsync(60);
	expect(fixture.getSnapshot().resources.g1).toMatchObject({
		status: "running",
	});
	fixture.imageState("cancelled");
	await vi.advanceTimersByTimeAsync(600);
	expect(fixture.getSnapshot().resources.g1).toMatchObject({
		status: "cancelled",
	});
	expect(fixture.getSnapshot().events).toContain("取消後の古い画像を無視");
	fixture.dispose();
});
test("duplicate submissions mutate once and stale revisions are refused", async () => {
	vi.useFakeTimers();
	const fixture = createShowcaseFixture();
	const event: ArtifactEvent = {
		id: "one",
		source: "q1",
		revision: 0,
		action: "answer",
		values: { answer: "短く" },
	};
	const first = fixture.dispatch(event);
	expect((await fixture.dispatch(event)).status).toBe("duplicate");
	await vi.advanceTimersByTimeAsync(200);
	expect((await first).status).toBe("accepted");
	expect(fixture.getSnapshot().resources.q1).toMatchObject({
		revision: 1,
		status: "answered",
	});
	const stale = fixture.dispatch({ ...event, id: "two" });
	await vi.advanceTimersByTimeAsync(200);
	expect((await stale).status).toBe("conflict");
	fixture.dispose();
});
test("reset rejects outstanding form submission", async () => {
	vi.useFakeTimers();
	const fixture = createShowcaseFixture();
	const request = fixture.dispatch({
		id: "reset",
		source: "f1",
		revision: 0,
		action: "submit",
		values: { name: "old" },
	});
	fixture.reset();
	await vi.advanceTimersByTimeAsync(200);
	expect((await request).status).toBe("conflict");
	expect(fixture.getSnapshot().resources.f1).not.toHaveProperty("submitted");
	fixture.dispose();
});
test("fixture validates action payloads at the host boundary", async () => {
	vi.useFakeTimers();
	const fixture = createShowcaseFixture();
	for (const [source, action, values] of [
		["f1", "submit", { name: "", unexpected: "x" }],
		["s1", "settings-save", { theme: "dark", autoSpeak: true, volume: "200" }],
		["m1", "memory-correct", { id: "unknown", text: "x" }],
	] as const) {
		const pending = fixture.dispatch({
			id: source,
			source,
			action,
			revision: 0,
			values,
		});
		await vi.advanceTimersByTimeAsync(200);
		expect((await pending).status).toBe("rejected");
	}
	fixture.dispose();
});

test("operation history follows pending, failure and retry without recording input values", async () => {
	vi.useFakeTimers();
	const fixture = createShowcaseFixture();
	fixture.configure({ failNext: true });
	const event: ArtifactEvent = {
		id: "failed",
		source: "f1",
		revision: 0,
		action: "submit",
		values: { name: "local input" },
	};
	const first = fixture.dispatch(event);
	expect(fixture.getSnapshot().operations).toMatchObject([
		{ action: "submit", source: "f1", status: "pending" },
	]);
	await vi.advanceTimersByTimeAsync(200);
	expect((await first).status).toBe("rejected");
	expect(fixture.getSnapshot().operations[0]).toMatchObject({
		status: "rejected",
	});
	const retry = fixture.dispatch({ ...event, id: "retry" });
	await vi.advanceTimersByTimeAsync(200);
	expect((await retry).status).toBe("accepted");
	expect(
		fixture.getSnapshot().operations.map((operation) => operation.status),
	).toEqual(["accepted", "rejected"]);
	expect(JSON.stringify(fixture.getSnapshot().operations)).not.toContain(
		"local input",
	);
	await fixture.dispatch({ ...event, id: "retry" });
	expect(fixture.getSnapshot().operations).toHaveLength(2);
	fixture.dispose();
});

test("resetting one sample clears its result and history while retaining other samples", async () => {
	vi.useFakeTimers();
	const fixture = createShowcaseFixture();
	const events: Omit<ArtifactEvent, "revision">[] = [
		{
			id: "form",
			source: "f1",
			action: "submit",
			values: { name: "retained" },
		},
		{
			id: "demo",
			source: "c1",
			action: "demo-click",
			values: { example: "clear me" },
		},
	];
	for (const event of events) {
		const request = fixture.dispatch({ ...event, revision: 0 });
		await vi.advanceTimersByTimeAsync(200);
		await request;
	}
	fixture.resetSource("c1");
	expect(fixture.getSnapshot().resources.c1).not.toHaveProperty("example");
	expect(fixture.getSnapshot().resources.f1).toMatchObject({
		submitted: { name: "retained" },
	});
	expect(
		fixture.getSnapshot().operations.map((operation) => operation.source),
	).toEqual(["f1"]);
	fixture.dispose();
});
