import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ConversationBackground } from "./ConversationBackground";

const lifecycle = vi.hoisted(() => ({
	fairy: vi.fn(),
	spatial: vi.fn(),
	hiyori: vi.fn(),
}));
vi.mock("./domains/conversation/LightAvatarBackground", async () => {
	const { useEffect } = await import("react");
	return {
		LightAvatarBackground: () => {
			useEffect(() => lifecycle.fairy(), []);
			return <div>光の妖精背景</div>;
		},
	};
});
vi.mock("../domains/background", async () => {
	const { useEffect } = await import("react");
	return {
		SpatialBackground: () => {
			useEffect(() => lifecycle.spatial(), []);
			return <div>Spatial背景</div>;
		},
	};
});
vi.mock("./domains/conversation/HiyoriAvatarBackground", async () => {
	const { useEffect } = await import("react");
	return {
		HiyoriAvatarBackground: () => {
			useEffect(() => lifecycle.hiyori(), []);
			return <div>ひより背景</div>;
		},
	};
});
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
test("only the selected background mounts, and switching releases the previous one", async () => {
	const disposeFairy = vi.fn(),
		disposeSpatial = vi.fn();
	lifecycle.fairy.mockReturnValue(disposeFairy);
	lifecycle.spatial.mockReturnValue(disposeSpatial);
	const view = render(<ConversationBackground kind="light-fairy" active />);
	expect(screen.getByText("光の妖精背景")).toBeTruthy();
	expect(lifecycle.spatial).not.toHaveBeenCalled();
	view.rerender(<ConversationBackground kind="spatial" active />);
	await waitFor(() => expect(screen.getByText("Spatial背景")).toBeTruthy());
	expect(screen.queryByText("光の妖精背景")).toBeNull();
	expect(disposeFairy).toHaveBeenCalledOnce();
	view.rerender(<ConversationBackground kind="light-fairy" active />);
	expect(screen.getByText("光の妖精背景")).toBeTruthy();
	expect(disposeSpatial).toHaveBeenCalledOnce();
});

test("the third background releases the old display and is released on switching back", async () => {
	const disposeFairy = vi.fn(),
		disposeHiyori = vi.fn();
	lifecycle.fairy.mockReturnValue(disposeFairy);
	lifecycle.hiyori.mockReturnValue(disposeHiyori);
	const view = render(<ConversationBackground kind="light-fairy" active />);
	view.rerender(<ConversationBackground kind="live2d-hiyori" active />);
	await screen.findByText("ひより背景");
	expect(disposeFairy).toHaveBeenCalledOnce();
	expect(lifecycle.spatial).not.toHaveBeenCalled();
	view.rerender(<ConversationBackground kind="light-fairy" active />);
	expect(disposeHiyori).toHaveBeenCalledOnce();
});
