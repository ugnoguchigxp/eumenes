import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StepGuide, type StepGuideStep } from "./StepGuide";

const steps: StepGuideStep[] = [
	{ title: "基線を測る", body: "AとBの距離を測る。" },
	{ title: "角度を測る", body: "月の方向を測る。" },
	{ title: "距離を求める" },
];

describe("StepGuide", () => {
	it("最初のステップの title と body を表示し、aria-current を付ける", () => {
		render(<StepGuide steps={steps} />);
		expect(
			screen.getByRole("heading", { name: "基線を測る" }),
		).toBeInTheDocument();
		expect(screen.getByText("AとBの距離を測る。")).toBeInTheDocument();
		expect(screen.getByText("1 / 3")).toBeInTheDocument();
		const current = screen.getByRole("button", { name: /ステップ1/ });
		expect(current).toHaveAttribute("aria-current", "step");
		expect(screen.getByRole("button", { name: /ステップ2/ })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("非制御: 次へ・前へで進み、端のボタンは無効になる", async () => {
		const user = userEvent.setup();
		const onStepChange = vi.fn();
		render(<StepGuide steps={steps} onStepChange={onStepChange} />);
		const prev = screen.getByRole("button", { name: "前へ" });
		const next = screen.getByRole("button", { name: "次へ" });
		expect(prev).toBeDisabled();
		await user.click(next);
		expect(screen.getByRole("heading", { name: "角度を測る" })).toBeInTheDocument();
		expect(onStepChange).toHaveBeenLastCalledWith(1);
		await user.click(next);
		expect(next).toBeDisabled();
		expect(screen.queryByText("月の方向を測る。")).not.toBeInTheDocument();
		await user.click(prev);
		expect(screen.getByRole("heading", { name: "角度を測る" })).toBeInTheDocument();
		expect(onStepChange).toHaveBeenCalledTimes(3);
	});

	it("defaultStep から始められる", () => {
		render(<StepGuide steps={steps} defaultStep={2} />);
		expect(screen.getByRole("heading", { name: "距離を求める" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "次へ" })).toBeDisabled();
	});

	it("制御: step を親が持ち、親が更新するまで表示は変わらない", async () => {
		const user = userEvent.setup();
		const onStepChange = vi.fn();
		const { rerender } = render(
			<StepGuide steps={steps} step={0} onStepChange={onStepChange} />,
		);
		await user.click(screen.getByRole("button", { name: "次へ" }));
		expect(onStepChange).toHaveBeenCalledWith(1);
		expect(screen.getByRole("heading", { name: "基線を測る" })).toBeInTheDocument();
		rerender(<StepGuide steps={steps} step={1} onStepChange={onStepChange} />);
		expect(screen.getByRole("heading", { name: "角度を測る" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /ステップ2/ })).toHaveAttribute(
			"aria-current",
			"step",
		);
	});

	it("範囲外・非有限の step は端へ丸める", () => {
		const { rerender } = render(<StepGuide steps={steps} step={99} />);
		expect(screen.getByRole("heading", { name: "距離を求める" })).toBeInTheDocument();
		rerender(<StepGuide steps={steps} step={-3} />);
		expect(screen.getByRole("heading", { name: "基線を測る" })).toBeInTheDocument();
		rerender(<StepGuide steps={steps} step={Number.NaN} />);
		expect(screen.getByRole("heading", { name: "基線を測る" })).toBeInTheDocument();
	});

	it("番号ボタンで任意のステップへ移る", async () => {
		const user = userEvent.setup();
		const onStepChange = vi.fn();
		render(<StepGuide steps={steps} onStepChange={onStepChange} />);
		await user.click(screen.getByRole("button", { name: /ステップ3/ }));
		expect(onStepChange).toHaveBeenCalledWith(2);
		expect(screen.getByRole("heading", { name: "距離を求める" })).toBeInTheDocument();
	});

	it("矢印キーと Home/End で移動し、フォーカスも追従する", async () => {
		const user = userEvent.setup();
		render(<StepGuide steps={steps} />);
		const first = screen.getByRole("button", { name: /ステップ1/ });
		first.focus();
		await user.keyboard("{ArrowRight}");
		expect(screen.getByRole("button", { name: /ステップ2/ })).toHaveFocus();
		expect(screen.getByRole("heading", { name: "角度を測る" })).toBeInTheDocument();
		await user.keyboard("{End}");
		expect(screen.getByRole("button", { name: /ステップ3/ })).toHaveFocus();
		await user.keyboard("{ArrowRight}");
		expect(screen.getByRole("heading", { name: "距離を求める" })).toBeInTheDocument();
		await user.keyboard("{Home}");
		expect(screen.getByRole("button", { name: /ステップ1/ })).toHaveFocus();
		await user.keyboard("{ArrowLeft}");
		expect(screen.getByRole("heading", { name: "基線を測る" })).toBeInTheDocument();
	});

	it("steps が空のときは何も描かない", () => {
		const { container } = render(<StepGuide steps={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("title を見出しとセクション名に使う", () => {
		render(<StepGuide steps={steps} title="三角測量の手順" />);
		expect(screen.getByRole("heading", { name: "三角測量の手順" })).toBeInTheDocument();
		expect(screen.getByRole("region", { name: "三角測量の手順" })).toBeInTheDocument();
	});
});
