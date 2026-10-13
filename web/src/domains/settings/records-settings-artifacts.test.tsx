import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { EumenesClient } from "../../../../client";
import { SettingsDraftProvider } from "./SettingsDraftHost";
import { SettingsArtifact } from "./SettingsArtifact";
import {
	settingsArtifactDefinition,
	isSettingsArtifactDefinition,
} from "./artifact-definition";
import { settingsFixture } from "./sections/fixture";
import type { Recipe, Selection } from "./records-presentation";

afterEach(cleanup);
test("OpenUI composes records with display; existing APIs update recipes without applying settings", async () => {
	let recipes: Recipe[] = [
		{
			id: "r",
			signature: "取得手順",
			url: "javascript:alert(1)",
			readHint: "本文",
			state: "active",
			successes: 2,
			failures: 0,
			lastSuccessAt: null,
		} as Recipe,
	];
	const state = vi.fn(async (_id: string, status: Recipe["state"]) => {
		recipes = recipes.map((r) => ({ ...r, state: status }));
	});
	const remove = vi.fn(async () => {
		recipes = [];
	});
	const apply = vi.fn();
	const client = {
		identity: "records-test",
		settings: async () => settingsFixture(),
		applySettings: apply,
		inferenceUsagePage: async () => ({
			items: [],
			total: 0,
			pageIndex: 0,
			pageSize: 10,
		}),
		settingsDiagnostics: async () => ({ keyError: null, connections: [] }),
		toolchainSelectionsPage: async () => ({
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
		}),
		toolchainRecipesPage: async () => ({
			items: recipes,
			total: recipes.length,
			pageIndex: 0,
			pageSize: 10,
		}),
		setToolchainRecipeState: state,
		deleteToolchainRecipe: remove,
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const definition = JSON.stringify({
		view: "layout",
		children: [
			JSON.parse(settingsArtifactDefinition("records")),
			{ view: "subtitle-preview", source: "settings-display-preview" },
		],
	});
	expect(isSettingsArtifactDefinition(definition)).toBe(true);
	render(
		<QueryClientProvider client={cache}>
			<SettingsDraftProvider client={client}>
				<SettingsArtifact definition={definition} onOpen={() => {}} />
			</SettingsDraftProvider>
		</QueryClientProvider>,
	);
	await screen.findByRole("tab", { name: "AIの利用" });
	expect(
		screen.queryByRole("button", { name: /設定の変更をすべて保存/ }),
	).toBeNull();
	fireEvent.mouseDown(screen.getByRole("tab", { name: "ツールチェーン" }), {
		button: 0,
		ctrlKey: false,
	});
	await screen.findByText("fixture_search");
	fireEvent.click(screen.getByText("保存済みの取得手順"));
	expect(screen.queryByRole("link")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "無効にする" }));
	await waitFor(() =>
		expect(state).toHaveBeenCalledWith(
			"r",
			"disabled",
			expect.any(AbortSignal),
		),
	);
	await screen.findByRole("button", { name: "有効にする" });
	fireEvent.click(screen.getByRole("button", { name: "有効にする" }));
	await screen.findByRole("button", { name: "無効にする" });
	fireEvent.click(screen.getByRole("button", { name: "削除" }));
	expect(remove).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: "削除する" }));
	await screen.findByText("保存済みの取得手順はありません。");
	expect(apply).not.toHaveBeenCalled();
	expect(screen.getByText("これは字幕のプレビューです。")).toBeTruthy();
});
