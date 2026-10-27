import { afterEach, expect, it, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import { ApiError } from "../../../../client/transport";
import { browserApiFor } from "./api";

afterEach(() => vi.unstubAllGlobals());

const client = { identity: "http://127.0.0.1:3000" } as EumenesClient;
const summary = {
	historyId: "h1",
	revision: 1,
	title: "手続き",
	request: "依頼",
	place: "example.com",
	variables: [],
	stepCount: 1,
	runCount: 1,
	failureCount: 0,
	lastOutcome: "completed",
	hasCommit: false,
	lastUsedAt: 2,
	createdAt: 1,
	updatedAt: 2,
};

function stubFetch(status: number, body: unknown) {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}
const urlOf = (fetchMock: ReturnType<typeof stubFetch>) =>
	String((fetchMock.mock.calls[0] as unknown as [URL])[0]);

it("reads the history list from /api/browser/histories", async () => {
	const fetchMock = stubFetch(200, { histories: [summary] });
	const list = await browserApiFor({
		identity: "http://127.0.0.1:3001",
	} as EumenesClient).histories();
	expect(urlOf(fetchMock)).toBe("http://127.0.0.1:3001/api/browser/histories");
	expect(list).toEqual([summary]);
});

it("reads one history with its source by an escaped id", async () => {
	const detail = {
		...summary,
		steps: [],
		actions: [],
		source: "test('x', async () => {});",
	};
	const fetchMock = stubFetch(200, { history: detail });
	const history = await browserApiFor(client).history("a/b");
	expect(urlOf(fetchMock)).toBe(
		"http://127.0.0.1:3000/api/browser/histories/a%2Fb",
	);
	expect(history.source).toBe(detail.source);
});

it("raises a 404 as ApiError with the domain code and refuses a malformed body", async () => {
	stubFetch(404, { error: "browser_history_not_found" });
	await expect(browserApiFor(client).history("gone")).rejects.toMatchObject({
		status: 404,
		message: "browser_history_not_found",
	});
	await expect(browserApiFor(client).history("gone")).rejects.toBeInstanceOf(
		ApiError,
	);
	stubFetch(200, { histories: [{ historyId: "h1" }] });
	await expect(browserApiFor(client).histories()).rejects.toThrow();
});
