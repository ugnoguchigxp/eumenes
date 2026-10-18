import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../../../../client/transport";
import { GlbTooLargeError, type Model3dApi } from "./api";

const scene = vi.hoisted(() => ({
	show: vi.fn(async () => {}),
	reset: vi.fn(),
	setBackground: vi.fn(),
	dispose: vi.fn(),
}));
const create = vi.hoisted(() => vi.fn());
vi.mock("./glb-scene", () => ({ createGlbScene: create }));

import { Model3dViewer } from "./Model3dViewer";

beforeEach(() => {
	create.mockReset().mockImplementation(() => scene);
	scene.show.mockReset().mockResolvedValue(undefined);
	scene.reset.mockReset();
	scene.setBackground.mockReset();
	scene.dispose.mockReset();
});
afterEach(cleanup);

const apiWith = (content: Model3dApi["assetContent"]) =>
	({ assetContent: vi.fn(content) }) as unknown as Model3dApi & {
		assetContent: ReturnType<typeof vi.fn>;
	};

test("reads the GLB through the API, shows it and offers reset and a background toggle", async () => {
	const bytes = new ArrayBuffer(8);
	const api = apiWith(async () => bytes);
	render(<Model3dViewer assetId="a1" api={api} />);
	expect(screen.getByText("読み込んでいます")).toBeTruthy();
	await waitFor(() => expect(scene.show).toHaveBeenCalledWith(bytes));
	await waitFor(() =>
		expect(screen.queryByText("読み込んでいます")).toBeNull(),
	);
	expect(api.assetContent).toHaveBeenCalledWith("a1", expect.any(AbortSignal));
	expect(create).toHaveBeenCalledWith(expect.any(HTMLElement), "light");

	fireEvent.click(screen.getByRole("button", { name: "視点をリセット" }));
	expect(scene.reset).toHaveBeenCalledTimes(1);
	const toggle = screen.getByRole("button", { name: "背景を暗くする" });
	expect(toggle.getAttribute("aria-pressed")).toBe("false");
	fireEvent.click(toggle);
	expect(scene.setBackground).toHaveBeenCalledWith("dark");
	expect(
		screen
			.getByRole("button", { name: "背景を明るくする" })
			.getAttribute("aria-pressed"),
	).toBe("true");
});

test("shows a failure for an oversized file, a missing asset and a broken file", async () => {
	for (const [error, text] of [
		[new GlbTooLargeError(), /大きすぎる/],
		[new ApiError(404, "not_found"), /見つかりません/],
		[new Error("boom"), /読み込めませんでした/],
	] as const) {
		const view = render(
			<Model3dViewer
				assetId="a1"
				api={apiWith(async () => {
					throw error;
				})}
			/>,
		);
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toMatch(text),
		);
		expect(create).not.toHaveBeenCalled();
		view.unmount();
	}
});

test("shows a failure when the GLB cannot be parsed and still releases the scene", async () => {
	scene.show.mockRejectedValueOnce(new Error("invalid glb"));
	const view = render(
		<Model3dViewer
			assetId="a1"
			api={apiWith(async () => new ArrayBuffer(1))}
		/>,
	);
	await waitFor(() =>
		expect(screen.getByRole("alert").textContent).toMatch(
			/読み込めませんでした/,
		),
	);
	view.unmount();
	expect(scene.dispose).toHaveBeenCalledTimes(1);
});

test("releases the scene on unmount and when the asset changes", async () => {
	const api = apiWith(async () => new ArrayBuffer(1));
	const view = render(<Model3dViewer assetId="a1" api={api} />);
	await waitFor(() => expect(scene.show).toHaveBeenCalledTimes(1));
	view.rerender(<Model3dViewer assetId="a2" api={api} />);
	expect(scene.dispose).toHaveBeenCalledTimes(1);
	await waitFor(() => expect(scene.show).toHaveBeenCalledTimes(2));
	view.unmount();
	expect(scene.dispose).toHaveBeenCalledTimes(2);
});

test("aborts a read that is still running when the viewer goes away", async () => {
	let signal: AbortSignal | undefined;
	const api = apiWith(
		(_id, abort) =>
			new Promise(() => {
				signal = abort;
			}),
	);
	const view = render(<Model3dViewer assetId="a1" api={api} />);
	await waitFor(() => expect(signal).toBeDefined());
	view.unmount();
	expect(signal?.aborted).toBe(true);
	expect(create).not.toHaveBeenCalled();
});
