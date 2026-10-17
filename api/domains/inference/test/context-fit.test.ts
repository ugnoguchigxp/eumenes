import { afterEach, expect, test } from "bun:test";
import { configureLogging } from "../../../infrastructure/logger";
import { cleanup, setup } from "./inference.fixture";

afterEach(async () => {
	configureLogging({ level: "silent" });
	for (const close of cleanup.splice(0)) await close();
});

const turn = (i: number) => ({
	role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
	content: `turn${i}-${"x".repeat(4000)}`,
});

async function send(
	h: Awaited<ReturnType<typeof setup>>,
	list: Array<{ role: "system" | "user" | "assistant"; content: string }>,
	options: { exact: boolean; historyCount?: number },
) {
	const id = await h.store.write((db) => {
		const requestId = h.inference.captureInTransaction!(
			db,
			crypto.randomUUID(),
			"llm",
			Date.now() + 30_000,
		);
		if (options.exact)
			h.inference.setContextPolicyInTransaction!(db, requestId, "exact");
		return requestId;
	});
	await h.inference.executeStream!(
		id,
		list,
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		options.historyCount === undefined
			? undefined
			: {
					sessionRole: "main",
					context: { instructionCount: 1, historyCount: options.historyCount },
				},
	);
	return (
		JSON.parse(String(h.payloads.at(-1))) as {
			messages: Array<{ role: string; content: string }>;
		}
	).messages;
}

test("an exact request over the window drops the oldest history turns instead of failing", async () => {
	// The fixture's cloud resource has an 8192-token window: 2048 are reserved for the answer, 512 are margin.
	const h = await setup();
	const list = [
		{ role: "system" as const, content: "system" },
		...Array.from({ length: 10 }, (_, i) => turn(i)),
		{ role: "user" as const, content: "request" },
	];
	const sent = await send(h, list, { exact: true, historyCount: 10 });
	expect(sent.length).toBeLessThan(list.length);
	expect(sent[0]!.content).toBe("system");
	expect(sent.at(-1)!.content).toBe("request");
	const contents = sent.map((m) => m.content);
	expect(contents).not.toContain(list[1]!.content);
	expect(contents).toContain(list[10]!.content);
	// The newest turns are the ones that stay, in order.
	expect(contents.slice(1, -1)).toEqual(
		list.slice(list.length - 1 - (sent.length - 2), -1).map((m) => m.content),
	);
});

test("an exact request without the position of its history, or that history cannot fix, is sent as it is", async () => {
	const h = await setup();
	const big = [
		{ role: "system" as const, content: "s".repeat(40_000) },
		turn(0),
		{ role: "user" as const, content: "request" },
	];
	expect(await send(h, big, { exact: true, historyCount: 1 })).toHaveLength(2);
	const h2 = await setup();
	const list = [
		{ role: "system" as const, content: "system" },
		...Array.from({ length: 10 }, (_, i) => turn(i)),
		{ role: "user" as const, content: "request" },
	];
	expect(await send(h2, list, { exact: true })).toHaveLength(list.length);
});

test("a request the server may trim keeps the first message and the last, and fails when nothing more can go", async () => {
	const h = await setup();
	const list = [
		{ role: "system" as const, content: "system" },
		...Array.from({ length: 10 }, (_, i) => turn(i)),
		{ role: "user" as const, content: "request" },
	];
	const sent = await send(h, list, { exact: false });
	expect(sent.length).toBeLessThan(list.length);
	expect(sent[0]!.content).toBe("system");
	expect(sent.at(-1)!.content).toBe("request");
	const h2 = await setup();
	await expect(
		send(
			h2,
			[
				{ role: "system", content: "s".repeat(40_000) },
				{ role: "user", content: "request" },
			],
			{ exact: false },
		),
	).rejects.toThrow("context_window_exceeded");
});

test("the window of a captured request is the saved resource's on a cloud-only route, the held LARM lease's on a LARM route, and unknown otherwise", async () => {
	const windowOf = async (
		h: Awaited<ReturnType<typeof setup>>,
		id?: string,
	) => {
		const requestId =
			id ??
			(await h.store.write((db) =>
				h.inference.captureInTransaction!(
					db,
					crypto.randomUUID(),
					"llm",
					Date.now() + 30_000,
				),
			));
		return h.store.read((db) =>
			h.inference.llmContextWindowInTransaction!(db, requestId),
		);
	};
	// No lease is held: the LARM provider's window is not known (a claim is made only to serve a call).
	const h = await setup();
	expect(await windowOf(h)).toBeNull();
	expect(
		await windowOf(await setup({ llmContextWindow: () => null })),
	).toBeNull();
	// A lease is held: its provider's window.
	expect(await windowOf(await setup({ llmContextWindow: () => 32_768 }))).toBe(
		32_768,
	);
	// A cloud-only route uses the saved resource.
	const s = h.settings.get();
	s.routes.llm.mode = "cloud-only";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
	expect(await windowOf(h)).toBe(8192);
	expect(await windowOf(h, "missing-request")).toBeNull();
	// The saved settings alone (no request) give the same window: what the memory budget is cut from.
	expect(h.inference.savedLlmContextWindow!()).toBe(8192);
	const leased = await setup({ llmContextWindow: () => 32_768 });
	const l = leased.settings.get();
	l.routes.llm.mode = "larm-only";
	await leased.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: l.revision,
		settings: l,
		keys: [],
	});
	expect(leased.inference.savedLlmContextWindow!()).toBe(32_768);
});

test("an exact main call hands LARM where its history sits, so the oldest of it can be dropped", async () => {
	const seen: unknown[] = [];
	const h = await setup({
		local: async (_messages, _signal, options) => {
			seen.push([options?.contextPolicy, options?.history]);
			return "ok";
		},
	});
	const id = await h.store.write((db) => {
		const requestId = h.inference.captureInTransaction!(
			db,
			crypto.randomUUID(),
			"llm",
			Date.now() + 30_000,
		);
		h.inference.setContextPolicyInTransaction!(db, requestId, "exact");
		return requestId;
	});
	await h.inference.executeStream!(
		id,
		[
			{ role: "system", content: "s" },
			{ role: "user", content: "h" },
			{ role: "user", content: "r" },
		],
		new AbortController().signal,
		() => {},
		undefined,
		undefined,
		{ sessionRole: "main", context: { instructionCount: 1, historyCount: 1 } },
	);
	expect(seen).toEqual([["exact", { instructionCount: 1, historyCount: 1 }]]);
});

test("history is dropped by whole exchanges, so what is sent never starts with an assistant message", async () => {
	const h = await setup();
	const text = (tag: string) => `${tag}-${"x".repeat(4000)}`;
	// The first run had no answer: two user messages in a row, then exchanges.
	const history = [
		{ role: "user" as const, content: text("unanswered") },
		...Array.from({ length: 4 }, (_, i) => [
			{ role: "user" as const, content: text(`q${i}`) },
			{ role: "assistant" as const, content: text(`a${i}`) },
		]).flat(),
	];
	for (const exact of [true, false]) {
		const list = [
			{ role: "system" as const, content: "system" },
			...history,
			{ role: "user" as const, content: "request" },
		];
		const sent = await send(h, list, {
			exact,
			historyCount: history.length,
		});
		expect(sent.length).toBeLessThan(list.length);
		expect(sent[0]!.content).toBe("system");
		expect(sent.at(-1)!.content).toBe("request");
		expect(sent[1]!.role).toBe("user");
	}
});
