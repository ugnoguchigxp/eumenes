import {
	ArtifactRenderer,
	type ArtifactEvent,
	type Snapshot,
	type UiStudioResource,
} from "@eumenes/artifact-ui";
import {
	act,
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
const work = (over: Partial<NonNullable<UiStudioResource["work"]>> = {}) => {
	const definition = "definition" in over ? over.definition : survey;
	return {
		workRef: "work-1",
		sessionId: "s1",
		title: "来場者向けの案",
		definition,
		revision: 3,
		savedRef: null,
		savedRevision: null,
		dirty: true,
		busy: false,
		canUndo: true,
		canRedo: false,
		// The host's canonical text of the shown definition (its source view).
		source: definition ? JSON.stringify(definition, null, 2) : "",
		previousSource: "",
		rejected: null,
		...over,
	};
};
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

test("a workflow shows each movie as a heading with its own screenings", () => {
	mount(
		studio({
			appDevelopment: true,
			work: null,
			viewing: {
				id: "movies",
				title: "上映一覧",
				savedRevision: 2,
				definition: { view: "grouped-list", groups: [] },
				bindings: {
					inputs: {},
					sections: {
						path: [],
						rowsKey: "rows",
						groupBy: "title",
						itemKeys: ["startTime", "format"],
						labels: { format: { "2D": "通常" } },
					},
				},
				data: {
					rows: [
						{
							title: "第一の映画",
							startTime: "09:00",
							format: "2D",
						},
						{
							title: "第一の映画",
							startTime: "11:00",
						},
						{
							title: "第一の映画[IMAX]",
							startTime: "14:30",
							format: "IMAX",
						},
					],
				},
			},
		}),
	);
	const first = screen
		.getByRole("heading", { name: "第一の映画" })
		.closest("section")!;
	const second = screen
		.getByRole("heading", { name: "第一の映画[IMAX]" })
		.closest("section")!;
	const screenings = (section: HTMLElement) =>
		within(section)
			.getAllByRole("listitem")
			.map((item) => item.textContent);
	expect(screenings(first)).toEqual(["09:00通常", "11:00"]);
	expect(screenings(second)).toEqual(["14:30IMAX"]);
	expect(screen.queryByRole("table")).toBeNull();
});

test("a screening list shows shared formats once and moves the next screening at its start time", () => {
	vi.useFakeTimers();
	try {
		vi.setSystemTime(new Date("2026-11-09T14:57:00+09:00"));
		const title = "ゴジラ [IMAXレーザー]";
		const viewing = {
			id: "screenings",
			title: "上映一覧",
			savedRevision: 2,
			definition: { view: "grouped-list", groups: [] },
			bindings: {
				inputs: {},
				sections: {
					path: [],
					rowsKey: "rows",
					groupBy: "title",
					itemKeys: ["startTime", "format"],
					labels: { format: { "2D": "通常" } },
				},
			},
			workflow: { publish: { schemaRef: "schema:showtimes.rows@1" } },
			data: {
				date: "2026-11-09",
				rows: [
					...["14:45", "17:40", "20:35"].map((startTime) => ({
						title,
						startTime,
						format: "IMAXレーザー",
					})),
					...["09:00", "15:30"].map((startTime) => ({
						title: "別の作品",
						startTime,
						format: "2D",
					})),
				],
			},
		};
		const snapshot = (date: string) =>
			studio({
				appDevelopment: true,
				work: null,
				viewing: { ...viewing, data: { ...viewing.data, date } },
			});
		const { update } = mount(snapshot("2026-11-09"));
		const section = (title: string) =>
			screen.getByRole("heading", { name: title }).closest("section")!;
		const imax = section(title);
		const normal = section("別の作品");
		expect(
			within(imax).queryByText("IMAXレーザー", { exact: true }),
		).toBeNull();
		expect(within(normal).getAllByText("通常", { exact: true })).toHaveLength(
			1,
		);
		expect(imax.querySelector("[data-next] strong")?.textContent).toBe("17:40");
		expect(normal.querySelector("[data-next] strong")?.textContent).toBe(
			"15:30",
		);
		act(() => vi.advanceTimersByTime(163 * 60_000));
		expect(imax.querySelector("[data-next] strong")?.textContent).toBe("20:35");
		expect(normal.querySelector("[data-next]")).toBeNull();
		update(snapshot("2026-11-10"));
		expect(screen.queryByText("次回")).toBeNull();
	} finally {
		cleanup();
		vi.useRealTimers();
	}
});

test("the movie list refresh submits the date from outside the date form", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	try {
		vi.setSystemTime(new Date(2026, 10, 9, 0, 5));
		let output: unknown = { view: "grouped-list", groups: [] };
		for (let depth = 0; depth < 4; depth++)
			output = { view: "layout", children: [output] };
		const viewing = {
			id: "screenings",
			title: "上映一覧",
			savedRevision: 2,
			definition: {
				view: "layout",
				children: [
					{
						view: "form",
						fields: [
							{
								id: "date",
								label: "上映日",
								type: "date",
								required: true,
								defaultDate: "today",
							},
						],
					},
					output,
				],
			},
			bindings: {
				inputs: { date: "date" },
				sections: {
					path: [1, 0, 0, 0, 0],
					rowsKey: "rows",
					groupBy: "title",
					itemKeys: ["startTime"],
				},
			},
			workflow: {
				trigger: "manual",
				publish: { schemaRef: "schema:showtimes.rows@1" },
			},
		};
		const snapshot = (
			data?: unknown,
			status?: NonNullable<UiStudioResource["viewing"]>["status"],
		) =>
			studio({
				appDevelopment: true,
				work: null,
				viewing: { ...viewing, data, status },
			});
		const { dispatch, update } = mount(snapshot());
		const date = () => screen.getByLabelText(/上映日/) as HTMLInputElement;
		const list = () => screen.getByRole("region", { name: "上映作品" });
		const refreshLabel = "作品リストを更新";
		const refresh = () =>
			within(list()).getByRole("button", {
				name: refreshLabel,
			}) as HTMLButtonElement;
		expect(date().type).toBe("date");
		expect(date().value).toBe("2026-11-09");
		expect(list().contains(date())).toBe(false);
		expect(refresh().closest("form")).toBeNull();
		expect(refresh().form).toBe(date().form);
		expect(
			within(date().form!).queryByRole("button", { name: "更新" }),
		).toBeNull();
		fireEvent.change(date(), { target: { value: "2026-11-10" } });
		expect(dispatch).not.toHaveBeenCalled();
		await click(refreshLabel, dispatch, 1);
		expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
			action: "ui-workflow-run",
			values: { values: '{"date":"2026-11-10"}' },
		});
		const data = { rows: [{ title: "作品", startTime: "12:00" }] };
		update(snapshot(data, { state: "completed" }));
		expect(
			screen.queryByRole("region", { name: "アプリの実行状況" }),
		).toBeNull();
		expect(date().value).toBe("2026-11-10");
		expect(within(list()).getByRole("heading", { name: "作品" })).toBeTruthy();
		await click(refreshLabel, dispatch, 2);
		expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
			action: "ui-workflow-run",
			values: { values: '{"date":"2026-11-10"}' },
		});
		update(snapshot(data, { state: "running", runId: "running-1" }));
		expect(screen.getByText("実行中")).toBeTruthy();
		expect(button("実行を取り消す")).toBeTruthy();
		update(snapshot(data, { state: "failed" }));
		expect(screen.getByText("失敗")).toBeTruthy();
		update(snapshot({ ...data, coverage: "partial" }, { state: "completed" }));
		expect(screen.getByText("確認できた範囲のみ表示しています。")).toBeTruthy();
		expect(screen.queryByText("完了", { exact: true })).toBeNull();
		vi.setSystemTime(new Date(2026, 10, 10, 0, 5));
		fireEvent.change(date(), { target: { value: "2026-11-11" } });
		fireEvent.click(button("入力をリセット"));
		expect(date().value).toBe("2026-11-10");
	} finally {
		cleanup();
		vi.useRealTimers();
	}
});

test("history selects a saved work; a viewed saved work uses the answer form and disables edit controls", async () => {
	const { dispatch, update } = mount(studio({ work: work({ dirty: false }) }));
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
	// Viewing is not editing: the draft's controls give way to deleting the saved work.
	for (const name of ["保存", "元に戻す", "やり直す", "破棄"])
		expect(screen.queryByRole("button", { name })).toBeNull();
	expect(button("削除")).toBeTruthy();
	fireEvent.click(screen.getByRole("radio", { name: "満足" }));
	fireEvent.click(screen.getByRole("button", { name: "フォームを送信" }));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls.at(-1)?.[0]).toMatchObject({
			action: "submit",
			source: "composition-form",
		}),
	);
});

test("choosing another saved work over unsaved work asks first: discard and switch, or keep editing", async () => {
	const { dispatch } = mount(studio());
	const pick = () => {
		fireEvent.click(button("作品履歴"));
		fireEvent.click(
			within(screen.getByRole("group", { name: "保存した作品" })).getByRole(
				"button",
				{ name: "保存済みの案内" },
			),
		);
	};
	pick();
	const dialog = await screen.findByRole("dialog");
	expect(
		within(dialog).getByText(/「保存済みの案内」の編集に切り替えます/),
	).toBeTruthy();
	fireEvent.click(within(dialog).getByRole("button", { name: "編集を続ける" }));
	expect(dispatch).not.toHaveBeenCalled();
	pick();
	fireEvent.click(
		within(await screen.findByRole("dialog")).getByRole("button", {
			name: "破棄して切り替える",
		}),
	);
	await vi.waitFor(() =>
		expect(dispatch.mock.calls.map(([e]) => [e.action, e.values])).toEqual([
			["ui-retarget", { id: "c1" }],
		]),
	);
});

test("deleting a viewed saved work asks first and sends its id and saved revision", async () => {
	const { dispatch } = mount(
		studio({
			work: null,
			session: null,
			viewing: {
				id: "c1",
				title: "保存済みの案内",
				definition: survey,
				savedRevision: 2,
			},
		}),
	);
	fireEvent.click(button("削除"));
	const dialog = await screen.findByRole("dialog");
	expect(within(dialog).getByText(/「保存済みの案内」/)).toBeTruthy();
	fireEvent.click(within(dialog).getByRole("button", { name: "やめる" }));
	expect(dispatch).not.toHaveBeenCalled();
	fireEvent.click(button("削除"));
	fireEvent.click(
		within(await screen.findByRole("dialog")).getByRole("button", {
			name: "削除する",
		}),
	);
	await vi.waitFor(() =>
		expect(dispatch.mock.calls.map(([e]) => [e.action, e.values])).toEqual([
			["ui-delete", { projectId: "c1", expectedSavedRevision: "2" }],
		]),
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

test("the saved app toolbar returns to editing and its history lists only saved works", async () => {
	const saved = {
		id: "c1",
		title: "保存済みの案内",
		definition: { view: "text-block", title: "保存版" },
		savedRevision: 8,
	};
	const { dispatch, update } = mount(
		studio({ appDevelopment: true, work: null, session: null, viewing: saved }),
	);
	const toolbar = within(screen.getByRole("toolbar", { name: "UI制作の操作" }));
	fireEvent.click(toolbar.getByRole("button", { name: "新規作成" }));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
			action: "ui-select",
			values: { id: "" },
		}),
	);
	update(
		studio({
			appDevelopment: true,
			viewing: saved,
			work: work({ dirty: false }),
		}),
	);
	expect(toolbar.getByRole("button", { name: "編集に戻る" })).toBeTruthy();
	update(studio({ appDevelopment: true, viewing: saved }));
	expect(screen.queryByRole("button", { name: "新規作成" })).toBeNull();
	expect(screen.queryByText(/編集中の案は残っています/)).toBeNull();
	expect(
		screen.queryByText(/保存ボタンを押すまで作品には保存されません/),
	).toBeNull();
	fireEvent.click(toolbar.getByRole("button", { name: "作品履歴" }));
	const history = screen.getByRole("dialog", { name: "作品履歴" });
	expect(
		within(history)
			.getAllByRole("button")
			.map((item) => item.textContent),
	).toEqual(["保存済みの案内"]);
	fireEvent.keyDown(history, { key: "Escape" });
	await vi.waitFor(() =>
		expect(screen.queryByRole("dialog", { name: "作品履歴" })).toBeNull(),
	);
	fireEvent.click(toolbar.getByRole("button", { name: "編集中の案に戻る" }));
	await vi.waitFor(() =>
		expect(dispatch.mock.calls[1]?.[0]).toMatchObject({
			action: "ui-select",
			values: { id: "" },
		}),
	);
	update(studio({ appDevelopment: true }));
	expect(
		screen.getByText(/保存ボタンを押すまで作品には保存されません/),
	).toBeTruthy();
	update(studio({ work: null, session: null }));
	expect(
		screen.getByText(
			"会話で作りたいUIを伝えてください。保存した作品は作品履歴から選べます。",
		),
	).toBeTruthy();
});
