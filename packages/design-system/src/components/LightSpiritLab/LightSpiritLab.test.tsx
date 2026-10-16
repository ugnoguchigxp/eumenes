import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LightSpiritLab, type LightSpiritLabProps } from "./LightSpiritLab";

const props = (
	overrides: Partial<LightSpiritLabProps> = {},
): LightSpiritLabProps => ({
	motions: [
		{
			id: "joyful",
			label: "うれしい",
			group: "emotion",
			groupLabel: "感情と仕草",
			variants: [
				{ id: "joyful-spin", label: "跳ねて1回転" },
				{ id: "joyful-bounce", label: "弾む" },
			],
		},
		{
			id: "twirl",
			label: "くるっと回る",
			group: "idle-gesture",
			groupLabel: "待機中の仕草",
			variants: [{ id: "twirl", label: "1回転" }],
		},
	],
	selected: "joyful",
	variant: "",
	playing: false,
	loop: false,
	speed: 1,
	speaking: false,
	layers: { secondary: true, gaze: true, gestures: true },
	skeleton: false,
	status: { state: "ready", motionLabel: "うれしい" },
	onSelect: vi.fn(),
	onVariant: vi.fn(),
	onPlay: vi.fn(),
	onStop: vi.fn(),
	onRestart: vi.fn(),
	onNeutral: vi.fn(),
	onLoop: vi.fn(),
	onSpeed: vi.fn(),
	onSpeaking: vi.fn(),
	onLayer: vi.fn(),
	onSkeleton: vi.fn(),
	...overrides,
});

describe("LightSpiritLab", () => {
	it("groups motions, offers variants of the selected motion and reports choices", () => {
		const p = props();
		render(<LightSpiritLab {...p} />);
		expect(
			screen.getByRole("group", { name: "感情と仕草" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("group", { name: "待機中の仕草" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "くるっと回る" }));
		expect(p.onSelect).toHaveBeenCalledWith("twirl");
		fireEvent.change(screen.getByLabelText("変化版"), {
			target: { value: "joyful-bounce" },
		});
		expect(p.onVariant).toHaveBeenCalledWith("joyful-bounce");
		fireEvent.click(screen.getByRole("button", { name: "再生" }));
		expect(p.onPlay).toHaveBeenCalled();
		fireEvent.click(screen.getByRole("radio", { name: "1.5×" }));
		expect(p.onSpeed).toHaveBeenCalledWith(1.5);
		fireEvent.click(screen.getByRole("switch", { name: "発話を重ねる" }));
		expect(p.onSpeaking).toHaveBeenCalledWith(true);
		fireEvent.click(screen.getByRole("switch", { name: "視線" }));
		expect(p.onLayer).toHaveBeenCalledWith("gaze", false);
	});

	it("hides the variant choice for single-variant motions and shows stop while playing", () => {
		render(<LightSpiritLab {...props({ selected: "twirl", playing: true })} />);
		expect(screen.queryByLabelText("変化版")).toBeNull();
		expect(screen.getByRole("button", { name: "停止" })).toBeEnabled();
	});

	it("explains why nothing can be driven", () => {
		render(
			<LightSpiritLab
				{...props({
					status: {
						state: "unavailable",
						message: "背景を光の妖精にしてください",
					},
				})}
			/>,
		);
		expect(screen.getByText("動かせる精霊がありません")).toBeInTheDocument();
		expect(
			screen.getByText("背景を光の妖精にしてください"),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "再生" })).toBeDisabled();
	});

	it("disables every control until the stage is ready", () => {
		render(<LightSpiritLab {...props({ status: { state: "loading" } })} />);
		expect(screen.getByText("読み込んでいます")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "再生" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "うれしい" })).toBeDisabled();
	});
});
