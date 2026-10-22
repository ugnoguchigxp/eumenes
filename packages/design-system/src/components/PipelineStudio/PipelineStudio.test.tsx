import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineStudio, type PipelineStudioProps } from "./PipelineStudio";
import type { PipelineStudioWorkData } from "./types";

afterEach(cleanup);

const source = '{\n  "id": "weather",\n  "steps": []\n}';
const work = (
	over: Partial<PipelineStudioWorkData> = {},
): PipelineStudioWorkData => ({
	workRef: "work-1",
	title: "天気",
	revision: 3,
	source,
	rejected: null,
	issues: [],
	flow: {
		inputs: [{ name: "city", type: "string", required: true }],
		steps: [],
		answer: null,
	},
	tests: [
		{ index: 0, utterance: "東京の天気" },
		{ index: 1, utterance: "大阪の天気" },
	],
	published: null,
	dirty: true,
	busy: false,
	...over,
});
const setup = (props: Partial<PipelineStudioProps> = {}) => {
	const callbacks = {
		onApply: vi.fn(async () => true),
		onPublish: vi.fn(),
		onProbe: vi.fn(),
		onSelect: vi.fn(),
		onFixture: vi.fn(),
		onOpen: vi.fn(),
		onRefresh: vi.fn(),
		onReturn: vi.fn(),
		onResume: vi.fn(),
		onClose: vi.fn(),
		onStop: vi.fn(),
	};
	const user = userEvent.setup();
	const view = render(
		<PipelineStudio work={work()} {...callbacks} {...props} />,
	);
	return { user, ...callbacks, ...view };
};

describe("PipelineStudio", () => {
	it("applies the edited source with the revision it was taken from", async () => {
		const h = setup();
		await h.user.click(screen.getByRole("button", { name: "編集" }));
		const editor = screen.getByRole("textbox", {
			name: "パイプライン定義JSONの編集",
		});
		await h.user.clear(editor);
		await h.user.type(editor, "{{}");
		await h.user.click(screen.getByRole("button", { name: "この内容を反映" }));
		expect(h.onApply).toHaveBeenCalledWith("{}", 3);
	});

	it("keeps the apply button off while busy, unchanged or empty", async () => {
		const h = setup();
		await h.user.click(screen.getByRole("button", { name: "編集" }));
		const apply = screen.getByRole("button", { name: "この内容を反映" });
		expect((apply as HTMLButtonElement).disabled).toBe(true);
		const editor = screen.getByRole("textbox", {
			name: "パイプライン定義JSONの編集",
		});
		await h.user.clear(editor);
		expect((apply as HTMLButtonElement).disabled).toBe(true);
		cleanup();
		setup({ work: work({ busy: true }) });
		expect(
			(screen.getByRole("button", { name: "編集" }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	it("stays in the editor when the host refuses the text and shows why", async () => {
		const h = setup({
			onApply: vi.fn(async () => false),
			result: { status: "rejected", message: "JSONとして読み取れませんでした" },
		});
		await h.user.click(screen.getByRole("button", { name: "編集" }));
		await h.user.type(
			screen.getByRole("textbox", { name: "パイプライン定義JSONの編集" }),
			" ",
		);
		await h.user.click(screen.getByRole("button", { name: "この内容を反映" }));
		expect(await screen.findByRole("alert")).toHaveProperty(
			"textContent",
			"JSONとして読み取れませんでした",
		);
		expect(
			screen.getByRole("textbox", { name: "パイプライン定義JSONの編集" }),
		).toBeTruthy();
	});

	it("marks the lines the last change touched and the lines the check names", () => {
		setup({
			work: work({
				issues: [{ pointer: "/steps", rule: "empty_steps", line: 3 }],
			}),
			diff: { changed: [false, true, false, false], removed: [] },
		});
		const frame = screen.getByRole("region", { name: "パイプライン定義JSON" });
		expect(frame.querySelectorAll('[data-change="changed"]').length).toBe(2);
		expect(frame.querySelectorAll('span[data-issue="true"]').length).toBe(2);
		expect(screen.getByText(/1行を追加・変更/)).toBeTruthy();
	});

	it("shows the rejected draft and loads it into the editor", async () => {
		const h = setup({
			work: work({
				rejected: {
					title: "壊れた案",
					text: '{"id": 1}',
					issues: [{ path: "/id", rule: "invalid_type" }],
					fixes: [],
				},
			}),
		});
		expect(screen.getByText("形式の検査を通りませんでした")).toBeTruthy();
		expect(screen.getByText("/id: invalid_type")).toBeTruthy();
		await h.user.click(
			screen.getByRole("button", { name: "エディタに読み込む" }),
		);
		expect(
			(
				screen.getByRole("textbox", {
					name: "パイプライン定義JSONの編集",
				}) as HTMLTextAreaElement
			).value,
		).toBe('{"id": 1}');
	});

	it("publishes the current revision, only when clean, changed and idle", async () => {
		const h = setup();
		await h.user.click(screen.getByRole("button", { name: "公開" }));
		expect(h.onPublish).toHaveBeenCalledWith(3);
		const disabled = (props: Partial<PipelineStudioProps>) => {
			cleanup();
			setup(props);
			return (screen.getByRole("button", { name: "公開" }) as HTMLButtonElement)
				.disabled;
		};
		expect(disabled({ work: work({ busy: true }) })).toBe(true);
		expect(
			disabled({
				work: work({ issues: [{ pointer: "/id", rule: "x", line: null }] }),
			}),
		).toBe(true);
		expect(disabled({ work: work({ dirty: false }) })).toBe(true);
		expect(disabled({ pending: true })).toBe(true);
	});

	it("shows the published revision", () => {
		setup({
			work: work({
				dirty: false,
				published: {
					toolchainRevisionId: "toolchain:pipeline.weather@1",
					functionName: "weather_fn",
					revision: 2,
				},
			}),
		});
		expect(screen.getByText("weather_fn")).toBeTruthy();
		expect(screen.getByText("公開済み")).toBeTruthy();
	});

	it("probes a wording with Enter and with the button", async () => {
		const h = setup();
		const button = screen.getByRole("button", { name: "確認" });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		await h.user.type(screen.getByLabelText("確認することば"), "天気{Enter}");
		expect(h.onProbe).toHaveBeenCalledWith("天気");
		await h.user.click(button);
		expect(h.onProbe).toHaveBeenCalledTimes(2);
	});

	it("tests the selection of an utterance", async () => {
		const h = setup();
		await h.user.type(screen.getByLabelText("発話"), "東京の天気は");
		await h.user.click(screen.getByRole("button", { name: "選択を試す" }));
		expect(h.onSelect).toHaveBeenCalledWith("東京の天気は");
	});

	it("runs the chosen fixture case, the first one by default", async () => {
		const h = setup();
		await h.user.click(screen.getByRole("button", { name: "試験運転を実行" }));
		expect(h.onFixture).toHaveBeenLastCalledWith(0);
		await h.user.selectOptions(screen.getByLabelText("試験例"), "1");
		await h.user.click(screen.getByRole("button", { name: "試験運転を実行" }));
		expect(h.onFixture).toHaveBeenLastCalledWith(1);
	});

	it("disables every trial while one is running or the host is busy", () => {
		setup({
			trial: { kind: "probe", query: "天気", pending: true, result: null },
		});
		expect(screen.getByText("確認しています")).toBeTruthy();
		expect(
			(
				screen.getByRole("button", {
					name: "試験運転を実行",
				}) as HTMLButtonElement
			).disabled,
		).toBe(true);
	});

	it("shows the probe table with the draft highlighted and its passages", () => {
		setup({
			trial: {
				kind: "probe",
				query: "天気",
				pending: false,
				result: {
					ok: true,
					candidates: [
						{
							toolchainId: "web.search",
							title: "Web検索",
							functionName: "web_search",
							rank: 1,
							similarity: 0.7,
							ftsRank: 1,
							draft: false,
						},
						{
							toolchainId: "pipeline.weather",
							title: "天気",
							functionName: "weather_fn",
							rank: 2,
							similarity: 0.65,
							ftsRank: null,
							draft: true,
						},
					],
					passages: [{ text: "天気を調べる", similarity: 0.65 }],
				},
			},
		});
		const rows = screen.getAllByRole("row");
		expect(rows[2]?.getAttribute("data-draft")).toBe("true");
		expect(within(rows[2]!).getByText("この案")).toBeTruthy();
		expect(within(rows[1]!).getByText("0.700")).toBeTruthy();
		expect(screen.getByRole("list", { name: "この案の索引文" })).toBeTruthy();
	});

	it("shows what the first round chose, and why a trial could not be made", () => {
		const { rerender, ...rest } = setup({
			trial: {
				kind: "select",
				utterance: "x",
				pending: false,
				result: {
					ok: true,
					chosen: "weather_fn",
					matched: true,
					next: null,
					inputs: { city: "東京" },
					code: null,
				},
			},
		});
		expect(screen.getByText("この案が選ばれました")).toBeTruthy();
		expect(screen.getByText('{"city":"東京"}')).toBeTruthy();
		rerender(
			<PipelineStudio
				work={work()}
				onApply={rest.onApply}
				onPublish={rest.onPublish}
				onProbe={rest.onProbe}
				onSelect={rest.onSelect}
				onFixture={rest.onFixture}
				trial={{
					kind: "select",
					utterance: "x",
					pending: false,
					result: { ok: false, code: "work_busy" },
				}}
			/>,
		);
		expect(screen.getByRole("alert").textContent).toContain("work_busy");
	});

	it("shows the fixture outcome with failures and each step's request", () => {
		setup({
			trial: {
				kind: "fixture",
				test: 0,
				pending: false,
				result: {
					ok: true,
					outcome: {
						passed: false,
						steps: [{ id: "search", request: "東京 の天気" }],
						answer: "晴れ",
						failures: [
							{
								path: "/answer",
								code: "mismatch",
								expected: "曇り",
								actual: "晴れ",
							},
						],
					},
				},
			},
		});
		expect(screen.getByRole("status").textContent).toBe("不合格");
		expect(screen.getByText("東京 の天気")).toBeTruthy();
		expect(screen.getByText('"曇り"')).toBeTruthy();
	});

	it("opens a published pipeline or returns to the draft from the menu", async () => {
		const h = setup({
			history: [{ toolchainId: "pipeline.weather", title: "天気" }],
		});
		const menu = screen.getByLabelText("公開済みのパイプライン");
		await h.user.selectOptions(menu, "pipeline.weather");
		expect(h.onOpen).toHaveBeenLastCalledWith("pipeline.weather");
		await h.user.selectOptions(menu, "編集中の案");
		expect(h.onOpen).toHaveBeenLastCalledWith("");
	});

	it("offers refresh, return, close, resume and stop through the session", async () => {
		const h = setup({
			work: work({ busy: true }),
			session: { state: "active", expiresAt: "2026-10-22T12:00:00.000Z" },
			stoppable: true,
		});
		await h.user.click(screen.getByRole("button", { name: "表示を更新" }));
		await h.user.click(screen.getByRole("button", { name: "会話に戻る" }));
		await h.user.click(screen.getByRole("button", { name: "閉じる" }));
		await h.user.click(screen.getByRole("button", { name: "停止" }));
		expect(h.onRefresh).toHaveBeenCalledOnce();
		expect(h.onReturn).toHaveBeenCalledOnce();
		expect(h.onClose).toHaveBeenCalledOnce();
		expect(h.onStop).toHaveBeenCalledOnce();
		cleanup();
		const s = setup({
			session: { state: "suspended", expiresAt: "2026-10-22T12:00:00.000Z" },
		});
		await s.user.click(screen.getByRole("button", { name: "編集を再開" }));
		expect(s.onResume).toHaveBeenCalledOnce();
		expect(screen.queryByRole("button", { name: "会話に戻る" })).toBeNull();
	});

	it("shows the loading, error and empty states", () => {
		const { rerender, ...rest } = setup({ loading: true, work: null });
		expect(screen.getByText("読み込んでいます")).toBeTruthy();
		const props = {
			onApply: rest.onApply,
			onPublish: rest.onPublish,
			onProbe: rest.onProbe,
			onSelect: rest.onSelect,
			onFixture: rest.onFixture,
		};
		rerender(<PipelineStudio work={null} error="読み込めません" {...props} />);
		expect(screen.getByRole("alert").textContent).toBe("読み込めません");
		rerender(<PipelineStudio work={null} {...props} />);
		expect(screen.getByText("ここにパイプラインを表示します")).toBeTruthy();
	});
});

it("keeps the modal frozen if its work is replaced and restores the card focus on cancel", async () => {
	const source = JSON.stringify({
		inputs: {},
		steps: [{ id: "first", kind: "toolchain", title: "手順", request: "依頼" }],
	});
	const current = work({
		source,
		flow: {
			inputs: [],
			steps: [
				{
					id: "first",
					kind: "toolchain",
					title: "手順",
					toolchain: "web.search",
					reads: [],
					inputs: [],
				},
			],
			answer: null,
		},
	});
	const h = setup({ work: current });
	await h.user.click(screen.getByRole("button", { name: "渡すものを編集" }));
	h.rerender(
		<PipelineStudio
			work={{
				...current,
				workRef: "another",
				source: JSON.stringify({ inputs: {}, steps: [] }),
			}}
			onApply={h.onApply}
			onPublish={h.onPublish}
			onProbe={h.onProbe}
			onSelect={h.onSelect}
			onFixture={h.onFixture}
		/>,
	);
	expect(screen.getByRole("alert")).toHaveTextContent("ほかの更新");
	expect(screen.getByRole("button", { name: "反映" })).toBeDisabled();
	await h.user.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(h.onApply).not.toHaveBeenCalled();
});
