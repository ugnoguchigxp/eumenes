import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PipelineFlow } from "./PipelineFlow";
import type { PipelineFlowData } from "./types";

const flow: PipelineFlowData = {
	inputs: [{ name: "city", type: "string", required: true }],
	steps: [
		{
			id: "search",
			kind: "toolchain",
			title: "天気を調べる",
			toolchain: "web.search",
			reads: [],
			inputs: ["city"],
		},
		{
			id: "pick",
			kind: "extract",
			title: "気温を取り出す",
			toolchain: null,
			reads: ["search", "later"],
			inputs: ["missing"],
		},
	],
	answer: { inputs: [], reads: ["pick"] },
};

describe("PipelineFlow", () => {
	it("steps appear in order with their toolchain and what they read", () => {
		render(<PipelineFlow flow={flow} />);
		const nodes = within(
			screen.getByRole("list", { name: "パイプラインの流れ" }),
		).getAllByRole("listitem", { name: "" });
		expect(nodes.length).toBeGreaterThan(0);
		const steps = document.querySelectorAll('[data-node="step"]');
		expect(steps).toHaveLength(2);
		expect(steps[0]?.textContent).toContain("web.search");
		expect(steps[0]?.textContent).toContain("入力 city");
		expect(steps[1]?.textContent).toContain("手順 search");
		expect(
			document.querySelector('[data-node="answer"]')?.textContent,
		).toContain("手順 pick");
	});

	it("marks reads that name no input or no earlier step", () => {
		render(<PipelineFlow flow={flow} />);
		const unresolved = [
			...document.querySelectorAll('[data-unresolved="true"]'),
		].map((el) => el.textContent?.trim());
		expect(unresolved).toEqual(["入力 missing", "手順 later"]);
	});

	it("attaches findings to their step by pointer and to the answer", () => {
		render(
			<PipelineFlow
				flow={flow}
				issues={[
					{ pointer: "/steps/1/uses", rule: "unknown_step_reference", line: 6 },
					{ pointer: "/answer", rule: "unknown_value", line: 9 },
					{ pointer: "/id", rule: "invalid_id", line: 2 },
				]}
			/>,
		);
		const steps = document.querySelectorAll('[data-node="step"]');
		expect(steps[0]?.getAttribute("data-invalid")).toBeNull();
		expect(steps[1]?.getAttribute("data-invalid")).toBe("true");
		expect(steps[1]?.textContent).toContain("unknown_step_reference");
		expect(
			document.querySelector('[data-node="answer"]')?.textContent,
		).toContain("unknown_value");
		expect(screen.queryByText("invalid_id")).toBeNull();
	});

	it("says so when there is no flow", () => {
		render(<PipelineFlow flow={null} />);
		expect(
			screen.getByText(/流れを表示できる定義がまだありません/),
		).toBeTruthy();
	});
});
