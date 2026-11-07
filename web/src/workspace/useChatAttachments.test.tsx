import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../client";
import { useChatAttachments } from "./useChatAttachments";

const settings = vi.hoisted(() => ({ revision: 1 }));
vi.mock("../domains/settings", () => ({
	useSettings: () => ({ data: settings }),
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
