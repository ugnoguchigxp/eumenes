import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../client";
import { useChatAttachments } from "./useChatAttachments";

const settings = vi.hoisted(() => ({ revision: 1 }));
vi.mock("../domains/settings", () => ({
	useSettings: () => ({ data: settings }),
}));
const library = vi.hoisted(() => ({
	enabled: [] as boolean[],
	refetch: () => Promise.resolve(),
}));
vi.mock("../media/use-image-library", async (original) => ({
	...(await original<typeof import("../media/use-image-library")>()),
	useImageLibrary: (_client: unknown, _interval: unknown, enabled: boolean) => {
		library.enabled.push(enabled);
		return {
			data: enabled
				? {
						images: [
							{
								id: "img-1",
								createdAt: "2026-11-07T01:00:00.000Z",
								width: 1024,
								height: 768,
							},
						],
					}
				: undefined,
			isPending: !enabled,
			error: null,
			refetch: library.refetch,
		};
	},
}));
afterEach(cleanup);
function client() {
	return {
		imageInput: vi.fn(async () => ({
			revision: 1,
			primary: { source: "codex-sdk", status: "supported" },
		})),
		connectLarm: vi.fn(),
	};
}

test("cloud attachments inspect the selected route without connecting LARM", async () => {
	vi.stubGlobal("URL", {
		createObjectURL: () => "blob:fixture",
		revokeObjectURL: vi.fn(),
	});
	const c = client();
	const hook = renderHook(() =>
		useChatAttachments(c as unknown as EumenesClient, "main"),
	);
	act(() =>
		hook.result.current.add([
			new File(["image"], "a.png", { type: "image/png" }),
		]),
	);
	await waitFor(() => expect(hook.result.current.busy).toBe(false));
	expect(c.imageInput).toHaveBeenCalledOnce();
	expect(c.connectLarm).not.toHaveBeenCalled();
	expect(hook.result.current.capability?.primary.source).toBe("codex-sdk");
	expect(hook.result.current.error).toBeUndefined();
	vi.unstubAllGlobals();
});

test("a route change cancels the old inspection and keeps its stale response out", async () => {
	vi.stubGlobal("URL", {
		createObjectURL: () => "blob:fixture",
		revokeObjectURL: vi.fn(),
	});
	let old:
		| ((v: {
				revision: number;
				primary: { source: string; status: string };
		  }) => void)
		| undefined;
	const c = client();
	c.imageInput.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				old = resolve;
			}),
	);
	const hook = renderHook(
		() => useChatAttachments(c as unknown as EumenesClient, "main"),
		{ initialProps: { revision: 1 } },
	);
	act(() =>
		hook.result.current.add([
			new File(["image"], "a.png", { type: "image/png" }),
		]),
	);
	settings.revision = 2;
	hook.rerender({ revision: 2 });
	await waitFor(() => expect(hook.result.current.busy).toBe(false));
	expect(
		(c.imageInput.mock.calls[0] as unknown as [AbortSignal])[0].aborted,
	).toBe(true);
	await act(async () => {
		old?.({ revision: 1, primary: { source: "larm", status: "unsupported" } });
	});
	expect(hook.result.current.capability?.primary.source).toBe("codex-sdk");
	expect(hook.result.current.error).toBeUndefined();
	vi.unstubAllGlobals();
});

test("switching from an unsupported route clears its old error after a successful inspection", async () => {
	vi.stubGlobal("URL", {
		createObjectURL: () => "blob:fixture",
		revokeObjectURL: vi.fn(),
	});
	const c = client();
	c.imageInput.mockResolvedValueOnce({
		revision: 1,
		primary: { source: "codex-sdk", status: "unsupported" },
	});
	const hook = renderHook(() =>
		useChatAttachments(c as unknown as EumenesClient, "main"),
	);
	act(() =>
		hook.result.current.add([
			new File(["image"], "a.png", { type: "image/png" }),
		]),
	);
	await waitFor(() => expect(hook.result.current.error).toBeDefined());
	settings.revision++;
	hook.rerender();
	await waitFor(() =>
		expect(hook.result.current.capability?.primary.status).toBe("supported"),
	);
	expect(hook.result.current.error).toBeUndefined();
	vi.unstubAllGlobals();
});

test("unknown image support prevents upload and preserves the draft; text-only submission is allowed", async () => {
	vi.stubGlobal("URL", {
		createObjectURL: () => "blob:fixture",
		revokeObjectURL: vi.fn(),
	});
	const c = { ...client(), uploadAttachment: vi.fn() };
	c.imageInput.mockResolvedValue({
		revision: 1,
		primary: { source: "codex-sdk", status: "unknown" },
	});
	const hook = renderHook(() =>
		useChatAttachments(c as unknown as EumenesClient, "main"),
	);
	expect(await hook.result.current.upload([])).toEqual([]);
	act(() =>
		hook.result.current.add([
			new File(["image"], "a.png", { type: "image/png" }),
		]),
	);
	await waitFor(() => expect(hook.result.current.busy).toBe(false));
	await act(async () => {
		await expect(
			hook.result.current.upload(hook.result.current.items),
		).rejects.toThrow("image_capability_unknown");
	});
	expect(c.uploadAttachment).not.toHaveBeenCalled();
	expect(hook.result.current.items).toHaveLength(1);
	vi.unstubAllGlobals();
});

test("library images wait in the draft and become attachments only on send", async () => {
	const revoke = vi.fn();
	vi.stubGlobal("URL", {
		createObjectURL: () => "blob:fixture",
		revokeObjectURL: revoke,
	});
	const c = {
		...client(),
		uploadAttachment: vi.fn(),
		attachLibraryImage: vi.fn(
			async (_conversation: string, id: string, _imageId: string) => ({ id }),
		),
	};
	const hook = renderHook(() =>
		useChatAttachments(c as unknown as EumenesClient, "main"),
	);
	expect(hook.result.current.library.loading).toBe(false);
	expect(library.enabled.at(-1)).toBe(false);
	act(() => hook.result.current.library.open());
	expect(library.enabled.at(-1)).toBe(true);
	const [image] = hook.result.current.library.images;
	expect(image).toEqual({
		id: "img-1",
		title: "画像 2026-11-07（1024×768）",
		thumbnailUrl: "/api/images/img-1/content",
	});
	act(() => hook.result.current.addLibrary([image!]));
	// The same saved image is attached once.
	act(() => hook.result.current.addLibrary([image!]));
	await waitFor(() => expect(hook.result.current.busy).toBe(false));
	const items = hook.result.current.items;
	expect(items).toHaveLength(1);
	expect(items[0]).toMatchObject({
		name: "画像 2026-11-07（1024×768）",
		url: "/api/images/img-1/content",
		source: { kind: "library", imageId: "img-1" },
	});
	expect(c.attachLibraryImage).not.toHaveBeenCalled();
	let ids: string[] = [];
	await act(async () => {
		ids = await hook.result.current.upload(items);
	});
	expect(ids).toEqual([items[0]!.id]);
	expect(c.attachLibraryImage).toHaveBeenCalledExactlyOnceWith(
		"main",
		items[0]!.id,
		"img-1",
	);
	expect(c.uploadAttachment).not.toHaveBeenCalled();
	act(() => hook.result.current.remove(items[0]!.id));
	expect(hook.result.current.items).toHaveLength(0);
	expect(revoke).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});
