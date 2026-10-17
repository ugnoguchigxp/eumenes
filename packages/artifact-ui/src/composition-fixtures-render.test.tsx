import { afterAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error jsdom has no type declarations in this repository
import { JSDOM } from "jsdom";

/**
 * The UI studio's acceptance fixtures (U1–U8, kept with the ui-compositions domain's tests)
 * rendered end to end: compile, the registered views and the composition's model, as the
 * studio's preview shows a draft.
 */
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
	pretendToBeVisual: true,
});
const domGlobals = {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
	requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
	cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
	HTMLElement: dom.window.HTMLElement,
	HTMLFormElement: dom.window.HTMLFormElement,
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
	IS_REACT_ACT_ENVIRONMENT: true,
};
Object.assign(globalThis, domGlobals);
afterAll(() => {
	for (const name of Object.keys(domGlobals))
		Reflect.deleteProperty(globalThis, name);
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ArtifactRenderer } = await import("./index");
const { trialFormSource, trialPreview } = await import("./ui-studio-preview");

const fixtureDir = join(
	import.meta.dir,
	"../../../api/domains/ui-compositions/test/fixtures",
);
const names = readdirSync(fixtureDir)
	.filter((name) => name.endsWith(".json"))
	.sort();

test("there are fixtures to render", () => {
	expect(names.length).toBeGreaterThanOrEqual(9);
});

test.each(names)("%s renders without an error", async (name) => {
	const definition = JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
	const preview = trialPreview(definition);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<ArtifactRenderer
				definition={JSON.stringify(preview.definition)}
				runtime={{
					snapshot: preview.form ? { [trialFormSource]: preview.form } : {},
					dispatch: async () => ({ status: "rejected", message: "試験" }),
				}}
			/>,
		);
	});
	expect(container.querySelector('[role="alert"]')?.textContent ?? "").toBe("");
	expect(container.textContent?.trim().length ?? 0).toBeGreaterThan(20);
	// Values computed from the model are shown, not left empty.
	if (definition.model?.computed)
		expect(container.textContent).not.toContain("NaN");
	await act(async () => root.unmount());
	container.remove();
});
