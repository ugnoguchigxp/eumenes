import { afterAll, expect, mock, test } from "bun:test";
// @ts-expect-error jsdom has no type declarations in this repository
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
const globals = {
	window: dom.window,
	document: dom.window.document,
	IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(
	Object.keys(globals).map((name) => [
		name,
		Object.getOwnPropertyDescriptor(globalThis, name),
	]),
);
Object.assign(globalThis, globals);
afterAll(() => {
	for (const [name, descriptor] of previous) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	dom.window.close();
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ExternalAppLauncherView } = await import("./external-app-components");
const { ArtifactRuntimeContext } = await import("./runtime");

test("a stale source conflict is displayed and the user can explicitly try again", async () => {
	let attempts = 0;
	const dispatch = mock(async () =>
		++attempts === 1
			? {
					status: "conflict" as const,
					message: "状態が変わりました。もう一度お試しください。",
				}
			: { status: "accepted" as const, message: "別タブを開きました。" },
	);
	const container = document.createElement("div"),
		root = createRoot(container);
	document.body.append(container);
	try {
		await act(async () =>
			root.render(
				<ArtifactRuntimeContext.Provider
					value={{
						snapshot: {
							launcher: {
								kind: "external-app-launcher",
								revision: 1,
								available: true,
								busy: false,
							},
						},
						dispatch,
					}}
				>
					<ExternalAppLauncherView
						request={{
							view: "external-app-launcher",
							source: "launcher",
							title: "Docling Deskを開く",
						}}
					/>
				</ArtifactRuntimeContext.Provider>,
			),
		);
		const button = container.querySelector("button")!;
		await act(async () => button.click());
		expect(container.querySelector('[role="alert"]')?.textContent).toContain(
			"状態が変わりました",
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
		await act(async () => button.click());
		expect(
			container.querySelector('[role="alert"]')?.textContent ?? null,
		).toBeNull();
		expect(dispatch).toHaveBeenCalledTimes(2);
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});

test("a late open rejection does not leak into the launcher after its connection changes", async () => {
	const pending = Promise.withResolvers<{
		status: "rejected";
		message: string;
	}>();
	const container = document.createElement("div");
	const root = createRoot(container);
	document.body.append(container);
	const show = async (revision: number, available: boolean) =>
		act(async () =>
			root.render(
				<ArtifactRuntimeContext.Provider
					value={{
						snapshot: {
							launcher: {
								kind: "external-app-launcher",
								revision,
								available,
								busy: false,
								preparing: !available,
							},
						},
						dispatch: () => pending.promise,
					}}
				>
					<ExternalAppLauncherView
						request={{
							view: "external-app-launcher",
							source: "launcher",
							title: "開く",
						}}
					/>
				</ArtifactRuntimeContext.Provider>,
			),
		);
	try {
		await show(1, true);
		await act(async () => container.querySelector("button")!.click());
		await show(2, false);
		await act(async () => {
			pending.resolve({ status: "rejected", message: "古い接続の取消" });
		});
		await show(2, true);
		expect(
			container.querySelector('[role="alert"]')?.textContent ?? null,
		).toBeNull();
	} finally {
		await act(async () => root.unmount());
		container.remove();
	}
});
