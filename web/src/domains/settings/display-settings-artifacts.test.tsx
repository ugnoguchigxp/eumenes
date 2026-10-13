import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { compileArtifact, type ArtifactEvent } from "@eumenes/artifact-ui";
import type { EumenesClient } from "../../../../client";
import {
	settingsSchema,
	type ApplySettings,
} from "../../../../api/domains/settings/contracts";
import { SettingsDraftProvider, useSettingsDraft } from "./SettingsDraftHost";
import { SettingsArtifact } from "./SettingsArtifact";
import {
	settingsArtifactDefinition,
	isSettingsArtifactDefinition,
	type SettingsArtifactId,
} from "./artifact-definition";
import { settingsArtifactRuntime } from "./artifact-runtime";
import { settingsFixture } from "./sections/fixture";
import { queryRoots } from "../../queryKeys";

afterEach(cleanup);
function fixture() {
	let saved = settingsFixture();
	const original = structuredClone(saved);
	const apply = vi.fn(async (input: ApplySettings) => {
		saved = settingsSchema.parse(input.settings);
		saved.revision++;
		return saved;
	});
	const client = {
		identity: crypto.randomUUID(),
		settings: async () => saved,
		applySettings: apply,
		larmVoices: vi.fn(),
	} as unknown as EumenesClient;
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	cache.setQueryData([queryRoots.settings, client.identity], saved);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>
			<SettingsDraftProvider client={client}>{children}</SettingsDraftProvider>
		</QueryClientProvider>
	);
	return { client, original, apply, wrapper };
}

test("display edits preview before saving, reviews all five fields, preserves failed drafts, saves and discards in the shared host", async () => {
	const f = fixture();
	function Screens() {
		const [view, open] = useState<SettingsArtifactId | null>("display");
		return (
			<>
				<button onClick={() => open("display")}>表示に戻る</button>
				<button onClick={() => open(null)}>閉じる</button>
				{view && (
					<SettingsArtifact
						definition={settingsArtifactDefinition(view)}
						onOpen={open}
					/>
				)}
			</>
		);
	}
	render(<Screens />, { wrapper: f.wrapper });
	expect(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	).toHaveProperty("disabled", true);
	fireEvent.change(screen.getByLabelText("会話の背景"), {
		target: { value: "spatial" },
	});
	fireEvent.change(screen.getByLabelText("テーマ"), {
		target: { value: "dark" },
	});
	fireEvent.click(screen.getByLabelText("読み上げ字幕を表示する"));
	fireEvent.change(screen.getByLabelText("字幕のデザイン"), {
		target: { value: "classic" },
	});
	fireEvent.change(screen.getByLabelText("字幕の大きさ"), {
		target: { value: "xlarge" },
	});
	expect(screen.getByTestId("subtitle").getAttribute("data-style")).toBe(
		"classic",
	);
	expect(screen.getByTestId("subtitle").getAttribute("data-size")).toBe(
		"xlarge",
	);
	expect(await f.client.settings()).toEqual(f.original);
	fireEvent.click(screen.getByText("閉じる"));
	fireEvent.click(screen.getByText("表示に戻る"));
	expect(screen.getByLabelText("テーマ")).toHaveProperty("value", "dark");
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	for (const label of [
		"会話の背景",
		"テーマ",
		"読み上げ字幕を表示する",
		"字幕のデザイン",
		"字幕の大きさ",
	])
		expect(screen.getByText("表示 / " + label)).toBeTruthy();
	expect(screen.queryByText("既存の設定画面の変更")).toBeNull();
	fireEvent.click(screen.getByText("表示に戻る"));
	f.apply.mockRejectedValueOnce(new Error("revision_conflict"));
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText(/別の画面で設定が変更されました/);
	expect(screen.getByLabelText("字幕のデザイン")).toHaveProperty(
		"value",
		"classic",
	);
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
	await screen.findByText("変更を適用しました");
	expect((await f.client.settings()).general).toMatchObject({
		background: "spatial",
		theme: "dark",
		subtitles: { enabled: true, style: "classic", size: "xlarge" },
	});
	expect((await f.client.settings()).voice).toEqual(f.original.voice);
	expect(f.client.larmVoices).not.toHaveBeenCalled();
	fireEvent.change(screen.getByLabelText("テーマ"), {
		target: { value: "light" },
	});
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	fireEvent.click(
		screen.getByRole("button", { name: "未適用の設定変更をすべて破棄" }),
	);
	fireEvent.click(screen.getByText("表示に戻る"));
	await waitFor(() =>
		expect(screen.getByLabelText("テーマ")).toHaveProperty("value", "dark"),
	);
});

test("display sources compose and reject invalid choices, foreign fields, preview mutation, stale and duplicate operations", async () => {
	const f = fixture();
	const hook = renderHook(() => useSettingsDraft(), { wrapper: f.wrapper });
	const runtime = () => settingsArtifactRuntime(hook.result.current, vi.fn());
	expect(
		compileArtifact(settingsArtifactDefinition("display"), runtime().snapshot)
			.lang,
	).toContain("Composition");
	const previewOnly = JSON.stringify({
		view: "subtitle-preview",
		source: "settings-display-preview",
	});
	expect(isSettingsArtifactDefinition(previewOnly)).toBe(true);
	expect(compileArtifact(previewOnly, runtime().snapshot).lang).toContain(
		"SubtitlePreview",
	);
	expect(() =>
		compileArtifact(settingsArtifactDefinition("display"), {
			...runtime().snapshot,
			"settings-display-preview": { kind: "components", revision: 1 },
		}),
	).toThrow();
	const event = (
		fieldId: string,
		value: unknown,
		source = "settings-display",
	): ArtifactEvent => ({
		id: crypto.randomUUID(),
		source,
		revision: hook.result.current.current().revision,
		action: "settings-edit",
		values: { fieldId, value } as ArtifactEvent["values"],
	});
	for (const bad of [
		event("display.theme", "purple"),
		event("display.subtitles.enabled", "yes"),
		event("display.subtitles.style", "custom"),
		event("display.subtitles.size", "small"),
		event("display.background", "custom"),
		event("conversation.persona", "sage"),
		event("display.theme", "dark", "settings-display-preview"),
	]) {
		await act(async () =>
			expect(await runtime().dispatch(bad)).toMatchObject({
				status: "rejected",
			}),
		);
	}
	const stale = event("display.theme", "light"),
		valid = event("display.subtitles.enabled", "true");
	await act(async () =>
		expect(await runtime().dispatch(valid)).toMatchObject({
			status: "accepted",
		}),
	);
	await act(async () => {
		expect(await runtime().dispatch(stale)).toMatchObject({
			status: "conflict",
		});
		expect(await runtime().dispatch(valid)).toMatchObject({
			status: "duplicate",
		});
	});
	expect(hook.result.current.value?.general.subtitles.enabled).toBe(true);
	expect(runtime().snapshot["settings-changes"]).toMatchObject({
		rows: [expect.objectContaining({ label: "表示 / 読み上げ字幕を表示する" })],
	});
	expect(JSON.stringify(runtime().snapshot)).not.toContain("$.general");
});
