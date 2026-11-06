import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import bundle from "../../../api/domains/capabilities/bundles/pursuit-research.bundle.json";
import { artifactDefinitionV1 } from "../../../api/domains/capabilities/contracts";
import { createClient } from "../../../client";
import { toolchainWebAdapters } from "./toolchain-adapters";
import { ToolchainArtifactHost } from "../domains/toolchain-artifacts/ToolchainArtifactHost";

afterEach(cleanup);
const artifact = artifactDefinitionV1.parse(bundle.artifacts[0]);

function setup(read: (target: string | undefined) => unknown) {
	const client = {
		...createClient("http://127.0.0.1:4444"),
		toolchainArtifact: vi.fn(async () => ({
			artifact,
			artifactRevisionId: "artifact:pursuit.report@1",
			digest: "fixture",
			scopeRef: "scope:fixture",
		})),
		toolchainArtifacts: vi.fn(async () => []),
		unsettledToolchainActions: vi.fn(async () => []),
		toolchainArtifactSource: vi.fn(
			async (_artifact: string, _source: string, target?: string) => ({
				revision: 1,
				data: read(target),
			}),
		),
	};
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	return {
		client,
		tree: (targetRef?: string, visible = true) => (
			<QueryClientProvider client={cache}>
				<ToolchainArtifactHost
					client={client}
					adapters={toolchainWebAdapters}
					artifactRevisionId="artifact:pursuit.report@1"
					artifactId="pursuit-report"
					conversationId="main"
					targetRef={targetRef}
					visible={visible}
				/>
			</QueryClientProvider>
		),
	};
}

test("the registered report renderer reads full text, escapes HTML and changes the requested target", async () => {
	const answer = "本文の結論です。".repeat(80) + "<script>alert(1)</script>";
	const h = setup((targetRef) => ({
		kind: "work-result",
		revision: 1,
		targetRef,
		work: {
			title: "調査報告",
			status: "完了",
			summary: targetRef === "report-a" ? answer : "別の報告です。",
			sections: [
				{ title: "出典", items: ["公式資料\nhttps://example.com/source"] },
			],
		},
	}));
	expect(toolchainWebAdapters.get("adapter:pursuit@1")?.adapterRef).toBe(
		"adapter:pursuit@1",
	);
	const view = render(h.tree("report-a"));
	await screen.findByText(answer);
	expect(document.querySelector("script")).toBeNull();
	fireEvent.click(screen.getByRole("tab", { name: "成果" }));
	expect(screen.getByText(/https:\/\/example.com\/source/)).toBeTruthy();
	expect(screen.queryByText("実作業Sessionの開始は未確認です。")).toBeNull();
	view.rerender(h.tree("report-b"));
	await screen.findByText("別の報告です。");
	expect(screen.queryByText(answer)).toBeNull();
	expect(h.client.toolchainArtifactSource.mock.calls.map((c) => c[2])).toEqual([
		"report-a",
		"report-b",
	]);
});

test("the launcher displays an empty report, and a hidden screen does not read its source", async () => {
	const h = setup(() => ({
		kind: "work-result",
		revision: 0,
		work: {
			title: "調査報告",
			status: "未作成",
			summary: "調査の完了後に結果を表示します。",
		},
	}));
	const view = render(h.tree(undefined, false));
	expect(h.client.toolchainArtifactSource).not.toHaveBeenCalled();
	view.rerender(h.tree());
	await screen.findByText("調査の完了後に結果を表示します。");
	expect(screen.getByText("未作成")).toBeTruthy();
});

test.each(["unavailable", "malformed"])(
	"a %s report is blocked without presenting a different result",
	async (failure) => {
		const h = setup(() => {
			if (failure === "unavailable") throw new Error("item_not_found");
			return {
				kind: "work-result",
				revision: 1,
				work: { summary: "Invalid report" },
			};
		});
		render(h.tree("forgotten"));
		await screen.findByText("調査報告を読み込めません。");
		expect(h.client.toolchainArtifactSource).toHaveBeenCalledTimes(1);
	},
);
