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
vi.mock("./models", () => ({ loadSpatialModels: vi.fn(async () => ({})) }));
afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});
function mockScene() {
	const scene = {
		dispose: vi.fn(),
		select: vi.fn(),
		setItems: vi.fn(),
		setOptions: vi.fn(),
		pick: vi.fn((): string | null => null),
	};
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

test("normal background has no state toggle", async () => {
	mockScene();
	render(<SpatialBackground active />);
	await waitFor(() => expect(createSpatialScene).toHaveBeenCalledOnce());
	expect(screen.queryByRole("button", { name: "状態を見る" })).toBeNull();
});

test("fallback details keep the owner-provided measurement quality and history gap visible", async () => {
	vi.mocked(createSpatialScene).mockImplementationOnce(() => {
		throw new Error("WebGL unavailable");
	});
	render(
		<SpatialBackground
			active
			items={[
				{
					id: "larm-cpu",
					model: "larm-cpu",
					label: "LARM CPU",
					position: [0, 0, 0],
					state: {
						health: "unknown",
						activity: "idle",
						stale: true,
						details: ["計測権限なし", "過去の履歴に欠落があります"],
					},
				},
			]}
		/>,
	);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "LARM CPU：未確認（情報が古い）" }),
		).toBeTruthy(),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "LARM CPU：未確認（情報が古い）" }),
	);
	expect(screen.getByText("計測権限なし")).toBeTruthy();
	expect(screen.getByText("過去の履歴に欠落があります")).toBeTruthy();
});

test("background mode shows a clicked object's details and closes them by empty space, Escape or leaving the mode", async () => {
	const scene = mockScene();
	const view = render(<SpatialBackground active interactive />);
	await waitFor(() => expect(createSpatialScene).toHaveBeenCalledOnce());
	const host = view.container.querySelector(".spatial-background")!;
	expect(host.hasAttribute("data-interactive")).toBe(true);
	scene.pick.mockReturnValue("mac-cpu");
	fireEvent.click(host, { clientX: 10, clientY: 20 });
	expect(scene.pick).toHaveBeenLastCalledWith(10, 20);
	expect(screen.getByRole("complementary", { name: "CPUの詳細" })).toBeTruthy();
	expect(screen.getAllByText("未確認")).toHaveLength(2);
	expect(screen.getAllByText("未取得")).toHaveLength(2);
	await waitFor(() => expect(scene.select).toHaveBeenLastCalledWith("mac-cpu"));
	scene.pick.mockReturnValue(null);
	fireEvent.click(host);
	expect(screen.queryByRole("complementary")).toBeNull();
	scene.pick.mockReturnValue("mac-ssd");
	fireEvent.click(host);
	expect(screen.getByRole("complementary", { name: "SSDの詳細" })).toBeTruthy();
	const menu = document.createElement("button");
	document.body.append(menu);
	menu.focus();
	fireEvent.keyDown(document, { key: "Escape" });
	expect(screen.getByRole("complementary", { name: "SSDの詳細" })).toBeTruthy();
	menu.remove();
	fireEvent.keyDown(document, { key: "Escape" });
	expect(screen.queryByRole("complementary")).toBeNull();
	fireEvent.click(host);
	fireEvent.click(screen.getByRole("button", { name: "詳細を閉じる" }));
	expect(screen.queryByRole("complementary")).toBeNull();
	fireEvent.click(host);
	view.rerender(<SpatialBackground active interactive={false} />);
	await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
	expect(host.hasAttribute("data-interactive")).toBe(false);
	fireEvent.click(host);
	expect(screen.queryByRole("complementary")).toBeNull();
});

test("the click panel shows supplied measurements and owner notes", async () => {
	const scene = mockScene();
	render(
		<SpatialBackground
			active
			interactive
			items={[
				{
					id: "llm",
					model: "llm",
					label: "LLM",
					position: [0, 0, 0],
					state: {
						health: "healthy",
						activity: "working",
						stale: false,
						utilization: 0.63,
						source: "measurement",
						observedAt: Date.now(),
						details: ["取得済み"],
					},
				},
			]}
		/>,
	);
	await waitFor(() => expect(createSpatialScene).toHaveBeenCalledOnce());
	scene.pick.mockReturnValue("llm");
	fireEvent.click(document.querySelector(".spatial-background")!);
	const panel = screen.getByRole("complementary", { name: "LLMの詳細" });
	for (const text of ["正常", "実測", "処理中", "63%", "取得済み"])
		expect(panel.textContent).toContain(text);
	expect(panel.textContent).toMatch(/（\d+秒前）/);
});
