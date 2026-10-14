import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { Recipe, Selection } from "./records-presentation";
import { createSettingsBackend, newCache, Screens } from "./settings.fixture";

afterEach(cleanup);

test("records open from the registered screen; existing APIs update recipes without applying settings", async () => {
	const backend = createSettingsBackend();
	backend.records.recipes = [
		{
			id: "r",
			signature: "取得手順",
			url: "javascript:alert(1)",
			readHint: "本文",
			state: "active",
			successes: 2,
			failures: 0,
			lastSuccessAt: null,
		} as unknown as Recipe,
	];
	backend.records.selections = {
		items: [
			{
				id: "s",
				conversationId: "fixture",
				utteranceId: null,
				requestId: null,
				toolchainId: "web.search",
				toolchainRevisionId: "toolchain:web.search@1",
				repaired: false,
				durationMs: 1,
				settledAt: 2,
				functionName: "fixture_search",
				decision: "toolchain",
				createdAt: 1,
				outcome: "answered",
				request: "固定依頼",
				retrieval: "none",
				candidates: [],
				historyRefs: [],
				recipe: null,
				runId: "run",
				taskId: null,
				outcomeCode: null,
			} as Selection,
		],
		total: 1,
		pageIndex: 0,
		pageSize: 10,
	};
	render(
		<Screens backend={backend} start="records" cache={newCache(backend)} />,
	);
	await screen.findByRole("tab", { name: "AIの利用" });
	expect(
		screen.queryByRole("button", { name: /設定の変更をすべて保存/ }),
	).toBeNull();
	// Searching reads the source again with the table's query as params: no action, no ledger.
	const search = screen.getAllByLabelText(/を検索$/)[0]!;
	fireEvent.change(search, { target: { value: "model" } });
	fireEvent.submit(search.closest("form")!);
	await waitFor(() =>
		expect(backend.records.reads).toContainEqual({
			source: "settings-records",
			params: {
				pageIndex: 0,
				pageSize: 10,
				q: "model",
				sort: "started",
				desc: true,
			},
		}),
	);
	expect(backend.client.submitToolchainAction).not.toHaveBeenCalled();
	fireEvent.mouseDown(screen.getByRole("tab", { name: "ツールチェーン" }), {
		button: 0,
		ctrlKey: false,
	});
	await screen.findByText("fixture_search");
	fireEvent.click(screen.getByText("保存済みの取得手順"));
	expect(screen.queryByRole("link")).toBeNull();
	const actions = () =>
		backend.client.submitToolchainAction.mock.calls.map(
			(call) => (call[0] as { actionId: string }).actionId,
		);
	fireEvent.click(screen.getByRole("button", { name: "無効にする" }));
	await waitFor(() => expect(actions()).toContain("records-procedure-state"));
	expect(
		backend.client.submitToolchainAction.mock.calls.at(-1)![0].input,
	).toEqual({ id: "r", enabled: false });
	// The receipt makes the screen read the procedures source again.
	await screen.findByRole("button", { name: "有効にする" });
	fireEvent.click(screen.getByRole("button", { name: "有効にする" }));
	await screen.findByRole("button", { name: "無効にする" });
	fireEvent.click(screen.getByRole("button", { name: "削除" }));
	expect(actions()).not.toContain("records-procedure-delete");
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	await screen.findByText("保存済みの取得手順はありません。");
	expect(actions()).toContain("records-procedure-delete");
	// Nothing went through the settings apply or the legacy records APIs.
	expect(backend.sent).toHaveLength(0);
});
