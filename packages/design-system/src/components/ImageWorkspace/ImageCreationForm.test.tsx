import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { defaultImageCreationOptions } from "./image-creation-options";
import { ImageCreationForm } from "./ImageCreationForm";
afterEach(cleanup);
const defaults = {
	prompt: "",
	width: 121,
	height: 177,
	format: "png" as const,
	seed: 42,
};
const prompt = () =>
	screen.getByRole("textbox", {
		name: "画像作成プロンプト",
	}) as HTMLTextAreaElement;
it("explicit choices build the editable prompt and pass arbitrary integer dimensions unchanged", () => {
	const generate = vi.fn();
	render(<ImageCreationForm initialValues={defaults} onGenerate={generate} />);
	expect(screen.getByRole("button", { name: "画像を生成" })).toHaveProperty(
		"disabled",
		true,
	);
	fireEvent.change(screen.getByLabelText("テーマ・描きたいもの"), {
		target: { value: "駅で踊るタコ" },
	});
	fireEvent.click(screen.getByLabelText("水彩", { selector: "input" }));
	fireEvent.click(screen.getByLabelText("温かい", { selector: "input" }));
	fireEvent.change(screen.getByLabelText("構図"), {
		target: { value: "広めの画角" },
	});
	expect(prompt().value).toBe(
		"テーマ：駅で踊るタコ\n画風：水彩\n雰囲気：温かい\n構図：広めの画角",
	);
	fireEvent.click(screen.getByRole("button", { name: "画像を生成" }));
	expect(generate).toHaveBeenCalledWith({
		...defaults,
		prompt: prompt().value,
	});
});
it("manual prose survives choice changes until the user reflects or keeps edits; reflection is undoable", () => {
	render(<ImageCreationForm initialValues={defaults} onGenerate={vi.fn()} />);
	fireEvent.change(prompt(), { target: { value: "手書きの希望を残す" } });
	fireEvent.click(screen.getByLabelText("水彩", { selector: "input" }));
	expect(prompt().value).toBe("手書きの希望を残す");
	expect(screen.getByRole("button", { name: "画像を生成" })).toHaveProperty(
		"disabled",
		true,
	);
	fireEvent.click(screen.getByRole("button", { name: "編集内容を使う" }));
	expect(prompt().value).toBe("手書きの希望を残す");
	fireEvent.click(screen.getByRole("button", { name: "選択内容を反映" }));
	expect(prompt().value).toBe("画風：水彩");
	fireEvent.click(screen.getByRole("button", { name: "編集内容に戻す" }));
	expect(prompt().value).toBe("手書きの希望を残す");
});
it("filters displayed style choices without losing hidden selections and resets with undo", () => {
	render(<ImageCreationForm initialValues={defaults} onGenerate={vi.fn()} />);
	fireEvent.click(screen.getByLabelText("水彩", { selector: "input" }));
	fireEvent.change(screen.getByRole("textbox", { name: "画風を探す" }), {
		target: { value: "写真" },
	});
	expect(prompt().value).toBe("画風：水彩");
	expect(screen.queryByLabelText("水彩", { selector: "input" })).toBeNull();
	expect(screen.getByRole("button", { name: "水彩を解除" })).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "リセット" }));
	expect(prompt().value).toBe("");
	expect(screen.getByLabelText("幅（px）")).toHaveProperty("value", "512");
	expect(screen.getByLabelText("シード")).toHaveProperty("value", "0");
	fireEvent.click(screen.getByRole("button", { name: "編集内容に戻す" }));
	expect(prompt().value).toBe("画風：水彩");
});
it("resource updates retain manual draft and all editable API settings", () => {
	const generate = vi.fn();
	const rendered = render(
		<ImageCreationForm initialValues={defaults} onGenerate={generate} />,
	);
	fireEvent.change(prompt(), { target: { value: "変更した文章" } });
	fireEvent.change(screen.getByLabelText("幅（px）"), {
		target: { value: "777" },
	});
	rendered.rerender(
		<ImageCreationForm
			initialValues={{ ...defaults, prompt: "別の完了結果", width: 512 }}
			onGenerate={generate}
		/>,
	);
	expect(prompt().value).toBe("変更した文章");
	fireEvent.click(screen.getByRole("button", { name: "画像を生成" }));
	expect(generate).toHaveBeenCalledWith({
		...defaults,
		width: 777,
		prompt: "変更した文章",
	});
});
it("busy generation blocks choices and submission", () => {
	render(
		<ImageCreationForm
			initialValues={{ ...defaults, prompt: "森" }}
			busy
			onGenerate={vi.fn()}
		/>,
	);
	expect(screen.getByRole("button", { name: "生成処理中" })).toHaveProperty(
		"disabled",
		true,
	);
	expect(
		screen.getByLabelText("水彩", { selector: "input" }).closest("fieldset"),
	).toHaveProperty("disabled", true);
});
it("uses registered choices and reset defaults without changing the form layout", () => {
	render(
		<ImageCreationForm
			initialValues={defaults}
			creationOptions={{
				styleGroups: [{ label: "版画", options: ["木版画"] }],
				moods: ["静か"],
				compositions: ["指定なし", "左右対称"],
				lighting: ["指定なし", "月明かり"],
				defaults: { width: 640, height: 480, format: "webp", seed: 7 },
			}}
			onGenerate={vi.fn()}
		/>,
	);
	expect(screen.queryByLabelText("水彩", { selector: "input" })).toBeNull();
	fireEvent.click(screen.getByLabelText("木版画", { selector: "input" }));
	expect(prompt().value).toBe("画風：木版画");
	fireEvent.change(screen.getByLabelText("構図"), {
		target: { value: "左右対称" },
	});
	expect(prompt().value).toBe("画風：木版画\n構図：左右対称");
	fireEvent.click(screen.getByRole("button", { name: "リセット" }));
	expect(screen.getByLabelText("幅（px）")).toHaveProperty("value", "640");
	expect(screen.getByLabelText("保存形式")).toHaveProperty("value", "webp");
	expect(screen.getByLabelText("シード")).toHaveProperty("value", "7");
});

it("registered model choices preserve the prompt, show preparation status, and reset to the default", () => {
	const generate = vi.fn();
	const creationOptions = {
		...defaultImageCreationOptions,
		models: [
			{ value: "default-image", label: "既定モデル" },
			{
				value: "next-image",
				label: "追加モデル（準備中）",
				description: "準備中です。配置と実生成は未確認です。",
			},
		],
		defaults: {
			...defaultImageCreationOptions.defaults,
			model: "default-image",
		},
	};
	const view = render(
		<ImageCreationForm
			initialValues={{ ...defaults, prompt: "手書きの指示" }}
			creationOptions={creationOptions}
			onGenerate={generate}
		/>,
	);
	expect(screen.getByLabelText("推論モデル")).toHaveProperty(
		"value",
		"default-image",
	);
	fireEvent.change(screen.getByLabelText("推論モデル"), {
		target: { value: "next-image" },
	});
	expect(
		screen.getByText("準備中です。配置と実生成は未確認です。"),
	).toBeTruthy();
	expect(prompt().value).toBe("手書きの指示");
	fireEvent.click(screen.getByRole("button", { name: "画像を生成" }));
	expect(generate).toHaveBeenCalledWith({
		...defaults,
		prompt: "手書きの指示",
		model: "next-image",
	});
	view.rerender(
		<ImageCreationForm
			initialValues={defaults}
			creationOptions={creationOptions}
			onGenerate={generate}
			busy
		/>,
	);
	expect(screen.getByLabelText("推論モデル")).toHaveProperty("disabled", true);
	view.rerender(
		<ImageCreationForm
			initialValues={defaults}
			creationOptions={creationOptions}
			onGenerate={generate}
		/>,
	);
	fireEvent.click(screen.getByRole("button", { name: "リセット" }));
	expect(screen.getByLabelText("推論モデル")).toHaveProperty(
		"value",
		"default-image",
	);
});
