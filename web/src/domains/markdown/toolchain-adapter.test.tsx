import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useState, type PropsWithChildren } from "react";
import type { AdapterHostContext } from "../toolchain-artifacts/registry";
import { markdownWebAdapter } from "./toolchain-adapter";

const { importer } = vi.hoisted(() => ({
	importer: vi.fn((text: string) => ({
		formatVersion: 1,
		nodes: [{ type: "p", children: [{ text }] }],
		originalMarkdown: text,
	})),
}));
vi.mock("@eumenes/design-system/markdown", () => ({
	importMarkdown: importer,
}));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
const remoteId = `wiki-${"a".repeat(32)}`,
	localId = "3ec73122-dc3c-4789-b5d0-cc35e02a2d7b";
const generatedId = "generated-research-document";
const entry = {
	sourceId: remoteId,
	title: "確認",
	revision: '"' + "b".repeat(64) + '"',
	path: "確認.md",
	namespace: "eumenes",
	contentDigest: "c".repeat(64),
};
function mount(empty = false, generated?: "remote" | "local") {
	const markdown = "\uFEFF# 日本語\r\n末尾  \r\n",
		document = importer(markdown);
	importer.mockClear();
	const client = {
		identity: crypto.randomUUID(),
		toolchainArtifactSource: vi.fn(
			async (_artifact: string, _source: string, targetRef?: string) => ({
				revision: 0,
				data: {
					kind: "markdown-workspace",
					revision: 0,
					current:
						targetRef === localId
							? {
									id: localId,
									title: entry.title,
									document,
									revision: 1,
									sourceId: remoteId,
									markdown,
									remote: null,
									conflict: null,
									dirty: false,
									saveState: "saved",
									saveError: null,
								}
							: null,
					documents: [],
					archiveAvailable: true,
					...(targetRef !== generatedId
						? {}
						: generated === "remote"
							? { openSourceId: remoteId }
							: { preview: { title: entry.title, markdown } }),
				},
			}),
		),
		markdownCapabilities: vi.fn(async () => ({
			maxMarkdownBytes: 8388608,
			maxRecoveryBytes: 8388608,
			maxRequestBytes: 20971520,
			maxPageSize: 100,
		})),
		markdownPreview: vi.fn(async () => ({
			entry,
			markdown,
			recovery: empty ? "" : JSON.stringify(document),
			document: empty ? null : document,
		})),
		markdownStage: vi.fn(async () => ({ id: "import-stage" })),
		markdownOpen: vi.fn(async () => ({ id: localId })),
		markdownLibrary: vi.fn(async (_signal?: AbortSignal, cursor?: string) => ({
			items: [
				{ ...entry, sourceId: cursor ? `wiki-${"d".repeat(32)}` : remoteId },
			],
			namespaces: ["eumenes"],
			nextCursor: cursor ? null : "page/次+=",
		})),
		markdownResolve: vi.fn(async () => ({})),
	};
	const cache = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		}),
		setTargetRef = vi.fn(),
		notify = vi.fn();
	const hook = renderHook(
		() => {
			const [targetRef, setTarget] = useState(
				generated ? generatedId : undefined,
			);
			const show = useCallback((id: string) => {
				setTargetRef(id);
				setTarget(id);
			}, []);
			return markdownWebAdapter.useArtifact({
				client,
				visible: true,
				targetRef,
				notify,
				artifactRevisionId: "artifact:markdown.workspace@3",
				setTargetRef: show,
			} as unknown as AdapterHostContext);
		},
		{
			wrapper: ({ children }: PropsWithChildren) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	const local = (eventAction: string, values = {}) =>
		act(async () =>
			hook.result.current.local!({ eventAction } as never, { values } as never),
		);
	return { hook, client, cache, local, markdown, setTargetRef };
}
test("empty remote recovery alone uses Plate import and an ETag-checked staged open", async () => {
	const h = mount(true);
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	await h.local("markdown-open", { id: remoteId });
	expect(importer).toHaveBeenCalledWith(h.markdown);
	expect(h.client.markdownStage).toHaveBeenCalledWith({
		document: importer.mock.results[0]!.value,
		markdown: h.markdown,
	});
	expect(h.client.markdownOpen).toHaveBeenCalledWith(remoteId, undefined, {
		stageId: "import-stage",
		expectedEtag: entry.revision,
	});
	expect(h.setTargetRef).toHaveBeenCalledWith(localId);
	h.cache.clear();
});
test("nonempty recovery bypasses import; a rejected recovery cannot be opened", async () => {
	const h = mount();
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	await h.local("markdown-open", { id: remoteId });
	expect(importer).not.toHaveBeenCalled();
	expect(h.client.markdownStage).not.toHaveBeenCalled();
	h.client.markdownPreview.mockRejectedValueOnce(
		new Error("markdown_source_invalid"),
	);
	expect(await h.local("markdown-open", { id: remoteId })).toMatchObject({
		status: "rejected",
	});
	expect(h.client.markdownOpen).toHaveBeenCalledTimes(1);
	h.cache.clear();
});
test("more follows the returned cursor, retains namespaces and appends the page", async () => {
	const h = mount();
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	await h.local("markdown-library");
	await h.local("markdown-more");
	expect(h.client.markdownLibrary.mock.calls).toEqual([
		[undefined, undefined],
		[undefined, "page/次+="],
	]);
	expect(h.hook.result.current.snapshot["markdown-workspace"]).toMatchObject({
		library: expect.arrayContaining([
			expect.objectContaining({ sourceId: remoteId }),
			expect.objectContaining({ sourceId: `wiki-${"d".repeat(32)}` }),
		]),
		namespaces: ["eumenes"],
		libraryHasMore: false,
	});
	h.cache.clear();
});

test("opening a generated research document imports its Markdown without switching the conversation specialist", async () => {
	const h = mount(true, "remote");
	await waitFor(() => expect(h.setTargetRef).toHaveBeenCalledWith(localId));
	await waitFor(() =>
		expect(markdownWebAdapter.viewingTarget!()?.targetRef).toBe(localId),
	);
	expect(await markdownWebAdapter.focus!(generatedId)).toBe(true);
	expect(importer).toHaveBeenCalledWith(h.markdown);
	expect(h.client.markdownOpen).toHaveBeenCalledTimes(1);
	expect(h.client.markdownOpen).toHaveBeenCalledWith(
		remoteId,
		expect.any(AbortSignal),
		{ stageId: "import-stage", expectedEtag: entry.revision },
	);
});

test("a temporary research result focuses the Plate preview without importing a work document", async () => {
	const h = mount(true, "local");
	await waitFor(() => expect(h.hook.result.current.phase.kind).toBe("ready"));
	expect(await markdownWebAdapter.focus!(generatedId)).toBe(true);
	expect(h.hook.result.current.snapshot["markdown-workspace"]).toMatchObject({
		current: null,
		preview: { title: entry.title, markdown: h.markdown },
	});
	expect(h.client.markdownOpen).not.toHaveBeenCalled();
	expect(h.client.markdownStage).not.toHaveBeenCalled();
});
