import { expect, test } from "vitest";
import { createOutbox, OUTBOX_TTL_MS, type OutboxEntry } from "./outbox";

const event = (id: string, extra: object = {}) => ({
	version: 1 as const,
	eventId: id,
	eventCreatedAt: "2026-10-13T12:00:00.000Z",
	eventExpiresAt: new Date(
		Date.parse("2026-10-13T12:00:00.000Z") + OUTBOX_TTL_MS,
	).toISOString(),
	artifactId: "tab",
	artifactRevisionId: "artifact:timers.workspace@1",
	source: "timer-setup",
	sourceRevision: 0,
	actionId: "timer-start",
	scopeRef: "scope:main",
	input: { hours: "0", minutes: "3", seconds: "0" },
	...extra,
});
const entry = (id: string, extra: object = {}): OutboxEntry => ({
	event: event(id, extra),
	status: "indeterminate",
});

function memoryStore() {
	const map = new Map<string, string>();
	return {
		map,
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
	};
}

const ID1 = "10000000-0000-4000-8000-000000000001";
const ID2 = "10000000-0000-4000-8000-000000000002";

test("entries survive a new outbox over the same session storage and hold no more than the event", () => {
	const store = memoryStore();
	createOutbox("api", store).put(entry(ID1));
	const reopened = createOutbox("api", store);
	expect(reopened.list()).toEqual([entry(ID1)]);
	expect(Object.keys(JSON.parse([...store.map.values()][0]!)[0])).toEqual([
		"event",
		"status",
	]);
	reopened.remove(ID1);
	expect(store.map.size).toBe(0);
	// Another API origin has its own outbox.
	createOutbox("other", store).put(entry(ID2));
	expect(createOutbox("api", store).list()).toEqual([]);
});

test("corrupt or foreign storage content is ignored", () => {
	const store = memoryStore();
	store.setItem("eumenes.toolchain-outbox.v1:api", "{not json");
	expect(createOutbox("api", store).list()).toEqual([]);
	store.setItem(
		"eumenes.toolchain-outbox.v1:api",
		JSON.stringify([{ event: { eventId: "x" }, status: "pending" }]),
	);
	expect(createOutbox("api", store).list()).toEqual([]);
});

test("blocked storage falls back to memory without throwing", () => {
	const blocked = {
		getItem() {
			throw new Error("blocked");
		},
		setItem() {
			throw new Error("blocked");
		},
		removeItem() {
			throw new Error("blocked");
		},
	};
	const outbox = createOutbox("api", blocked);
	outbox.put(entry(ID1));
	expect(outbox.list()).toEqual([entry(ID1)]);
	outbox.remove(ID1);
	expect(outbox.list()).toEqual([]);
	expect(createOutbox("api", null).list()).toEqual([]);
});

test("reusable matches only the same logical operation; foreign scope is reported", () => {
	const outbox = createOutbox("api", memoryStore());
	outbox.put(entry(ID1));
	outbox.put(entry(ID2, { scopeRef: "scope:other", actionId: "timer-pause" }));
	const like = {
		artifactRevisionId: "artifact:timers.workspace@1",
		actionId: "timer-start",
		source: "timer-setup",
		targetRef: undefined,
		input: { hours: "0", minutes: "3", seconds: "0" },
	};
	expect(outbox.reusable(like)?.event.eventId).toBe(ID1);
	expect(
		outbox.reusable({
			...like,
			input: { hours: "0", minutes: "4", seconds: "0" },
		}),
	).toBeUndefined();
	expect(
		outbox
			.foreignScope("scope:main", "artifact:timers.workspace@1")
			.map((e) => e.event.eventId),
	).toEqual([ID2]);
});
