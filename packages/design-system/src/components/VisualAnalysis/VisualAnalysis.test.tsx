import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VisualAnalysis } from "./VisualAnalysis";
import type { VisualAnalysisRecord } from "./types";
afterEach(cleanup);
const record: VisualAnalysisRecord = {
	id: "analysis",
	sourceId: "source",
	sourceRevision: 1,
	frameIndex: null,
	createdAt: 1,
	state: "completed",
	options: { task: "segmentation", query: "cup" },
	errorCode: null,
	releaseConfirmed: true,
	waitingMs: 17000,
	inferenceMs: 26000,
	elapsedMs: 43000,
	result: {
		model: "fixture",
		modelRevision: "revision",
		task: "segmentation",
		response: "<script>alert('external')</script>",
		truncated: true,
		image: { width: 800, height: 600 },
		detections: [
			{ label: "cup", box: [20, 30, 100, 200] },
			{ label: "cup", box: [500, 30, 600, 200] },
		],
		masks: [{ detectionIndex: 1, mode: "binary" }],
		timings: { totalMs: 25000 },
		execution: {
			device: "fixture",
			backend: "fixture",
			dtype: "fixture",
			decoderDtype: "fixture",
			outputTokens: 20,
			visualTokens: 100,
		},
	},
};
describe("explicit visual analysis", () => {
	it("explains the CPU decoder absence without changing the mask decoder display", () => {
		const cpu = {
			...record,
			result: {
				...record.result!,
				task: "describe" as const,
				detections: [],
				masks: [],
				execution: {
					device: "cpu",
					backend: "llama.cpp",
					dtype: "qad-q4_0",
					decoderDtype: null,
					visualTokens: 10,
					inputTokens: 20,
					outputTokens: 0,
				},
			},
		};
		const { rerender } = render(
			<VisualAnalysis analysisAvailable analysisOpen analysis={cpu} />,
		);
		expect(screen.getByText(/decoder非搭載/)).toBeInTheDocument();
		rerender(
			<VisualAnalysis
				analysisAvailable
				analysisOpen
				analysis={{
					...record,
					result: {
						...record.result!,
						execution: { ...record.result!.execution, decoderDtype: "float32" },
					},
				}}
			/>,
		);
		expect(screen.queryByText(/decoder非搭載/)).not.toBeInTheDocument();
		expect(screen.getByText(/float32/)).toBeInTheDocument();
	});
	it("shows a provider contract failure instead of leaving the analysis running", () => {
		render(
			<VisualAnalysis
				analysisAvailable
				analysisOpen
				analysis={{
					...record,
					state: "failed",
					result: null,
					errorCode: "invalid_visual_response",
				}}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("失敗");
		expect(screen.getByRole("alert")).toHaveTextContent(
			"解析サービスの応答形式が正しくありません。LARM側の対応状況を確認してください。",
		);
		expect(screen.getByRole("button", { name: "分析する" })).toBeEnabled();
	});
	it("opens only on the button and sends the chosen task and unmodified query", () => {
		const open = vi.fn(),
			run = vi.fn();
		render(
			<VisualAnalysis
				analysisAvailable
				analysisOpen
				onAnalysisOpen={open}
				onAnalysisRun={run}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: /^詳細分析$/ }));
		expect(open).toHaveBeenCalledTimes(1);
		fireEvent.change(screen.getByLabelText("分析の用途"), {
			target: { value: "referring" },
		});
		fireEvent.change(screen.getByLabelText("調べたい内容"), {
			target: { value: "飲み物をこぼして倒れているカップ" },
		});
		fireEvent.click(screen.getByRole("button", { name: "分析する" }));
		expect(run).toHaveBeenCalledWith({
			task: "referring",
			query: "飲み物をこぼして倒れているカップ",
		});
	});
	it("renders raw text safely, scales boxes with the image and binds masks by detection index", () => {
		const { container } = render(
			<VisualAnalysis
				analysisAvailable
				analysisOpen
				analysis={record}
				analysisImageUrl="blob:normalized"
				analysisMaskUrls={["blob:mask"]}
			/>,
		);
		expect(container.querySelector("script")).toBeNull();
		expect(screen.getByText(record.result!.response)).toBeVisible();
		expect(screen.getByRole("alert")).toHaveTextContent("結果は途中まで");
		const svg = screen.getByRole("img");
		expect(svg).toHaveAttribute("viewBox", "0 0 800 600");
		expect(svg.querySelectorAll("rect[mask]")).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "1. cup" }));
		expect(svg.querySelectorAll("rect[mask]")).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "2. cup" }));
		expect(svg.querySelectorAll("rect[mask]")).toHaveLength(1);
		fireEvent.click(screen.getByLabelText("マスクを重ねる"));
		expect(svg.querySelectorAll("rect[mask]")).toHaveLength(0);
		expect(screen.getByText(/起動待ち 17000 ms/)).toBeVisible();
		expect(container.textContent).not.toContain("confidence");
	});
	it("distinguishes startup, inference, and cancellation and blocks repeated inference", () => {
		const cancel = vi.fn();
		const { rerender } = render(
			<VisualAnalysis
				analysisOpen
				analysisAvailable
				analysis={{ ...record, result: null, state: "starting" }}
				onAnalysisCancel={cancel}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("起動中");
		expect(screen.getByRole("button", { name: "分析する" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: /^中止$/ }));
		expect(cancel).toHaveBeenCalledOnce();
		rerender(
			<VisualAnalysis
				analysisOpen
				analysisAvailable
				analysis={{ ...record, result: null, state: "running" }}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("解析中");
		rerender(
			<VisualAnalysis
				analysisOpen
				analysisAvailable
				analysis={{
					...record,
					result: null,
					state: "cancelled",
					releaseConfirmed: null,
				}}
			/>,
		);
		expect(screen.getByRole("status")).toHaveTextContent("中止処理中");
	});
});

it.each([
	["observing", "停止状態を確認中"],
	["cold", "停止確認（LARMの稼働状態: COLD）"],
	["unconfirmed", "停止未確認"],
] as const)(
	"renders %s independently from connection release and allows the next analysis",
	(status, text) => {
		render(
			<VisualAnalysis
				analysisOpen
				analysisAvailable
				analysis={{
					...record,
					state: "cancelled",
					result: null,
					stopObservation: { status },
				}}
			/>,
		);
		expect(
			screen.getByText(new RegExp(text.replace(/[（）]/g, "[（）]"))),
		).toBeVisible();
		expect(screen.getByRole("button", { name: "分析する" })).toBeEnabled();
		expect(screen.queryByRole("alert")).toBeNull();
	},
);
