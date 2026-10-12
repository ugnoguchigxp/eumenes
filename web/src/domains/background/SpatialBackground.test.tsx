import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SpatialBackground } from "./SpatialBackground";
import { createSpatialScene } from "./controller/scene";

vi.mock("./controller/scene", () => ({ createSpatialScene: vi.fn() }));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
function mockScene() {
	const scene = { dispose: vi.fn(), select: vi.fn(), setItems: vi.fn() };
	vi.mocked(createSpatialScene).mockImplementation(
		(_host, _items, { onStatus }) => {
			onStatus("ready");
			return scene;
		},
	);
	return scene;
}
test("HTML selection works without WebGL and an initialization failure can be retried", async () => {
	vi.mocked(createSpatialScene).mockImplementationOnce(() => {
		throw new Error("WebGL unavailable");
	});
	const view = render(<SpatialBackground active />);
	await waitFor(() =>
		expect(
			screen.getByText("背景を表示できません。状態一覧は確認できます。"),
		).toBeTruthy(),
	);
	fireEvent.click(screen.getByRole("button", { name: "状態を見る" }));
	fireEvent.click(screen.getByRole("button", { name: "CPU：未確認" }));
	expect(screen.getByText("選択中：CPU")).toBeTruthy();
	const scene = mockScene();
	fireEvent.click(screen.getByRole("button", { name: "再表示" }));
	await waitFor(() =>
		expect(
			view.container.querySelector("[data-background-state='ready']"),
		).toBeTruthy(),
	);
	expect(scene.select).toHaveBeenLastCalledWith("mac-cpu");
});
test("deactivation releases the scene; activating it again creates a fresh scene", async () => {
	const scene = mockScene();
	const view = render(<SpatialBackground active />);
	await waitFor(() => expect(createSpatialScene).toHaveBeenCalledOnce());
	view.rerender(<SpatialBackground active={false} />);
	expect(scene.dispose).toHaveBeenCalledOnce();
	view.rerender(<SpatialBackground active />);
	await waitFor(() => expect(createSpatialScene).toHaveBeenCalledTimes(2));
});
test("unmounting before the deferred initialization never creates a scene", async () => {
	mockScene();
	const view = render(<SpatialBackground active />);
	view.unmount();
	await act(async () => {
		await Promise.resolve();
	});
	expect(createSpatialScene).not.toHaveBeenCalled();
});
