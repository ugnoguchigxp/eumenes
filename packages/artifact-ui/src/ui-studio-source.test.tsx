import { afterAll, afterEach, expect, mock, test } from "bun:test";
// @ts-expect-error jsdom has no type declarations in this repository
import { JSDOM } from "jsdom";
import type {
	ArtifactEvent,
	Receipt,
	Snapshot,
	UiStudioResource,
} from "./contracts";

// The views need a DOM; bun test has none, so install jsdom's before React DOM loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
const domGlobals = {
	window: dom.window,
	document: dom.window.document,
	IS_REACT_ACT_ENVIRONMENT: true,
	ResizeObserver: class {
		observe() {}
		unobserve() {}
		disconnect() {}
	},
};
Object.assign(globalThis, domGlobals);
afterAll(() => {
	for (const name of Object.keys(domGlobals))
		Reflect.deleteProperty(globalThis, name);
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ArtifactRuntimeContext } = await import("./runtime");
const { UiStudioView } = await import("./ui-studio-components");

type Work = NonNullable<UiStudioResource["work"]>;
const definition = { view: "text-block", title: "見出し" };
const sourceOf = (title: string, extra = "") =>
	`{\n  "view": "text-block",\n  "title": "${title}"${extra}\n}`;
const work = (over: Partial<Work> = {}): Work => ({
	workRef: "work-1",
	sessionId: "s1",
	title: "案",
	definition,
	revision: 3,
	source: sourceOf("見出し"),
	previousSource: "",
	rejected: null,
	savedRef: null,
	savedRevision: null,
	dirty: true,
	busy: false,
	canUndo: true,
	canRedo: false,
	...over,
});
const rejected = {
	title: "壊れた案",
	text: '{\n  "view": "nothing"\n}',
	issues: [{ path: "(root)", rule: "unknown_view" }],
	fixes: ["空の部品を捨てました"],
	createdAt: "2026-10-18T00:00:00.000Z",
};
const snapshotOf = (over: Partial<UiStudioResource> = {}): Snapshot => ({
	"ui-studio": {
		kind: "ui-studio",
		revision: 5,
		work: work(),
		viewing: null,
		history: [],
		session: { state: "active", expiresAt: "2026-10-18T09:00:00.000Z" },
		stoppable: false,
		...over,
	},
});

const roots: Array<{ unmount: () => void }> = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.innerHTML = "";
});

async function mountStudio(
	snapshot: Snapshot,
	receipt: Receipt = { status: "accepted", message: "" },
) {
	const dispatch = mock(async (_event: ArtifactEvent) => receipt);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = (next: Snapshot) =>
		act(async () => {
			root.render(
				<ArtifactRuntimeContext.Provider value={{ snapshot: next, dispatch }}>
					<UiStudioView
						request={
							{
								view: "ui-studio",
								source: "ui-studio",
								title: "UI自由制作",
							} as never
						}
					/>
				</ArtifactRuntimeContext.Provider>,
			);
		});
	await render(snapshot);
	return { container, dispatch, render };
}
const buttonOf = (container: HTMLElement, name: string) => {
	const found = [...container.querySelectorAll("button")].find(
		(b) => b.textContent?.trim() === name,
	);
	if (!found) throw new Error(`no button ${name}`);
	return found as HTMLButtonElement;
};
const press = (container: HTMLElement, name: string) =>
	act(async () => {
		buttonOf(container, name).click();
	});
const openSource = (container: HTMLElement) => press(container, "ソース");
const code = (container: HTMLElement) =>
	container.querySelector(".aui-ui-source-code")?.textContent ?? "";
const editor = (container: HTMLElement) =>
	container.querySelector("textarea") as HTMLTextAreaElement;
async function typeInto(area: HTMLTextAreaElement, value: string) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			dom.window.HTMLTextAreaElement.prototype,
			"value",
		)?.set;
		setter?.call(area, value);
		area.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}

test("the source view shows the canonical text as given, not a re-serialization", async () => {
	// Key order and spacing that JSON.stringify of the definition would not produce.
	const source = '{\n  "title": "見出し",\n  "view": "text-block"\n}';
	const { container } = await mountStudio(
		snapshotOf({ work: work({ source }) }),
	);
	await openSource(container);
	expect(code(container)).toBe(source);
});

test("the lines changed from the previous revision are marked and removed lines are indicated", async () => {
	const { container } = await mountStudio(
		snapshotOf({
			work: work({
				source: sourceOf("新しい見出し"),
				previousSource: sourceOf("見出し", ',\n  "emphasis": "strong"'),
			}),
		}),
	);
	await openSource(container);
	const lines = [...container.querySelectorAll(".aui-ui-source-line")];
	expect(lines.map((line) => line.getAttribute("data-change"))).toEqual([
		null,
		null,
		"changed",
		null,
	]);
	const gutter = [...container.querySelectorAll(".aui-ui-source-gutter span")];
	expect(gutter.map((n) => n.getAttribute("data-change"))).toEqual([
		null,
		null,
		"changed",
		null,
	]);
	const summary = container.querySelector(".aui-ui-source-diff")?.textContent;
	expect(summary).toContain("1行を追加・変更");
	expect(summary).toContain("2行を削除");
	expect(summary).toContain('"title": "見出し",');
	expect(summary).toContain('"emphasis": "strong"');
});

test("nothing is marked when there is no earlier revision or nothing changed", async () => {
	const first = await mountStudio(snapshotOf());
	await openSource(first.container);
	expect(first.container.querySelector("[data-change]")).toBeNull();
	expect(first.container.querySelector(".aui-ui-source-diff")).toBeNull();
	const same = await mountStudio(
		snapshotOf({ work: work({ previousSource: sourceOf("見出し") }) }),
	);
	await openSource(same.container);
	expect(same.container.querySelector("[data-change]")).toBeNull();
});

test("editing the text and applying sends the work, the revision and the text", async () => {
	const { container, dispatch } = await mountStudio(snapshotOf());
	await openSource(container);
	expect(buttonOf(container, "編集").disabled).toBe(false);
	await press(container, "編集");
	expect(editor(container).value).toBe(sourceOf("見出し"));
	// No change yet: nothing to apply.
	expect(buttonOf(container, "この内容を反映").disabled).toBe(true);
	const next = sourceOf("直した見出し");
	await typeInto(editor(container), next);
	expect(buttonOf(container, "この内容を反映").disabled).toBe(false);
	await press(container, "この内容を反映");
	expect(dispatch).toHaveBeenCalledTimes(1);
	const event = dispatch.mock.calls[0]?.[0];
	expect(event?.action).toBe("ui-source-apply");
	expect(event?.source).toBe("ui-studio");
	expect(event?.values).toEqual({
		workRef: "work-1",
		expectedRevision: "3",
		text: next,
	});
	// An accepted apply closes the editor; the new text arrives with the next snapshot.
	expect(container.querySelector("textarea")).toBeNull();
});

test("applying is unavailable while a turn runs, for blank text, and the editor cannot open for a saved work", async () => {
	const running = await mountStudio(snapshotOf({ work: work({ busy: true }) }));
	await openSource(running.container);
	expect(buttonOf(running.container, "編集").disabled).toBe(true);

	const idle = await mountStudio(snapshotOf());
	await openSource(idle.container);
	await press(idle.container, "編集");
	await typeInto(editor(idle.container), "  \n");
	expect(buttonOf(idle.container, "この内容を反映").disabled).toBe(true);
	// A turn that starts while editing blocks the apply too.
	await typeInto(editor(idle.container), sourceOf("別の見出し"));
	expect(buttonOf(idle.container, "この内容を反映").disabled).toBe(false);
	await idle.render(snapshotOf({ work: work({ busy: true }) }));
	expect(buttonOf(idle.container, "この内容を反映").disabled).toBe(true);

	const saved = await mountStudio(
		snapshotOf({
			viewing: {
				id: "c1",
				title: "保存済み",
				definition,
				savedRevision: 2,
			},
		}),
	);
	await openSource(saved.container);
	expect(buttonOf(saved.container, "編集").disabled).toBe(true);
	expect(saved.container.querySelector("textarea")).toBeNull();
	expect(saved.container.textContent).not.toContain("反映できなかった案");
});

test("a work that moved after editing began cannot be overwritten by the old text", async () => {
	const { container, dispatch, render } = await mountStudio(snapshotOf());
	await openSource(container);
	await press(container, "編集");
	await typeInto(editor(container), sourceOf("直した見出し"));
	await render(
		snapshotOf({
			work: work({ revision: 4, source: sourceOf("専門担当の見出し") }),
		}),
	);
	expect(buttonOf(container, "この内容を反映").disabled).toBe(true);
	expect(container.textContent).toContain("作品が更新されました");
	expect(dispatch).not.toHaveBeenCalled();
	// Starting over from the new text applies against the new revision.
	await press(container, "編集をやめる");
	await press(container, "編集");
	await typeInto(editor(container), sourceOf("やり直した見出し"));
	await press(container, "この内容を反映");
	expect(dispatch.mock.calls[0]?.[0].values.expectedRevision).toBe("4");
});

test("a refusal is shown beside the editor and the typed text is kept", async () => {
	const { container } = await mountStudio(snapshotOf(), {
		status: "rejected",
		message:
			"定義の検査を通りませんでした（ui_definition_invalid・title: too_long）。",
	});
	await openSource(container);
	await press(container, "編集");
	const next = sourceOf("長すぎる見出し");
	await typeInto(editor(container), next);
	await press(container, "この内容を反映");
	const alert = container.querySelector("[role=alert]");
	expect(alert?.textContent).toContain("ui_definition_invalid");
	expect(alert?.textContent).toContain("title: too_long");
	expect(editor(container).value).toBe(next);
	// Editing again clears the old refusal.
	await typeInto(editor(container), sourceOf("短い見出し"));
	expect(container.querySelector("[role=alert]")).toBeNull();
});

test("the rejected draft is read-only with its issues, can be loaded into the editor, and never reaches the preview", async () => {
	const { container, dispatch } = await mountStudio(
		snapshotOf({ work: work({ rejected }) }),
	);
	// The preview shows the accepted definition only.
	expect(container.textContent).not.toContain("unknown_view");
	await openSource(container);
	const section = container.querySelector(
		'section[aria-label="反映できなかった案"]',
	) as HTMLElement;
	expect(section.textContent).toContain("壊れた案");
	expect(section.textContent).toContain("(root): unknown_view");
	expect(section.textContent).toContain("空の部品を捨てました");
	expect(section.querySelector("pre")?.textContent).toBe(rejected.text);
	expect(section.querySelector("textarea")).toBeNull();
	await press(container, "エディタに読み込む");
	expect(editor(container).value).toBe(rejected.text);
	await press(container, "この内容を反映");
	expect(dispatch.mock.calls[0]?.[0].values).toEqual({
		workRef: "work-1",
		expectedRevision: "3",
		text: rejected.text,
	});
});

test("a first draft that failed the check still offers its text, with no preview", async () => {
	const { container } = await mountStudio(
		snapshotOf({
			work: work({
				definition: null,
				source: "",
				previousSource: "",
				rejected,
			}),
		}),
	);
	await openSource(container);
	expect(container.textContent).toContain("まだ反映された定義がありません");
	expect(container.querySelector(".aui-ui-preview-stage")).toBeNull();
	await press(container, "エディタに読み込む");
	expect(editor(container).value).toBe(rejected.text);
});

test("the toolbar keeps its own actions with the source editor open", async () => {
	const { container, dispatch } = await mountStudio(snapshotOf());
	await openSource(container);
	await press(container, "編集");
	await press(container, "元に戻す");
	expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
		action: "ui-undo",
		values: { workRef: "work-1", expectedRevision: "3" },
	});
});
