import { afterEach, expect, test, vi } from "vitest";
import { agentRuntimeClient } from "./agent-runtime";
import { createTransport } from "./transport";
afterEach(() => vi.unstubAllGlobals());
test("paged work uses authenticated API query and propagates cancellation", async () => {
	const response = {
		rows: [],
		counts: { todo: 0, done: 0, archived: 30 },
		total: 30,
		state: "archived",
		pageIndex: 1,
		pageSize: 25,
	};
	const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
		Response.json(response),
	);
	vi.stubGlobal("fetch", request);
	const api = agentRuntimeClient(
		createTransport("http://localhost:3000", "test-token"),
	);
	const controller = new AbortController();
	expect(
		await api.agencyWorkPage(
			"会話 /1",
			{ state: "archived", pageIndex: 1, pageSize: 25 },
			controller.signal,
		),
	).toEqual(response);
	const [url, init] = request.mock.calls[0]!;
	const params = new URL(String(url)).searchParams;
	expect(Object.fromEntries(params)).toEqual({
		conversationId: "会話 /1",
		state: "archived",
		pageIndex: "1",
		pageSize: "25",
	});
	expect(init?.signal).toBe(controller.signal);
	expect(new Headers(init?.headers).get("Authorization")).toBe(
		"Bearer test-token",
	);
	request.mockResolvedValueOnce(
		Response.json({ ...response, counts: { todo: -1 } }),
	);
	await expect(
		api.agencyWorkPage("c1", { state: "todo", pageIndex: 0, pageSize: 10 }),
	).rejects.toThrow();
});
