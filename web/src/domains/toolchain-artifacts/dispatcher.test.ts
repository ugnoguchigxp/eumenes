import { afterEach, expect, test, vi } from "vitest";
import { ApiError, ApiConnectionError } from "../../../../client/transport";
import {
	createActionDispatcher,
	RECONCILE_DELAYS_MS,
	type ActionApi,
} from "./dispatcher";
import { createOutbox, OUTBOX_MAX_ENTRIES, OUTBOX_TTL_MS } from "./outbox";

afterEach(() => vi.useRealTimers());

const REV = "artifact:timers.workspace@1";
const draft = {
	actionId: "timer-start",
	source: "timer-setup",
	sourceRevision: 0,
	targetRef: undefined,
	input: { hours: "0", minutes: "3", seconds: "0" },
};
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const view = (status: string, extra: object = {}) =>
	({
		eventId: "x",
		status,
		createdAt: "2026-10-13T12:00:00.000Z",
		...extra,
	}) as never;
const result = {
	version: 1,
	outcome: "completed",
	receipt: { action: "started" },
};

function memoryStore() {
	const map = new Map<string, string>();
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
	};
}

function setup(api: Partial<ActionApi>, now = () => NOW) {
	const store = memoryStore();
	const outbox = createOutbox("api", store);
	const settled = vi.fn();
	const discarded = vi.fn();
	const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
	let n = 0;
	const dispatcher = createActionDispatcher({
		client: {
			submitToolchainAction: vi.fn(),
			toolchainAction: vi.fn(),
			unsettledToolchainActions: vi.fn(async () => []),
			...api,
		} as ActionApi,
		outbox,
		artifactId: "tab",
		artifactRevisionId: REV,
		scopeRef: "scope:main",
		onSettled: settled,
		onDiscarded: discarded,
		now,
		newId: () => `20000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
		after(ms, run) {
			const timer = { ms, run, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
	});
	return { dispatcher, outbox, settled, discarded, timers, store };
}

test("a settled start is recorded before sending, fixes its times once, and leaves the outbox", async () => {
	let during: unknown;
	const submit = vi.fn(async (_event: object) => {
		during = outbox.list().length;
		return { httpStatus: 200, view: view("accepted", { result }) };
	});
	const { dispatcher, outbox } = setup({ submitToolchainAction: submit });
	const outcome = await dispatcher.send(draft);
	expect(during).toBe(1);
	expect(outcome).toEqual({ kind: "accepted", result });
	expect(outbox.list()).toEqual([]);
	const sent = submit.mock.calls[0]![0] as unknown as Record<string, unknown>;
	expect(sent).toMatchObject({
		version: 1,
		eventId: "20000000-0000-4000-8000-000000000001",
		eventCreatedAt: "2026-10-13T12:00:00.000Z",
		eventExpiresAt: new Date(NOW + OUTBOX_TTL_MS).toISOString(),
		artifactRevisionId: REV,
		source: "timer-setup",
		sourceRevision: 0,
		actionId: "timer-start",
		scopeRef: "scope:main",
		input: draft.input,
	});
	expect(sent).not.toHaveProperty("targetRef");
});

test("a lost answer is indeterminate and a resend reuses the same event unchanged", async () => {
	let clock = NOW;
	const submit = vi
		.fn()
		.mockRejectedValueOnce(new ApiConnectionError())
		.mockResolvedValueOnce({
			httpStatus: 200,
			view: view("accepted", { result }),
		});
	const { dispatcher, outbox } = setup(
		{ submitToolchainAction: submit },
		() => clock,
	);
	expect((await dispatcher.send(draft)).kind).toBe("indeterminate");
	expect(outbox.list()[0]).toMatchObject({ status: "indeterminate" });
	clock += 60_000;
	expect((await dispatcher.send(draft)).kind).toBe("accepted");
	expect(submit).toHaveBeenCalledTimes(2);
	expect(submit.mock.calls[1]![0]).toEqual(submit.mock.calls[0]![0]);
	expect(outbox.list()).toEqual([]);
});

test("a different input is a new operation with a new id", async () => {
	const submit = vi.fn(async (_event: object) => {
		throw new ApiConnectionError();
	});
	const { dispatcher, outbox } = setup({ submitToolchainAction: submit });
	await dispatcher.send(draft);
	await dispatcher.send({
		...draft,
		input: { hours: "0", minutes: "5", seconds: "0" },
	});
	expect(outbox.list().map((e) => e.event.eventId)).toEqual([
		"20000000-0000-4000-8000-000000000001",
		"20000000-0000-4000-8000-000000000002",
	]);
});

test("a confirmed rejection is not an unknown outcome and clears the outbox", async () => {
	const { dispatcher, outbox } = setup({
		submitToolchainAction: vi.fn(async () => ({
			httpStatus: 200,
			view: view("rejected", { errorCode: "revision_conflict" }),
		})),
	});
	expect(await dispatcher.send(draft)).toEqual({
		kind: "rejected",
		code: "revision_conflict",
		fieldErrors: [],
		conflict: true,
	});
	expect(outbox.list()).toEqual([]);
});

test("field errors of a 422 are surfaced and nothing stays", async () => {
	const { dispatcher, outbox } = setup({
		submitToolchainAction: vi.fn(async () => {
			throw new ApiError(422, "invalid_input", "r", undefined, {
				error: "invalid_input",
				fieldErrors: [{ field: "durationSeconds", message: "too_small" }],
			});
		}),
	});
	expect(await dispatcher.send(draft)).toMatchObject({
		kind: "rejected",
		code: "invalid_input",
		fieldErrors: [{ field: "durationSeconds", message: "too_small" }],
	});
	expect(outbox.list()).toEqual([]);
});

test("capacity refusal keeps the event for a resend; other 503 and 5xx stay unknown", async () => {
	const submit = vi
		.fn()
		.mockRejectedValueOnce(new ApiError(503, "action_capacity"))
		.mockRejectedValueOnce(new ApiError(503, "HTTP 503"))
		.mockRejectedValueOnce(new ApiError(500, "boom"));
	const { dispatcher, outbox } = setup({ submitToolchainAction: submit });
	expect((await dispatcher.send(draft)).kind).toBe("rejected");
	expect(outbox.list()[0]).toMatchObject({ status: "retry" });
	expect((await dispatcher.send(draft)).kind).toBe("indeterminate");
	expect((await dispatcher.send(draft)).kind).toBe("indeterminate");
	expect(
		submit.mock.calls.map((c) => (c[0] as { eventId: string }).eventId),
	).toEqual([
		"20000000-0000-4000-8000-000000000001",
		"20000000-0000-4000-8000-000000000001",
		"20000000-0000-4000-8000-000000000001",
	]);
});

test("202 is pending, not accepted", async () => {
	const { dispatcher, outbox } = setup({
		submitToolchainAction: vi.fn(async () => ({
			httpStatus: 202,
			view: view("pending"),
		})),
	});
	expect((await dispatcher.send(draft)).kind).toBe("pending");
	expect(outbox.list()[0]).toMatchObject({ status: "pending" });
});

test("an unknown outcome is reconciled a few times with growing gaps, never periodically", async () => {
	const lookup = vi.fn(async () => {
		throw new ApiConnectionError();
	});
	const { dispatcher, timers } = setup({
		submitToolchainAction: vi.fn(async () => {
			throw new ApiConnectionError();
		}),
		toolchainAction: lookup,
	});
	await dispatcher.send(draft);
	for (let i = 0; i < RECONCILE_DELAYS_MS.length; i++) {
		const timer = timers.at(-1)!;
		expect(timer.ms).toBe(RECONCILE_DELAYS_MS[i]);
		timer.run();
		await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(i + 1));
		await Promise.resolve();
	}
	await vi.waitFor(() =>
		expect(timers).toHaveLength(RECONCILE_DELAYS_MS.length),
	);
});

test("reconcile reads the stored result; a missing record resends the original event", async () => {
	const submit = vi
		.fn()
		.mockRejectedValueOnce(new ApiConnectionError())
		.mockResolvedValueOnce({
			httpStatus: 200,
			view: view("accepted", { result }),
		});
	const lookup = vi
		.fn()
		.mockRejectedValueOnce(new ApiError(404, "action_not_found"));
	const { dispatcher, outbox, settled } = setup({
		submitToolchainAction: submit,
		toolchainAction: lookup,
	});
	await dispatcher.send(draft);
	await dispatcher.reconcileAll();
	expect(submit).toHaveBeenCalledTimes(2);
	expect(submit.mock.calls[1]![0]).toEqual(submit.mock.calls[0]![0]);
	expect(outbox.list()).toEqual([]);
	expect(settled).toHaveBeenCalledWith(
		expect.objectContaining({ actionId: "timer-start" }),
		{ kind: "accepted", result },
	);
});

test("reconcile uses the stored receipt without sending again", async () => {
	const submit = vi.fn().mockRejectedValue(new ApiConnectionError());
	const { dispatcher, settled } = setup({
		submitToolchainAction: submit,
		toolchainAction: vi.fn(async () => view("accepted", { result })),
	});
	await dispatcher.send(draft);
	await dispatcher.reconcileAll();
	expect(submit).toHaveBeenCalledTimes(1);
	expect(settled).toHaveBeenCalledOnce();
});

test("an expired unknown operation is dropped with a notice, never resent as new", async () => {
	let clock = NOW;
	const submit = vi.fn().mockRejectedValue(new ApiConnectionError());
	const { dispatcher, outbox, discarded } = setup(
		{
			submitToolchainAction: submit,
			toolchainAction: vi.fn(async () => {
				throw new ApiError(404, "action_not_found");
			}),
		},
		() => clock,
	);
	await dispatcher.send(draft);
	clock += OUTBOX_TTL_MS + 1;
	await dispatcher.reconcileAll();
	expect(submit).toHaveBeenCalledTimes(1);
	expect(outbox.list()).toEqual([]);
	expect(discarded).toHaveBeenCalledOnce();
});

test("an expired entry whose operation exists is still reconciled", async () => {
	let clock = NOW;
	const { dispatcher, settled } = setup(
		{
			submitToolchainAction: vi
				.fn()
				.mockRejectedValue(new ApiConnectionError()),
			toolchainAction: vi.fn(async () => view("accepted", { result })),
		},
		() => clock,
	);
	await dispatcher.send(draft);
	clock += OUTBOX_TTL_MS + 1;
	await dispatcher.reconcileAll();
	expect(settled).toHaveBeenCalledOnce();
});

test("a resend after expiry is a new, announced operation", async () => {
	let clock = NOW;
	const submit = vi.fn().mockRejectedValue(new ApiConnectionError());
	const { dispatcher, discarded } = setup(
		{ submitToolchainAction: submit },
		() => clock,
	);
	await dispatcher.send(draft);
	clock += OUTBOX_TTL_MS + 1;
	await dispatcher.send(draft);
	expect(discarded).toHaveBeenCalledOnce();
	expect((submit.mock.calls[1]![0] as { eventId: string }).eventId).not.toBe(
		(submit.mock.calls[0]![0] as { eventId: string }).eventId,
	);
});

test("entries of another scope are dropped and never sent", async () => {
	const { dispatcher, outbox, discarded } = setup({});
	outbox.put({
		status: "indeterminate",
		event: {
			version: 1,
			eventId: "30000000-0000-4000-8000-000000000001",
			eventCreatedAt: "2026-10-13T12:00:00.000Z",
			eventExpiresAt: "2026-10-14T12:00:00.000Z",
			artifactId: "tab",
			artifactRevisionId: REV,
			source: "timer-setup",
			sourceRevision: 0,
			actionId: "timer-start",
			scopeRef: "scope:someone-else",
			input: {},
		},
	});
	await dispatcher.reconcileAll();
	expect(outbox.list()).toEqual([]);
	expect(discarded).toHaveBeenCalledOnce();
});

test("a stopped dispatcher schedules nothing", async () => {
	const { dispatcher, timers } = setup({
		submitToolchainAction: vi.fn().mockRejectedValue(new ApiConnectionError()),
	});
	dispatcher.stop();
	await dispatcher.send(draft);
	expect(timers).toHaveLength(0);
});

test("every request carries a timeout signal, and an abort is an unknown outcome", async () => {
	const submit = vi.fn(async (_event: object, signal?: AbortSignal) => {
		expect(signal).toBeInstanceOf(AbortSignal);
		throw new DOMException("timeout", "TimeoutError");
	});
	const { dispatcher, outbox } = setup({
		submitToolchainAction: submit as never,
	});
	expect((await dispatcher.send(draft)).kind).toBe("indeterminate");
	expect(submit).toHaveBeenCalledOnce();
	expect(outbox.list()[0]).toMatchObject({ status: "indeterminate" });
});

test("host 503 refusals with a code are definite rejections; a bare 503 is unknown", async () => {
	const submit = vi
		.fn()
		.mockRejectedValueOnce(new ApiError(503, "artifact_unavailable"))
		.mockRejectedValueOnce(new ApiError(503, "schema_unavailable"))
		.mockRejectedValueOnce(new ApiError(503, "HTTP 503"));
	const { dispatcher, outbox } = setup({ submitToolchainAction: submit });
	expect(await dispatcher.send(draft)).toMatchObject({
		kind: "rejected",
		code: "artifact_unavailable",
	});
	expect(outbox.list()).toEqual([]);
	expect((await dispatcher.send(draft)).kind).toBe("rejected");
	expect((await dispatcher.send(draft)).kind).toBe("indeterminate");
});

test("a full outbox refuses a new send instead of dropping unconfirmed operations", async () => {
	const submit = vi.fn().mockRejectedValue(new ApiConnectionError());
	const { dispatcher, outbox } = setup({ submitToolchainAction: submit });
	for (let i = 0; i < OUTBOX_MAX_ENTRIES; i++)
		await dispatcher.send({ ...draft, input: { n: String(i) } });
	const before = outbox.list().map((row) => row.event.eventId);
	const refused = await dispatcher.send({ ...draft, input: { n: "extra" } });
	expect(refused).toMatchObject({ kind: "rejected", code: "outbox_full" });
	expect(outbox.list().map((row) => row.event.eventId)).toEqual(before);
	expect(submit).toHaveBeenCalledTimes(OUTBOX_MAX_ENTRIES);
	// A resend of one of the unconfirmed operations is still allowed.
	await dispatcher.send({ ...draft, input: { n: "0" } });
	expect(submit).toHaveBeenCalledTimes(OUTBOX_MAX_ENTRIES + 1);
});
