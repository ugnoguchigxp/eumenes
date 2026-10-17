import {
	ArtifactRenderer,
	type ArtifactEvent,
	type Snapshot,
	type UiStudioResource,
} from "@eumenes/artifact-ui";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

afterEach(cleanup);

const survey = {
	view: "layout",
	direction: "stack",
	gap: "relaxed",
	children: [
		{ view: "text-block", title: "来場者アンケート", emphasis: "strong" },
		{
			view: "form",
			title: "ご感想",
			fields: [
				{
					id: "rating",
					label: "満足度",
					type: "radio",
					options: ["満足", "普通"],
				},
				{ id: "comment", label: "感想", type: "text" },
			],
		},
	],
};
const studioDefinition = JSON.stringify({
	view: "ui-studio",
	source: "ui-studio",
	title: "UI自由制作",
});
const work = (over: Partial<NonNullable<UiStudioResource["work"]>> = {}) => ({
	workRef: "work-1",
	sessionId: "s1",
	title: "来場者向けの案",
	definition: survey,
	revision: 3,
	savedRef: null,
	savedRevision: null,
	dirty: true,
	busy: false,
	canUndo: true,
	canRedo: false,
	...over,
});
function studio(over: Partial<UiStudioResource> = {}): Snapshot {
	return {
		"ui-studio": {
			kind: "ui-studio",
			revision: 5,
			work: work(),
			viewing: null,
			history: [{ id: "c1", title: "保存済みの案内", updatedAt: 1 }],
			session: { state: "active", expiresAt: "2026-10-18T09:00:00.000Z" },
			stoppable: true,
			...over,
		},
	};
}
function mount(snapshot: Snapshot) {
	const dispatch = vi.fn(async (_event: ArtifactEvent) => ({
		status: "accepted" as const,
		message: "",
	}));
	const view = (next: Snapshot) => (
		<ArtifactRenderer
			definition={studioDefinition}
			runtime={{ snapshot: next, dispatch }}
		/>
	);
	const result = render(view(snapshot));
	return {
		dispatch,
		...result,
		update: (next: Snapshot) => result.rerender(view(next)),
	};
}
const button = (name: string | RegExp) => screen.getByRole("button", { name });
/** One operation at a time: the next click waits until the previous receipt arrived. */
async function click(
	name: string,
	dispatch: { mock: { calls: unknown[] } },
	calls: number,
) {
	fireEvent.click(button(name));
	await vi.waitFor(() => expect(dispatch.mock.calls).toHaveLength(calls));
	await vi.waitFor(() =>
		expect((button(name) as HTMLButtonElement).disabled).toBe(false),
	);
}

test("the draft is the main content, rendered as a composition with a trial form", async () => {
	const { dispatch } = mount(studio());
	expect(
		screen.getByRole("heading", { name: "来場者向けの案", level: 2 }),
	).toBeTruthy();
	expect(
		screen.getByRole("heading", { name: "来場者アンケート", level: 2 }),
	).toBeTruthy();
	expect(screen.getByRole("radio", { name: "満足" })).toBeTruthy();
	expect(screen.getByText("編集中・未保存")).toBeTruthy();
	expect(
		screen.getByText(/保存ボタンを押すまで作品には保存されません/),
	).toBeTruthy();
	fireEvent.click(screen.getByRole("radio", { name: "満足" }));
	fireEvent.click(screen.getByRole("button", { name: "送信（試用）" }));
	expect(
		await screen.findByText("試用です。回答は保存されません。"),
	).toBeTruthy();
	expect(dispatch).not.toHaveBeenCalled();
});

test("undo, redo, save send the work reference and revisions as strings", async () => {
	const { dispatch, update } = mount(
		studio({ work: work({ canRedo: true, savedRef: "c9", savedRevision: 2 }) }),
	);
	await click("元に戻す", dispatch, 1);
	await click("やり直す", dispatch, 2);
	await click("保存", dispatch, 3);
	expect(dispatch.mock.calls.map(([e]) => [e.action, e.values])).toEqual([
		["ui-undo", { workRef: "work-1", expectedRevision: "3" }],
		["ui-redo", { workRef: "work-1", expectedRevision: "3" }],
		[
			"ui-save",
			{ workRef: "work-1", expectedRevision: "3", expectedSavedRevision: "2" },
		],
	]);
	update(studio({ work: work({ dirty: false, canUndo: false }) }));
	expect((button("保存") as HTMLButtonElement).disabled).toBe(true);
	expect((button("元に戻す") as HTMLButtonElement).disabled).toBe(true);
});

test("while a turn runs, save, undo and redo are disabled; stop, discard and return stay available", async () => {
	const { dispatch } = mount(
		studio({ work: work({ busy: true, canRedo: true }) }),
	);
	for (const name of ["元に戻す", "やり直す", "保存"])
		expect((button(name) as HTMLButtonElement).disabled).toBe(true);
	for (const name of ["破棄", "会話に戻る", "停止"])
		expect((button(name) as HTMLButtonElement).disabled).toBe(false);
	await click("停止", dispatch, 1);
	await click("破棄", dispatch, 2);
	await click("会話に戻る", dispatch, 3);
	expect(dispatch.mock.calls.map(([e]) => e.action)).toEqual([
		"ui-stop",
		"ui-discard",
		"ui-return",
	]);
});

test("a suspended work shows its notice and expiry and can be resumed", async () => {
	const { dispatch } = mount(
		studio({
			session: { state: "suspended", expiresAt: "2026-10-18T09:00:00.000Z" },
		}),
	);
	expect(screen.getAllByText(/未保存・一時保留/).length).toBeGreaterThan(0);
	expect(screen.queryByRole("button", { name: "会話に戻る" })).toBeNull();
	// Save and discard stay available while suspended.
	expect((button("保存") as HTMLButtonElement).disabled).toBe(false);
	expect((button("破棄") as HTMLButtonElement).disabled).toBe(false);
	fireEvent.click(button("編集を再開"));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls[0]?.[0].action).toBe("ui-resume"),
	);
});

test("the device switch is display state: the input and the draft survive it and an update", () => {
	const { dispatch, update, container } = mount(studio());
	const comment = screen.getByRole("textbox", {
		name: "感想",
	}) as HTMLInputElement;
	fireEvent.change(comment, { target: { value: "試し入力" } });
	fireEvent.click(button(/モバイル/));
	expect(container.querySelector(".aui-ui-preview-mobile")).toBeTruthy();
	expect(
		(screen.getByRole("textbox", { name: "感想" }) as HTMLInputElement).value,
	).toBe("試し入力");
	update(studio({ work: work({ revision: 4, title: "改訂版" }) }));
	expect(container.querySelector(".aui-ui-preview-mobile")).toBeTruthy();
	expect(
		(screen.getByRole("textbox", { name: "感想" }) as HTMLInputElement).value,
	).toBe("試し入力");
	fireEvent.click(button(/デスクトップ/));
	expect(container.querySelector(".aui-ui-preview-desktop")).toBeTruthy();
	expect(dispatch).not.toHaveBeenCalled();
});

test("history selects a saved work; a viewed saved work uses the answer form and disables edit controls", async () => {
	const { dispatch, update } = mount(studio());
	fireEvent.click(button("作品履歴"));
	const list = screen.getByRole("group", { name: "保存した作品" });
	fireEvent.click(within(list).getByRole("button", { name: "保存済みの案内" }));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
			action: "ui-select",
			values: { id: "c1" },
		}),
	);
	update({
		...studio({
			viewing: {
				id: "c1",
				title: "保存済みの案内",
				definition: survey,
				savedRevision: 2,
			},
		}),
		"composition-form": {
			kind: "form",
			revision: 2,
			fields: [
				{ id: "rating", label: "満足度", type: "radio", options: ["満足"] },
			],
			defaults: {},
		},
	});
	expect(screen.getByText("保存済み")).toBeTruthy();
	expect(
		screen.getByRole("heading", { name: "保存済みの案内", level: 2 }),
	).toBeTruthy();
	expect((button("保存") as HTMLButtonElement).disabled).toBe(true);
	expect((button("元に戻す") as HTMLButtonElement).disabled).toBe(true);
	fireEvent.click(screen.getByRole("radio", { name: "満足" }));
	fireEvent.click(screen.getByRole("button", { name: "フォームを送信" }));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
			action: "submit",
			source: "composition-form",
		}),
	);
});

test("refresh is directly available; closing is the tab's job", async () => {
	const { dispatch } = mount(studio());
	expect(screen.queryByRole("button", { name: "その他" })).toBeNull();
	expect(
		screen.queryByRole("button", { name: "OpenUI設定JSONを確認" }),
	).toBeNull();
	expect(screen.queryByRole("button", { name: "制作画面を閉じる" })).toBeNull();
	fireEvent.click(button("表示を更新"));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls[0]?.[0].action).toBe("ui-refresh"),
	);
});

test("with nothing to show the studio explains how to start", () => {
	mount(studio({ work: null, session: null }));
	expect(screen.getByText("ここに作品を表示します")).toBeTruthy();
	expect((button("破棄") as HTMLButtonElement).disabled).toBe(true);
});

test("without a definition the source view says so, and a running first turn says it is coming", () => {
	const { update } = mount(studio({ work: null, session: null }));
	fireEvent.click(button("ソース"));
	expect(screen.getByText("まだ定義がありません")).toBeTruthy();
	update(
		studio({ work: work({ definition: null, busy: true, dirty: false }) }),
	);
	expect(screen.getByText("初稿を作成しています")).toBeTruthy();
	update(
		studio({ work: work({ definition: null, busy: false, dirty: false }) }),
	);
	expect(screen.getByText("まだ定義がありません")).toBeTruthy();
});

test("the source view shows exactly the shown definition, read-only, and survives updates", async () => {
	const { dispatch, update, container } = mount(studio());
	fireEvent.change(screen.getByRole("textbox", { name: "感想" }), {
		target: { value: "試し入力" },
	});
	fireEvent.click(button("ソース"));
	const code = container.querySelector(".aui-ui-source-code") as HTMLElement;
	expect(code.textContent).toBe(JSON.stringify(survey, null, 2));
	expect(screen.getByText("編集中")).toBeTruthy();
	expect(container.textContent).toContain("revision 3");
	// Line numbers live in a separate, hidden-from-AT gutter, never in the code.
	const gutter = container.querySelector(
		".aui-ui-source-gutter",
	) as HTMLElement;
	expect(gutter.getAttribute("aria-hidden")).toBe("true");
	expect(code.textContent).not.toMatch(/^1\n/);
	expect(screen.queryByRole("button", { name: /モバイル/ })).toBeNull();
	// An update keeps the source mode and shows the new draft.
	update(
		studio({
			work: work({
				revision: 4,
				definition: {
					...survey,
					children: [{ view: "text-block", title: "改訂" }, survey.children[1]],
				},
			}),
		}),
	);
	expect(
		(container.querySelector(".aui-ui-source-code") as HTMLElement).textContent,
	).toContain("改訂");
	// Back to the preview: the trial input was kept.
	fireEvent.click(button("プレビュー"));
	expect(
		(screen.getByRole("textbox", { name: "感想" }) as HTMLInputElement).value,
	).toBe("試し入力");
	expect(dispatch).not.toHaveBeenCalled();
});

test("the source of a viewed saved work is the saved definition", () => {
	const { container } = mount({
		...studio({
			viewing: {
				id: "c1",
				title: "保存済みの案内",
				definition: { view: "text-block", title: "保存版" },
				savedRevision: 8,
			},
		}),
		"composition-form": { kind: "form", revision: 2, fields: [], defaults: {} },
	});
	fireEvent.click(button("ソース"));
	expect(container.textContent).toContain("保存済み");
	expect(container.textContent).toContain("revision 8");
	expect(
		(container.querySelector(".aui-ui-source-code") as HTMLElement).textContent,
	).toContain("保存版");
});

test("the source of a saved work is the stored definition with inline fields when the host gives it", () => {
	const { container } = mount({
		...studio({
			viewing: {
				id: "c1",
				title: "保存済みの案内",
				definition: { view: "form", source: "composition-form" },
				storedDefinition: survey,
				savedRevision: 8,
			},
		}),
		"composition-form": { kind: "form", revision: 2, fields: [], defaults: {} },
	});
	fireEvent.click(button("ソース"));
	expect(
		(container.querySelector(".aui-ui-source-code") as HTMLElement).textContent,
	).toBe(JSON.stringify(survey, null, 2));
});

test("a viewed saved work offers a way back: new creation without a draft, the draft with one", async () => {
	const saved = {
		id: "c1",
		title: "保存済みの案内",
		definition: { view: "text-block", title: "保存版" },
		savedRevision: 8,
	};
	const { dispatch, update } = mount(
		studio({ work: null, session: null, viewing: saved }),
	);
	fireEvent.click(button("新規作成"));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
			action: "ui-select",
			values: { id: "" },
		}),
	);
	update(studio({ viewing: saved }));
	expect(screen.queryByRole("button", { name: "新規作成" })).toBeNull();
	await vi.waitFor(() =>
		expect((button("編集中の案に戻る") as HTMLButtonElement).disabled).toBe(
			false,
		),
	);
	fireEvent.click(button("編集中の案に戻る"));
	await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
	update(studio({ work: null, session: null }));
	expect(
		screen.getByText(
			"会話で作りたいUIを伝えてください。保存した作品は作品履歴から選べます。",
		),
	).toBeTruthy();
});
