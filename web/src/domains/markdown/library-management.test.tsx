import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type PropsWithChildren } from "react";
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
function mount(
	enabled = true,
	initialNamespaces = ["eumenes"],
	strict = false,
) {
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
			markdownFiles: vi.fn(
				async (
					_input: { namespace: string; path: string },
					_signal?: AbortSignal,
				) => page,
			),
			markdownOperations: vi.fn(async () => [result]),
			markdownManage: vi.fn(async () => result),
			markdownCheck: vi.fn(async () => result),
		},
		refresh = vi.fn(),
		setTargetRef = vi.fn(),
		query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const hook = renderHook(
		(namespaces) =>
			useLibraryManagement({
				client: client as unknown as EumenesClient,
				features: enabled ? features : undefined,
				namespaces,
				visible: true,
				selected: "local",
				refresh,
				setTargetRef,
			}),
		{
			initialProps: initialNamespaces,
			wrapper: ({ children }: PropsWithChildren) => (
				<QueryClientProvider client={query}>
					{strict ? <StrictMode>{children}</StrictMode> : children}
				</QueryClientProvider>
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
test("discovering the first namespace does not replace an explicit folder load with the root", async () => {
	const h = mount(true, []);
	const page = { ...h.page, path: "仕事/企画" };
	let complete!: (page: typeof h.page) => void;
	h.client.markdownFiles.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				complete = resolve;
			}),
	);
	let loading!: Promise<unknown>;
	act(() => {
		loading = h.result.current.local(
			event("markdown-files", { namespace: "eumenes", path: page.path }),
		);
	});
	h.rerender(["eumenes"]);
	expect(h.client.markdownFiles).toHaveBeenCalledTimes(1);
	expect(h.client.markdownFiles.mock.calls[0]?.[1]?.aborted).toBe(false);
	await act(async () => {
		complete(page);
		await loading;
	});
	expect(h.result.current.files?.path).toBe(page.path);
});
test("StrictMode can load the initial root after the first effect is cancelled", async () => {
	const h = mount(true, ["eumenes"], true);
	await waitFor(() => expect(h.result.current.files).toEqual(h.page));
	expect(h.client.markdownFiles.mock.calls.at(-1)?.[1]?.aborted).toBe(false);
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
