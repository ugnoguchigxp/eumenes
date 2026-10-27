import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createClient } from "../../../client";
import type { AnalysisRecord } from "../../../api/domains/larm/contracts";
import { useVisualAnalysis } from "./use-visual-analysis";
afterEach(cleanup);
const source = {
	id: "source",
	revision: 3,
	mime: "image/png",
	state: "completed",
	result: { kind: "image" },
};
const record: AnalysisRecord = {
	id: "analysis",
	sourceId: "source",
	sourceRevision: 3,
	frameIndex: null,
	timestamp: null,
	actualTimestamp: null,
	sourceDigest: "digest",
	settingsVersion: "version",
	options: { task: "describe", query: "説明" },
	state: "queued",
	result: null,
	errorCode: null,
	releaseConfirmed: null,
	waitingMs: null,
	inferenceMs: null,
	elapsedMs: null,
	createdAt: 1,
	updatedAt: 1,
};
function fixture(records: AnalysisRecord[] = []) {
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const client = {
		...createClient("http://127.0.0.1:1"),
		analysesList: vi.fn(async () => records),
		analysisCreate: vi.fn(async () => record),
		analysisGet: vi.fn(async () => record),
		analysisCancel: vi.fn(async () => record),
	};
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	return { client, wrapper };
}
it("does not infer on render, and one explicit open creates the default description once", async () => {
	const h = fixture();
	const { result } = renderHook(
		() => useVisualAnalysis(h.client, "ocr", "main", source, 0),
		{ wrapper: h.wrapper },
	);
	await waitFor(() => expect(h.client.analysesList).toHaveBeenCalled());
	expect(h.client.analysisCreate).not.toHaveBeenCalled();
	await act(async () => {
		await result.current.dispatch({
			id: crypto.randomUUID(),
			source: "ocr",
			revision: 0,
			action: "analysis-open",
			values: { id: source.id, scope: result.current.resource.analysisScope },
		});
	});
	expect(h.client.analysisCreate).toHaveBeenCalledTimes(1);
	expect(h.client.analysisCreate.mock.calls[0]).toEqual([
		"ocr",
		"source",
		expect.objectContaining({
			expectedRevision: 3,
			task: "describe",
			query: "この画像で何が起きているか説明してください。",
		}),
	]);
	expect(result.current.resource.analysisOpen).toBe(true);
});
it("opening existing analysis reuses its receipt and rejects stale source events", async () => {
	const h = fixture([record]);
	const { result } = renderHook(
		() => useVisualAnalysis(h.client, "object-recognition", "main", source, 0),
		{ wrapper: h.wrapper },
	);
	await waitFor(() =>
		expect(result.current.resource.analysis?.id).toBe("analysis"),
	);
	await act(async () => {
		await result.current.dispatch({
			id: crypto.randomUUID(),
			source: "object-recognition",
			revision: 0,
			action: "analysis-open",
			values: { id: source.id, scope: result.current.resource.analysisScope },
		});
	});
	expect(h.client.analysisCreate).not.toHaveBeenCalled();
	let receipt;
	await act(async () => {
		receipt = await result.current.dispatch({
			id: crypto.randomUUID(),
			source: "object-recognition",
			revision: 0,
			action: "analysis-run",
			values: {
				id: source.id,
				scope: "source:2:-1",
				options: JSON.stringify({ task: "describe", query: "new" }),
			},
		});
	});
	expect(receipt).toMatchObject({ status: "rejected" });
	expect(h.client.analysisCreate).not.toHaveBeenCalled();
});
it("reconciles a lost create response by receipt without repeating the POST", async () => {
	const h = fixture();
	h.client.analysisCreate.mockRejectedValueOnce(new TypeError("network"));
	const { result } = renderHook(
		() => useVisualAnalysis(h.client, "ocr", "main", source, 0),
		{ wrapper: h.wrapper },
	);
	await waitFor(() => expect(h.client.analysesList).toHaveBeenCalled());
	await act(async () => {
		await result.current.dispatch({
			id: crypto.randomUUID(),
			source: "ocr",
			revision: 0,
			action: "analysis-open",
			values: { id: source.id, scope: result.current.resource.analysisScope },
		});
	});
	expect(h.client.analysisCreate).toHaveBeenCalledTimes(1);
	expect(h.client.analysisGet).toHaveBeenCalledTimes(1);
});
