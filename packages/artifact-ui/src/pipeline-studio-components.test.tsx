import { afterAll, afterEach, expect, mock, test } from "bun:test";
// @ts-expect-error jsdom has no type declarations in this repository
import { JSDOM } from "jsdom";
import type { ArtifactEvent, Receipt, Snapshot } from "./contracts";
import type { PipelineStudioResource } from "./pipeline-studio-contracts";

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
const { PipelineStudioView } = await import("./pipeline-studio-components");

type Work = NonNullable<PipelineStudioResource["work"]>;
const sourceOf = (id: string) => `{\n  "id": "${id}",\n  "steps": []\n}`;
const work = (over: Partial<Work> = {}): Work => ({
	workRef: "work-1",
	sessionId: "s1",
	title: "天気",
	revision: 3,
	source: sourceOf("weather"),
	previousSource: "",
	rejected: null,
	issues: [],
	flow: { inputs: [], steps: [], answer: null },
	tests: [{ index: 0, utterance: "東京の天気" }],
	published: null,
	dirty: true,
	busy: false,
	...over,
});
const snapshotOf = (over: Partial<PipelineStudioResource> = {}): Snapshot => ({
	"pipeline-studio": {
		kind: "pipeline-studio",
		revision: 5,
		work: work(),
		history: [
			{
				toolchainId: "pipeline.weather",
				title: "天気",
				toolchainRevisionId: "r1",
			},
		],
		session: { state: "active", expiresAt: "2026-10-22T09:00:00.000Z" },
		stoppable: false,
		trial: null,
		...over,
	},
});

const roots: Array<{ unmount: () => void }> = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	document.body.innerHTML = "";
});

async function mount(
	snapshot: Snapshot,
	receipt: Receipt = { status: "accepted", message: "" },
) {
	const dispatch = mock(async (_event: ArtifactEvent) => receipt);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<ArtifactRuntimeContext.Provider value={{ snapshot, dispatch }}>
				<PipelineStudioView
					request={
						{
							view: "pipeline-studio",
							source: "pipeline-studio",
							title: "パイプライン制作",
						} as never
					}
				/>
			</ArtifactRuntimeContext.Provider>,
		);
	});
	return { container, dispatch };
}
const buttonOf = (container: HTMLElement, name: string) => {
	const found = [...container.querySelectorAll("button")].find(
		(b) =>
			b.textContent?.trim() === name || b.getAttribute("aria-label") === name,
	);
	if (!found) throw new Error(`no button ${name}`);
	return found as HTMLButtonElement;
};
const press = (container: HTMLElement, name: string) =>
	act(async () => {
		buttonOf(container, name).click();
	});
async function typeInto(
	field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
	value: string,
) {
	await act(async () => {
		const proto =
			field instanceof dom.window.HTMLTextAreaElement
				? dom.window.HTMLTextAreaElement.prototype
				: field instanceof dom.window.HTMLSelectElement
					? dom.window.HTMLSelectElement.prototype
					: dom.window.HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
		field.dispatchEvent(
			new dom.window.Event(
				field instanceof dom.window.HTMLSelectElement ? "change" : "input",
				{
					bubbles: true,
				},
			),
		);
	});
}
const field = (container: HTMLElement, selector: string) =>
	container.querySelector(selector) as HTMLInputElement;
const labelled = (container: HTMLElement, text: string) => {
	const label = [...container.querySelectorAll("label")].find(
		(l) => l.textContent === text,
	);
	return document.getElementById(label?.htmlFor ?? "") as HTMLInputElement;
};
const last = (dispatch: { mock: { calls: ArtifactEvent[][] } }) =>
	dispatch.mock.calls.at(-1)?.[0];

test("it renders only the pipeline studio resource", async () => {
	const other = await mount({
		"pipeline-studio": { kind: "ui-studio" } as never,
	});
	expect(other.container.textContent).toBe("");
	const { container } = await mount(snapshotOf());
	expect(container.textContent).toContain("天気");
	expect(container.querySelector(".pipeline-studio")).not.toBeNull();
});

test("the last change is marked from the previous source", async () => {
	const { container } = await mount(
		snapshotOf({
			work: work({
				source: sourceOf("weather"),
				previousSource: sourceOf("old"),
			}),
		}),
	);
	const changed = container.querySelectorAll(
		'.pipeline-studio-line-text[data-change="changed"]',
	);
	expect(changed).toHaveLength(1);
	expect(container.textContent).toContain("1行を追加・変更");
});

test("applying the edited text sends the work, the revision and the text", async () => {
	const { container, dispatch } = await mount(snapshotOf());
	await press(container, "編集");
	await typeInto(field(container, "textarea"), sourceOf("changed"));
	await press(container, "この内容を反映");
	expect(last(dispatch)).toMatchObject({
		source: "pipeline-studio",
		revision: 5,
		action: "pipeline-source-apply",
		values: {
			workRef: "work-1",
			expectedRevision: "3",
			text: sourceOf("changed"),
		},
	});
});

test("a refused apply stays in the editor and shows the host's wording", async () => {
	const { container } = await mount(snapshotOf(), {
		status: "rejected",
		message: "JSONとして読み取れませんでした（document_parse_failed）。",
	});
	await press(container, "編集");
	await typeInto(field(container, "textarea"), "{");
	await press(container, "この内容を反映");
	expect(container.querySelector("textarea")).not.toBeNull();
	expect(container.querySelector("[role=alert]")?.textContent).toContain(
		"document_parse_failed",
	);
});

test("publish sends the revision; it is unavailable with findings or no change", async () => {
	const { container, dispatch } = await mount(snapshotOf());
	await press(container, "公開");
	expect(last(dispatch)).toMatchObject({
		action: "pipeline-publish",
		values: { workRef: "work-1", expectedRevision: "3" },
	});
	const issues = await mount(
		snapshotOf({
			work: work({ issues: [{ pointer: "/id", rule: "invalid_id", line: 2 }] }),
		}),
	);
	expect(buttonOf(issues.container, "公開").disabled).toBe(true);
});

test("the three trials dispatch their local actions", async () => {
	const { container, dispatch } = await mount(snapshotOf());
	await typeInto(labelled(container, "確認することば"), "天気");
	await press(container, "確認");
	expect(last(dispatch)).toMatchObject({
		action: "pipeline-probe",
		values: { query: "天気" },
	});
	await typeInto(labelled(container, "発話"), "東京の天気は");
	await press(container, "選択を試す");
	expect(last(dispatch)).toMatchObject({
		action: "pipeline-select",
		values: { utterance: "東京の天気は" },
	});
	await press(container, "試験運転を実行");
	expect(last(dispatch)).toMatchObject({
		action: "pipeline-fixture",
		values: { test: "0" },
	});
});

test("a trial result from the host is shown and the trials wait while one runs", async () => {
	const done = await mount(
		snapshotOf({
			trial: {
				kind: "select",
				utterance: "x",
				pending: false,
				result: {
					ok: true,
					chosen: "weather_fn",
					matched: true,
					next: null,
					inputs: null,
					code: null,
				},
			},
		}),
	);
	expect(done.container.textContent).toContain("この案が選ばれました");
	const running = await mount(
		snapshotOf({
			trial: { kind: "probe", query: "x", pending: true, result: null },
		}),
	);
	expect(buttonOf(running.container, "試験運転を実行").disabled).toBe(true);
	expect(running.container.textContent).toContain("確認しています");
});

test("opening, refreshing and the session operations dispatch their events", async () => {
	const { container, dispatch } = await mount(
		snapshotOf({ work: work({ busy: true }), stoppable: true }),
	);
	await typeInto(
		container.querySelector("select") as HTMLSelectElement,
		"pipeline.weather",
	);
	expect(last(dispatch)).toMatchObject({
		action: "pipeline-open",
		values: { toolchainId: "pipeline.weather" },
	});
	for (const [name, action] of [
		["表示を更新", "pipeline-refresh"],
		["会話に戻る", "pipeline-return"],
		["閉じる", "pipeline-close"],
		["停止", "pipeline-stop"],
	] as const) {
		await press(container, name);
		expect(last(dispatch)?.action).toBe(action);
	}
	const suspended = await mount(
		snapshotOf({
			session: { state: "suspended", expiresAt: "2026-10-22T09:00:00.000Z" },
		}),
	);
	await press(suspended.container, "編集を再開");
	expect(last(suspended.dispatch)?.action).toBe("pipeline-resume");
});

test("a studio without a draft shows the empty state", async () => {
	const { container } = await mount(snapshotOf({ work: null, session: null }));
	expect(container.textContent).toContain("ここにパイプラインを表示します");
});
