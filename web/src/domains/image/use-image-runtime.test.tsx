import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import type { ArtifactEvent } from "@eumenes/artifact-ui/contracts";
import { imageStudioSource, useImageRuntime } from "./use-image-runtime";
afterEach(cleanup);
function setup(onClose?: () => void) {
	const items = [
		{
			id: "image-record",
			runId: "old-run",
			conversationId: "main",
			state: "completed",
			action: "generate",
			title: "森",
			description: "",
			prompt: "a forest",
			width: 121,
			height: 777,
			format: "png",
			seed: 42,
			artifactId: "old-image",
			phase: "completed",
			mime: "image/png",
			actualModel: "fixture-model",
			errorCode: null,
			createdAt: 1,
			updatedAt: 1,
		},
	];
	const api = {
		deleteImage: vi.fn(async (id: string) => ({ id, deleted: true })),
		imageGenerations: vi.fn(async () => items),
		imageLibrary: vi.fn(async () => ({
			images: [
				{
					id: "old-image",
					width: 121,
					height: 777,
					format: "png",
					createdAt: "2026-10-13T00:00:00Z",
				},
			],
			totalBytes: 20,
			maxBytes: 100,
			targetBytes: 80,
		})),
		submit: vi.fn(
			async (_input: {
				requestId: string;
				conversationId: string;
				text: string;
				presentation?: "conversation" | "artifact";
				toolchainId?: string;
			}) => ({ id: "new-run", status: "queued", revision: 1 }),
		),
		run: vi.fn(async () => ({ id: "new-run", status: "queued", revision: 1 })),
		cancel: vi.fn(async () => ({
			id: "new-run",
			status: "cancelled",
			revision: 2,
		})),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const hook = renderHook(
		() => useImageRuntime(api as never, "main", onClose),
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	const resource = () =>
		hook.result.current.runtime.snapshot[imageStudioSource];
	const event = (
		action: ArtifactEvent["action"],
		values: ArtifactEvent["values"] = {},
	): ArtifactEvent => ({
		id: crypto.randomUUID(),
		source: imageStudioSource,
		revision: resource().revision,
		action,
		values,
	});
	const dispatch = async (e: ArtifactEvent) => {
		let receipt;
		await act(async () => {
			receipt = await hook.result.current.runtime.dispatch(e);
		});
		return receipt;
	};
	return { ...hook, api, cache, resource, event, dispatch };
}
test("host passes precise edited input through authenticated submission, rejects invalid inputs and cancels accepted run", async () => {
	const r = setup();
	await waitFor(() => expect(r.resource().images).toHaveLength(1));
	expect(r.resource().images[0]!.url).toBe("/api/images/old-image/content");
	expect(
		await r.dispatch(
			r.event("image-generate", {
				prompt: "forest",
				width: "99",
				height: "777",
				format: "png",
				seed: "42",
			}),
		),
	).toMatchObject({ status: "rejected" });
	expect(r.api.submit).not.toHaveBeenCalled();
	const values = {
		prompt: "柔らかな朝の光の森",
		width: "121",
		height: "777",
		format: "png",
		seed: "42",
	};
	expect(await r.dispatch(r.event("image-generate", values))).toMatchObject({
		status: "accepted",
	});
	const input = r.api.submit.mock.calls[0]![0];
	expect(input.presentation).toBe("artifact");
	expect(input.toolchainId).toBe("image.create");
	expect(JSON.parse(input.text.slice(input.text.indexOf("\n\n") + 2))).toEqual({
		prompt: values.prompt,
		width: 121,
		height: 777,
		format: "png",
		seed: 42,
	});
	await waitFor(() => expect(r.resource().canCancel).toBe(true));
	expect(await r.dispatch(r.event("image-cancel"))).toMatchObject({
		status: "accepted",
	});
	expect(r.api.cancel).toHaveBeenCalledWith("new-run");
	r.cache.clear();
});
test("confirmed deletion refreshes the authoritative list, clears selected preview and rejects duplicate, stale or unknown operations", async () => {
	const r = setup();
	await waitFor(() => expect(r.resource().images).toHaveLength(1));
	const event = r.event("image-delete", { id: "old-image" });
	expect(await r.dispatch({ ...event, source: "unknown" })).toMatchObject({
		status: "rejected",
	});
	expect(await r.dispatch({ ...event, revision: -1 })).toMatchObject({
		status: "conflict",
	});
	expect(
		await r.dispatch(r.event("image-delete", { id: "missing" })),
	).toMatchObject({ status: "rejected" });
	expect(r.api.deleteImage).not.toHaveBeenCalled();
	r.api.imageLibrary.mockResolvedValue({
		images: [],
		totalBytes: 0,
		maxBytes: 100,
		targetBytes: 80,
	});
	expect(await r.dispatch(event)).toMatchObject({
		status: "accepted",
		message: "画像を削除しました。",
	});
	await waitFor(() => expect(r.resource().images).toHaveLength(0));
	expect(r.resource().selectedId).toBeUndefined();
	expect(await r.dispatch(event)).toMatchObject({ status: "duplicate" });
	expect(r.api.deleteImage).toHaveBeenCalledExactlyOnceWith("old-image");
	expect(r.api.submit).not.toHaveBeenCalled();
	r.cache.clear();
});
test("deletion failure does not hide the image or report success and refreshes uncertain results", async () => {
	const r = setup();
	await waitFor(() => expect(r.resource().images).toHaveLength(1));
	r.api.deleteImage.mockRejectedValue(new Error("network"));
	const receipt = await r.dispatch(
		r.event("image-delete", { id: "old-image" }),
	);
	expect(receipt).toMatchObject({
		status: "rejected",
		message: "削除結果を確認できませんでした。一覧を更新してください。",
	});
	expect(r.resource().images).toHaveLength(1);
	expect(r.api.deleteImage).toHaveBeenCalledOnce();
	expect(r.api.imageLibrary.mock.calls.length).toBeGreaterThan(1);
	r.cache.clear();
});
test("source, action, stale revision and duplicate events are enforced by the host", async () => {
	const r = setup();
	await waitFor(() => expect(r.resource().images).toHaveLength(1));
	expect(
		await r.dispatch({ ...r.event("image-refresh"), source: "unknown" }),
	).toMatchObject({ status: "rejected" });
	expect(
		await r.dispatch({ ...r.event("image-refresh"), revision: -1 }),
	).toMatchObject({ status: "conflict" });
	expect(await r.dispatch(r.event("music-delete"))).toMatchObject({
		status: "rejected",
	});
	const event = r.event("image-select", { id: "old-image" });
	expect(await r.dispatch(event)).toMatchObject({ status: "accepted" });
	expect(await r.dispatch(event)).toMatchObject({ status: "duplicate" });
	expect(r.api.submit).not.toHaveBeenCalled();
	r.cache.clear();
});

test("close routes only the authorized workspace action to the host", async () => {
	const close = vi.fn();
	const r = setup(close);
	await waitFor(() => expect(r.resource().images).toHaveLength(1));
	expect(
		await r.dispatch({ ...r.event("image-close"), source: "unknown" }),
	).toMatchObject({ status: "rejected" });
	expect(close).not.toHaveBeenCalled();
	expect(await r.dispatch(r.event("image-close"))).toMatchObject({
		status: "accepted",
	});
	expect(close).toHaveBeenCalledOnce();
	expect(r.api.submit).not.toHaveBeenCalled();
	r.cache.clear();
});
test("escaped prompt payload capacity is checked before submission", async () => {
	const r = setup();
	await waitFor(() => expect(r.resource().images).toHaveLength(1));
	const receipt = await r.dispatch(
		r.event("image-generate", {
			prompt: '"'.repeat(5000),
			width: "512",
			height: "512",
			format: "png",
			seed: "0",
		}),
	);
	expect(receipt).toMatchObject({
		status: "rejected",
		message: "プロンプトが長すぎます。短くしてください。",
	});
	expect(r.api.submit).not.toHaveBeenCalled();
	r.cache.clear();
});
