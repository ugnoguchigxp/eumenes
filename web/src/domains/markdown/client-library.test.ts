import { afterEach, expect, test, vi } from "vitest";
import { markdownLibraryClient } from "../../../../client/markdown-library";
import type { Transport } from "../../../../client/transport";
import { libraryPage } from "../../../../api/domains/markdown/contracts";
afterEach(() => vi.unstubAllGlobals());
const etag = '"' + "a".repeat(64) + '"',
	id = "folder-" + "a".repeat(32);
const page = {
	namespace: "eumenes",
	path: "",
	etag,
	entries: [
		{
			kind: "folder",
			id,
			namespace: "eumenes",
			path: "空",
			name: "空",
			etag,
			documentCount: 0,
			folderCount: 0,
			hasUnsupportedEntries: false,
			updatedAt: "2026-11-09T00:00:00+09:00",
		},
	],
	nextCursor: null,
};
test("the browser can validate folder responses without a Node Buffer global", () => {
	vi.stubGlobal("Buffer", undefined);
	expect(libraryPage.parse(page)).toEqual(page);
});
test("the typed client preserves folder IDs, library ETags and opaque query values", async () => {
	const call = vi.fn(async (_path: string, _init?: RequestInit) =>
			Response.json(page),
		),
		client = markdownLibraryClient({ call } as unknown as Transport);
	expect(
		await client.markdownFiles({
			namespace: "eumenes",
			path: "",
			cursor: "次/+= ",
		}),
	).toEqual(page);
	const url = new URL(call.mock.calls[0]![0] as string, "http://localhost");
	expect(url.searchParams.get("cursor")).toBe("次/+= ");
	expect(call).toHaveBeenCalledTimes(1);
});
test("management staging carries fixed request and copy IDs without an extra write", async () => {
	const stageId = crypto.randomUUID(),
		call = vi.fn(async (_path: string, _init?: RequestInit) =>
			Response.json({ id: stageId }),
		),
		client = markdownLibraryClient({ call } as unknown as Transport),
		input = {
			requestId: crypto.randomUUID(),
			command: {
				op: "create-folder" as const,
				id,
				namespace: "eumenes",
				path: "空",
			},
		};
	expect(await client.markdownStageManagement(input)).toEqual({ id: stageId });
	expect(call).toHaveBeenCalledTimes(1);
	expect(call.mock.calls[0]![0]).toBe("/api/markdown/management-inputs");
	expect(
		JSON.parse(String((call.mock.calls[0]![1] as RequestInit).body)),
	).toEqual(input);
});
