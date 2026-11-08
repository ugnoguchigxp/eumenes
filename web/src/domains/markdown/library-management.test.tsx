import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import type { EumenesClient } from "../../../../client";
import type { LibraryFeatures } from "../../../../api/domains/markdown/contracts";
import { ApiError } from "../../../../client/transport";
import { useLibraryManagement, managementMessage } from "./library-management";
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	localStorage.clear();
});
const features: LibraryFeatures = {
	library: true,
	folders: true,
	folderCopy: true,
	patch: true,
	copy: true,
	delete: true,
	createFolder: true,
	recursiveDelete: true,
	batch: true,
	maxBatchItems: 100,
	maxAffectedItems: 500,
	maxCopyBytes: 20971520,
};
function mount(enabled = true) {
	const page = {
		namespace: "eumenes",
		path: "",
		etag: '"' + "a".repeat(64) + '"',
		entries: [],
		nextCursor: "next",
	};
	const result = {
		id: crypto.randomUUID(),
		state: "unknown" as string,
		code: null,
		command: {},
		removedWorkspaceIds: [] as string[],
	};
	const client = {
			identity: crypto.randomUUID(),
			markdownFiles: vi.fn(async () => page),
			markdownOperations: vi.fn(async () => [result]),
			markdownManage: vi.fn(async () => result),
			markdownCheck: vi.fn(async () => result),
		},
		refresh = vi.fn(),
		setTargetRef = vi.fn(),
		query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const hook = renderHook(
		() =>
			useLibraryManagement({
				client: client as unknown as EumenesClient,
				features: enabled ? features : undefined,
				namespaces: ["eumenes"],
				visible: true,
				selected: "local",
				refresh,
				setTargetRef,
			}),
		{
			wrapper: ({ children }: PropsWithChildren) => (
				<QueryClientProvider client={query}>{children}</QueryClientProvider>
			),
		},
	);
	return { ...hook, client, page, outcome: result, refresh, setTargetRef };
}
const event = (
	action: "markdown-manage" | "markdown-check" | "markdown-files",
	values: Record<string, string>,
) => ({
	id: crypto.randomUUID(),
	source: "markdown-workspace",
	revision: 1,
	action,
	values,
});
test("old capabilities never probe extension reads or mutations", async () => {
	const h = mount(false);
	await act(async () => {});
	expect(h.client.markdownFiles).not.toHaveBeenCalled();
	expect(h.client.markdownOperations).not.toHaveBeenCalled();
	expect(h.client.markdownManage).not.toHaveBeenCalled();
});
test("changing page ETags invalidates the assembled selection instead of mixing snapshots", async () => {
	const h = mount();
	await waitFor(() => expect(h.result.current.files).toBeDefined());
	h.client.markdownFiles.mockResolvedValueOnce({
		...h.page,
		etag: '"' + "b".repeat(64) + '"',
	});
	await act(() =>
		h.result.current.local(
			event("markdown-files", {
				namespace: "eumenes",
				path: "",
				cursor: "next",
			}),
		),
	);
	expect(h.result.current.files).toBeUndefined();
	expect(h.result.current.filesError).toContain("取得中に一覧が更新");
});
test("unknown receipt retains draft and target; explicit read-only confirmation clears only deleted work", async () => {
	const h = mount();
	await waitFor(() => expect(h.result.current.files).toBeDefined());
	localStorage.setItem("eumenes:markdown:draft:local", "draft");
	await act(() =>
		h.result.current.local(event("markdown-manage", { stageId: "stage" })),
	);
	expect(h.client.markdownManage).toHaveBeenCalledTimes(1);
	expect(h.client.markdownManage).toHaveBeenCalledWith({ stageId: "stage" });
	expect(localStorage.getItem("eumenes:markdown:draft:local")).toBe("draft");
	expect(h.setTargetRef).not.toHaveBeenCalled();
	h.client.markdownCheck.mockResolvedValueOnce({
		...h.outcome,
		state: "confirmed",
		removedWorkspaceIds: ["local"],
	});
	await act(() =>
		h.result.current.local(event("markdown-check", { id: h.outcome.id })),
	);
	expect(h.client.markdownManage).toHaveBeenCalledTimes(1);
	expect(h.setTargetRef).toHaveBeenCalledWith(undefined);
	expect(localStorage.getItem("eumenes:markdown:draft:local")).toBeNull();
});
test("known rejection messages keep conflict, unsupported items, limits and permissions distinct", () => {
	expect(
		managementMessage(new ApiError(412, "markdown_etag_mismatch")),
	).toContain("更新");
	expect(
		managementMessage(new ApiError(409, "markdown_unsupported_items")),
	).toContain("Markdown以外");
	expect(managementMessage(new ApiError(413, "payload_too_large"))).toContain(
		"上限",
	);
	expect(managementMessage(new ApiError(403, "forbidden"))).toContain("権限");
});
