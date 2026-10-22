import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { PipelineHandoff } from "./PipelineHandoff";
import type { PipelineStudioWorkData } from "./types";
import type { PipelineMediaLibrary } from "./handoff-types";

afterEach(cleanup);
export const handoffWork: PipelineStudioWorkData = {
	workRef: "work-1",
	title: "制作",
	revision: 3,
	source: JSON.stringify({
		inputs: { topic: { description: "テーマ", required: true } },
		steps: [
			{
				id: "first",
				kind: "toolchain",
				title: "調べる",
				request: "${inputs.topic}",
			},
			{
				id: "request",
				kind: "toolchain",
				title: "作る",
				request: "${steps.first.summary}",
			},
		],
		tests: [
			{
				stepResults: {
					first: { output: { nil: null, n: 0, list: [false, ""] } },
				},
			},
		],
	}),
	rejected: null,
	issues: [],
	flow: { inputs: [], steps: [], answer: null },
	tests: [],
	published: null,
	dirty: true,
	busy: false,
};
const media: PipelineMediaLibrary = {
	kind: "image",
	loading: false,
	query: "",
	images: [{ id: "img-1", title: "風景" }],
	tracks: [
		{
			id: "track-1",
			title: "BGM",
			durationSeconds: 60,
			audioUrl: "/api/music/tracks/track-1/audio",
		},
	],
};
function setup(library = media, work = handoffWork) {
	const onApply = vi.fn(async (_text: string, _revision: number) => true),
		onClose = vi.fn(),
		onLibrary = vi.fn();
	const props = {
		work,
		stepId: "request",
		pending: false,
		library,
		onApply,
		onClose,
		onLibrary,
	};
	return {
		...render(<PipelineHandoff {...props} />),
		props,
		onApply,
		onClose,
		onLibrary,
		user: userEvent.setup(),
	};
}

test("small modal keeps body and prompt original, and writes once with its initial revision", async () => {
	const h = setup();
	expect(
		screen.getByRole("dialog").parentElement?.parentElement?.className,
	).toBe("pipeline-handoff-stage");
	await h.user.selectOptions(screen.getByLabelText("参照元"), "body");
	const body = "  本文\n${inputs.topic}\n ";
	fireEvent.change(screen.getByLabelText("渡す本文"), {
		target: { value: body },
	});
	await h.user.click(screen.getByRole("button", { name: "この本文を選ぶ" }));
	await h.user.selectOptions(screen.getByLabelText("参照元"), "prompt");
	await h.user.selectOptions(
		screen.getByLabelText("どのプロンプトを渡すか"),
		"step:request",
	);
	await h.user.click(
		screen.getByRole("button", { name: "このプロンプトを選ぶ" }),
	);
	await h.user.click(screen.getByRole("button", { name: "反映" }));
	expect(h.onApply).toHaveBeenCalledTimes(1);
	expect(h.onApply.mock.calls[0]?.[1]).toBe(3);
	expect(JSON.parse(h.onApply.mock.calls[0]![0]).steps[1].materials).toEqual([
		{ kind: "text", text: body },
		{ kind: "prompt", stepId: "request" },
	]);
	expect(h.onClose).toHaveBeenCalledOnce();
});

test("image and music use separate artifact screens; cancel keeps draft, final cancel never writes", async () => {
	const h = setup();
	await h.user.click(screen.getByRole("button", { name: /画像を選ぶ/ }));
	expect(screen.queryByRole("dialog")).toBeNull();
	expect(screen.queryByText("端末の画像")).toBeNull();
	await h.user.click(screen.getByRole("button", { name: "風景を選ぶ" }));
	await h.user.click(screen.getByRole("button", { name: "この画像を使う" }));
	expect(screen.getByRole("dialog")).toBeTruthy();
	expect(screen.getByText("画像：風景")).toBeTruthy();
	await h.user.click(screen.getByRole("button", { name: /楽曲を選ぶ/ }));
	h.rerender(
		<PipelineHandoff {...h.props} library={{ ...media, kind: "music" }} />,
	);
	await h.user.click(screen.getByText("BGM"));
	expect(
		screen.getByRole("button", { name: "この楽曲を使う" }),
	).not.toBeDisabled();
	await h.user.click(screen.getByRole("button", { name: "この楽曲を使う" }));
	expect(screen.getByText("画像：風景")).toBeTruthy();
	expect(screen.getByText("楽曲：BGM")).toBeTruthy();
	await h.user.click(screen.getByRole("button", { name: /画像を選ぶ/ }));
	h.rerender(<PipelineHandoff {...h.props} />);
	await h.user.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(screen.getByText("画像：風景")).toBeTruthy();
	await h.user.click(screen.getByRole("button", { name: "キャンセル" }));
	expect(h.onApply).not.toHaveBeenCalled();
	expect(h.onClose).toHaveBeenCalledOnce();
});

test("stale revision refuses to overwrite, failed apply keeps selection", async () => {
	const h = setup();
	h.onApply.mockResolvedValue(false);
	await h.user.selectOptions(screen.getByLabelText("参照元"), "constant");
	fireEvent.change(screen.getByLabelText("固定の値（JSON）"), {
		target: { value: '[0,false,null,""]' },
	});
	await h.user.click(screen.getByRole("button", { name: "この値を選ぶ" }));
	await h.user.click(screen.getByRole("button", { name: "反映" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("反映できません");
	h.rerender(
		<PipelineHandoff {...h.props} work={{ ...handoffWork, revision: 4 }} />,
	);
	expect(screen.getByRole("button", { name: "反映" })).toBeDisabled();
	expect(screen.getByRole("alert")).toHaveTextContent("ほかの更新");
	expect(h.onClose).not.toHaveBeenCalled();
});

test("unknown results can be chosen whole and nested null is an actual runtime reference", async () => {
	const h = setup();
	await h.user.selectOptions(screen.getByLabelText("参照元"), "steps");
	await h.user.click(screen.getByRole("button", { name: /項目を選ぶ/ }));
	await h.user.click(
		screen.getByRole("button", { name: "調べる ／ output ／ nil" }),
	);
	await h.user.click(screen.getByRole("button", { name: "この項目を使う" }));
	await h.user.click(screen.getByRole("button", { name: "反映" }));
	expect(JSON.parse(h.onApply.mock.calls[0]![0]).steps[1].materials).toEqual([
		{ kind: "reference", reference: "steps.first.output.nil" },
	]);
});

test("library errors and loading preserve return navigation", async () => {
	const h = setup({ ...media, loading: true });
	await h.user.click(screen.getByRole("button", { name: /画像を選ぶ/ }));
	expect(screen.getByText("画像を読み込んでいます。")).toBeTruthy();
	h.rerender(
		<PipelineHandoff
			{...h.props}
			library={{ ...media, loading: false, error: "接続失敗" }}
		/>,
	);
	expect(screen.getByRole("alert")).toHaveTextContent("接続失敗");
	await h.user.click(screen.getByRole("button", { name: "一覧を更新" }));
	expect(h.onLibrary).toHaveBeenLastCalledWith("image");
	await h.user.click(screen.getByRole("button", { name: "戻る" }));
	expect(screen.getByRole("dialog")).toBeTruthy();
});

test("unselected body and fixed input block apply instead of being silently dropped", async () => {
	const h = setup();
	await h.user.selectOptions(screen.getByLabelText("参照元"), "body");
	fireEvent.change(screen.getByLabelText("渡す本文"), {
		target: { value: "未追加の本文" },
	});
	expect(screen.getByRole("button", { name: "反映" })).toBeDisabled();
	await h.user.selectOptions(screen.getByLabelText("参照元"), "saved");
	expect(screen.getByRole("button", { name: "反映" })).toBeDisabled();
	expect(h.onApply).not.toHaveBeenCalled();
	await h.user.selectOptions(screen.getByLabelText("参照元"), "body");
	await h.user.click(screen.getByRole("button", { name: "この本文を選ぶ" }));
	await h.user.selectOptions(screen.getByLabelText("参照元"), "constant");
	fireEvent.change(screen.getByLabelText("固定の値（JSON）"), {
		target: { value: "[false,null]" },
	});
	expect(screen.getByRole("button", { name: "反映" })).toBeDisabled();
	await h.user.click(screen.getByRole("button", { name: "この値を選ぶ" }));
	await h.user.click(screen.getByRole("button", { name: "反映" }));
	expect(JSON.parse(h.onApply.mock.calls[0]![0]).steps[1].materials).toEqual([
		{ kind: "text", text: "未追加の本文" },
		{ kind: "value", value: [false, null] },
	]);
});

test("the submitted draft cannot be edited while apply is pending", async () => {
	const h = setup();
	let resolve!: (ok: boolean) => void;
	h.onApply.mockImplementation(
		() =>
			new Promise<boolean>((r) => {
				resolve = r;
			}),
	);
	await h.user.selectOptions(screen.getByLabelText("参照元"), "prompt");
	await h.user.click(
		screen.getByRole("button", { name: "このプロンプトを選ぶ" }),
	);
	await h.user.click(screen.getByRole("button", { name: "反映" }));
	expect(screen.getByLabelText("参照元")).toBeDisabled();
	expect(
		screen.getByRole("button", { name: "このプロンプトを選ぶ" }),
	).toBeDisabled();
	expect(screen.getByRole("button", { name: /を外す/ })).toBeDisabled();
	resolve(false);
	expect(await screen.findByRole("alert")).toHaveTextContent("反映できません");
	expect(screen.getByLabelText("参照元")).not.toBeDisabled();
});

test("overflowed JSON numbers are rejected rather than silently serialized as null", async () => {
	const h = setup();
	await h.user.selectOptions(screen.getByLabelText("参照元"), "constant");
	for (const value of ["1e400", '{"nested":[-1e400]}']) {
		fireEvent.change(screen.getByLabelText("固定の値（JSON）"), {
			target: { value },
		});
		await h.user.click(screen.getByRole("button", { name: "この値を選ぶ" }));
		expect(screen.getByRole("alert")).toHaveTextContent("JSON");
		expect(screen.queryByText(/固定の値：/)).toBeNull();
	}
	expect(h.onApply).not.toHaveBeenCalled();
});

test("opening without changes does not send a no_change write", () => {
	setup();
	expect(screen.getByRole("button", { name: "反映" })).toBeDisabled();
});

test("result picker exposes all six supported output keys, without an unsupported seventh", async () => {
	const definition = JSON.parse(handoffWork.source);
	definition.tests[0].stepResults.first.output = {
		a: { b: { c: { d: { e: { f: { g: 1 } } } } } },
	};
	const h = setup(media, {
		...handoffWork,
		source: JSON.stringify(definition),
	});
	await h.user.selectOptions(screen.getByLabelText("参照元"), "steps");
	await h.user.click(screen.getByRole("button", { name: /項目を選ぶ/ }));
	expect(
		screen.queryByRole("button", {
			name: "調べる ／ output ／ a ／ b ／ c ／ d ／ e ／ f ／ g",
		}),
	).toBeNull();
	await h.user.click(
		screen.getByRole("button", {
			name: "調べる ／ output ／ a ／ b ／ c ／ d ／ e ／ f",
		}),
	);
	await h.user.click(screen.getByRole("button", { name: "この項目を使う" }));
	await h.user.click(screen.getByRole("button", { name: "反映" }));
	expect(JSON.parse(h.onApply.mock.calls[0]![0]).steps[1].materials).toEqual([
		{ kind: "reference", reference: "steps.first.output.a.b.c.d.e.f" },
	]);
});
