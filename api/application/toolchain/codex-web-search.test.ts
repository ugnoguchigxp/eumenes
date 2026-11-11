import { expect, mock, test } from "bun:test";
import type { InferenceService } from "../../domains/inference";
import type { SettingsService } from "../../domains/settings";
import { createWebAcquisition } from "../../domains/web-research";
import type { SqliteStore } from "../../infrastructure/sqlite";
import { createCodexWebSearch } from "./codex-web-search";

function fixture(abort?: AbortController) {
	const store = {
		write: async (fn: (db: unknown) => unknown) => fn({}),
	} as unknown as SqliteStore;
	const settings = {
		inTransaction: () => ({
			routes: {
				llm: { mode: "cloud-only", cloudAllowed: true, fallbackId: "resource" },
			},
			resources: [
				{ id: "resource", purpose: "llm", connectionId: "connection" },
			],
			connections: [{ id: "connection", kind: "codex-sdk", enabled: true }],
		}),
	} as unknown as SettingsService;
	const capture = mock((_db: unknown, _input: unknown) => "request");
	const accept = mock(() => true);
	const cancel = mock(async () => {});
	const execute = mock(async (..._args: unknown[]) => {
		abort?.abort();
		return {
			value: JSON.stringify({
				hits: [
					{
						url: "https://sqlite.org/foreignkeys.html#fk_enable",
						title: "SQLite foreign keys",
						snippet: "SQLite documents its foreign key checks.",
					},
					{
						url: "https://sqlite.org/foreignkeys.html",
						title: "Duplicate",
						snippet: "",
					},
					{ url: "file:///private/notes", title: "Private", snippet: "" },
				],
			}),
		};
	});
	const inference = {
		captureBackgroundControlInTransaction: capture,
		executeControl: execute,
		acceptInTransaction: accept,
		cancelSubject: cancel,
	} as unknown as InferenceService;
	return {
		search: createCodexWebSearch(store, settings, inference),
		capture,
		accept,
		cancel,
		execute,
	};
}

test("the Codex background lookup returns guarded candidates to the existing acquisition path", async () => {
	const h = fixture();
	const acquisition = createWebAcquisition({ search: h.search });
	try {
		const result = await acquisition.execute(
			{
				requestId: crypto.randomUUID(),
				operation: "lookup",
				freshness: "live",
				query: "SQLite official foreign key enforcement",
				language: "en",
				readPages: 0,
			},
			AbortSignal.timeout(5000),
		);
		expect(result.result.hits).toMatchObject([
			{
				url: "https://sqlite.org/foreignkeys.html",
				provider: "codex-sdk-web-search",
				trust: "untrusted",
				verification: "search_summary",
			},
		]);
		expect(h.capture.mock.calls[0]?.[1]).toMatchObject({
			route: { resourceId: "resource", strict: true },
			structuredOutput: true,
		});
		expect(h.execute.mock.calls[0]?.[3]).toMatchObject({
			nativeWebSearch: true,
			reasoningEffort: "low",
		});
		expect(h.accept).toHaveBeenCalledTimes(1);
	} finally {
		await acquisition.close();
	}
});

test("cancelled Codex results are not adopted", async () => {
	const abort = new AbortController();
	const h = fixture(abort);
	await expect(
		h.search.search({ query: "SQLite", signal: abort.signal }),
	).rejects.toBeDefined();
	expect(h.accept).not.toHaveBeenCalled();
	expect(h.cancel).toHaveBeenCalledTimes(1);
});
