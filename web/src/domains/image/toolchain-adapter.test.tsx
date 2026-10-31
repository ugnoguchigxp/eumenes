import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { FOCUS_MARK_MS } from "../../components/domains/resource-focus";
import { imageScreenWebAdapter } from "./toolchain-adapter";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	document.body.replaceChildren();
});

const record = (artifactId: string) => ({
	id: `record-${artifactId}`,
	runId: `run-${artifactId}`,
	conversationId: "main",
	state: "completed",
	action: "generate",
	title: artifactId,
	description: "",
	prompt: "a forest",
	width: 64,
	height: 64,
	format: "png",
	seed: 1,
	artifactId,
	phase: "completed",
	mime: "image/png",
	actualModel: "fixture-model",
	errorCode: null,
	createdAt: 1,
	updatedAt: 1,
});

function mount(options: { targetRef?: string; visible?: boolean } = {}) {
	const client = {
		identity: crypto.randomUUID(),
		imageGenerations: vi.fn(async () => [record("img1"), record("img2")]),
		imageLibrary: vi.fn(async () => ({
			images: ["img1", "img2"].map((id) => ({
				id,
				width: 64,
				height: 64,
				format: "png",
				createdAt: "2026-10-13T00:00:00Z",
				bytes: 10,
			})),
			totalBytes: 20,
			maxBytes: 100,
			targetBytes: 80,
		})),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const setTargetRef = vi.fn();
	const view = renderHook(
		() =>
			imageScreenWebAdapter.useArtifact({
				client: client as never,
				artifact: { variants: [] } as never,
				targetRef: options.targetRef,
				setTargetRef,
				visible: options.visible ?? true,
			} as never),
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={cache}>{children}</QueryClientProvider>
			),
		},
	);
	return { view, setTargetRef };
}

/** What the open image screen draws for a saved image, as the design system renders it. */
function drawCard(id: string, hidden = false) {
	const host = document.createElement("section");
	host.className = "image-workspace";
	host.innerHTML = `<div ${hidden ? "hidden" : ""}><article class="image-grid-card"><img src="/api/images/${id}/content" alt=""></article></div>`;
	document.body.append(host);
	return host.querySelector<HTMLElement>(".image-grid-card")!;
}

test("viewing is the URI of the image the screen shows, and null while the screen is hidden", async () => {
	const shown = mount({ targetRef: "img2" });
	await waitFor(() =>
		expect(imageScreenWebAdapter.viewing?.()).toBe("eumenes://image/img2"),
	);
	shown.view.unmount();
	expect(imageScreenWebAdapter.viewing?.()).toBeNull();

	const hidden = mount({ targetRef: "img2", visible: false });
	await waitFor(() =>
		expect(hidden.view.result.current.phase.kind).toBe("ready"),
	);
	expect(imageScreenWebAdapter.viewing?.()).toBeNull();
});

test("focus scrolls to the image's card and marks it for two seconds", async () => {
	const { setTargetRef, view } = mount({ targetRef: "img1" });
	await waitFor(() => expect(view.result.current.phase.kind).toBe("ready"));
	const card = drawCard("img2");
	const scroll = vi.fn();
	card.scrollIntoView = scroll;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const done = imageScreenWebAdapter.focus?.("img2");
	await vi.advanceTimersByTimeAsync(100);
	await expect(done).resolves.toBe(true);
	// The screen shows another image: it is asked to show this one.
	expect(setTargetRef).toHaveBeenCalledWith("img2");
	expect(scroll).toHaveBeenCalledOnce();
	expect(card.getAttribute("data-resource-focus")).toBe("true");
	await vi.advanceTimersByTimeAsync(FOCUS_MARK_MS + 10);
	expect(card.hasAttribute("data-resource-focus")).toBe(false);
});

test("focus does not mark an image drawn in a hidden view, and says no to an image the screen lacks", async () => {
	const { view } = mount({ targetRef: "img1" });
	await waitFor(() => expect(view.result.current.phase.kind).toBe("ready"));
	const card = drawCard("img1", true);
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	const known = imageScreenWebAdapter.focus?.("img1");
	await vi.advanceTimersByTimeAsync(2_500);
	// The item exists even if it cannot be marked yet.
	await expect(known).resolves.toBe(true);
	expect(card.hasAttribute("data-resource-focus")).toBe(false);
	const unknown = imageScreenWebAdapter.focus?.("missing");
	await vi.advanceTimersByTimeAsync(5_500);
	await expect(unknown).resolves.toBe(false);
});
