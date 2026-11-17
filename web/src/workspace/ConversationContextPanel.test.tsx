import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type {
	ContextCapture,
	RunContext,
} from "../../../api/domains/dialogue/contracts";
import type { EumenesClient } from "../../../client";
import {
	ConversationContextPanel,
	type ContextSelection,
} from "./ConversationContextPanel";

afterEach(cleanup);

function captured(
	runId: string,
	number: number,
	input: ContextCapture["input"]["messages"],
): ContextCapture {
	const at = Date.now() - 500;
	return {
		summary: {
			runId,
			id: `${runId}-${number}`,
			number,
			at,
			expiresAt: at + 30_000,
			boundary: "larm",
			inferenceId: runId,
			attemptId: `${number}`,
			status: "running",
			accepted: false,
			available: true,
		},
		input: { boundary: "larm", messages: input },
		cut: null,
		previous: null,
	};
}

test("a change notice loads the next capture, tool changes are visible, and an older selection stays pinned", async () => {
	const correction = {
		role: "user",
		content: "通勤したのは昨日です。",
		origins: [],
	};
	const first = captured("first", 1, [correction]);
	first.input.maxOutputTokens = 4096;
	const afterTool = captured("first", 2, [
		correction,
		{ role: "tool", content: "固定のツール結果", origins: [] },
	]);
	afterTool.previous = first.summary;
	afterTool.input.maxOutputTokens = 3072;
	const latest = captured("next", 1, [
		{ role: "user", content: "次の発言", origins: [] },
	]);
	const records = new Map([
		["first", [first]],
		["next", [latest]],
	]);
	const detail = vi.fn(async (runId: string, id: string) =>
		records.get(runId)!.find(({ summary }) => summary.id === id)!,
	);
	const client = {
		identity: "context-fixture",
		async runContext(runId: string): Promise<RunContext> {
			const captures = records.get(runId)!.map(({ summary }) => summary);
			return {
				runId,
				conversationId: "main",
				status: "running",
				empty: "preparing",
				captures,
				preferredId: captures.at(-1)?.id ?? null,
			};
		},
		contextCapture: detail,
	} as unknown as EumenesClient;
	const cache = new QueryClient();
	function Panel({
		runId,
		disconnected,
	}: {
		runId: string;
		disconnected: boolean;
	}) {
		const [selection, setSelection] = useState<ContextSelection>({
			mode: "latest",
		});
		return (
			<ConversationContextPanel
				client={client}
				selection={selection}
				latestRunId={runId}
				disconnected={disconnected}
				onSelect={setSelection}
				onClose={() => {}}
			/>
		);
	}
	const tree = (runId: string, disconnected = false) => (
		<QueryClientProvider client={cache}>
			<Panel runId={runId} disconnected={disconnected} />
		</QueryClientProvider>
	);
	const displayed = render(tree("first"));
	try {
		expect(await screen.findByText(correction.content)).toBeTruthy();
		records.set("first", [first, afterTool]);
		await act(async () => {
			await cache.invalidateQueries({ queryKey: ["dialogue"] });
		});
		expect(await screen.findByText("固定のツール結果")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "前の入力との差分" }));
		expect(await screen.findByText("追加 · 0 → 1件")).toBeTruthy();
		expect(screen.getByText("出力上限の変更")).toBeTruthy();
		expect(screen.queryByRole("region", { name: "送信時点の入力" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "入力", exact: true }));
		expect(screen.getByRole("region", { name: "送信時点の入力" })).toBeTruthy();
		expect(screen.queryByRole("region", { name: "入力の差分" })).toBeNull();
		fireEvent.change(screen.getByRole("combobox", { name: "送信した入力" }), {
			target: { value: first.summary.id },
		});
		displayed.rerender(tree("next"));
		await screen.findByText("この返答に固定中");
		expect(screen.queryByText("次の発言")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "最新を追う" }));
		expect(await screen.findByText("次の発言")).toBeTruthy();
		records.set("next", []);
		await act(async () => {
			await cache.invalidateQueries({ queryKey: ["dialogue"] });
		});
		await waitFor(() => expect(screen.queryByText("次の発言")).toBeNull());
		records.set("next", [latest]);
		await act(async () => {
			await cache.invalidateQueries({ queryKey: ["dialogue"] });
		});
		expect(await screen.findByText("次の発言")).toBeTruthy();
		displayed.rerender(tree("next", true));
		expect(screen.queryByText("次の発言")).toBeNull();
		records.set("next", []);
		displayed.rerender(tree("next"));
		expect(screen.queryByText("次の発言")).toBeNull();
		expect(await screen.findByText("入力を準備中")).toBeTruthy();
	} finally {
		displayed.unmount();
		cache.clear();
	}
});
