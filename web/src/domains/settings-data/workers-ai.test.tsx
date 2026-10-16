import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import { createSettingsBackend, newCache, Screens } from "./settings.fixture";

afterEach(cleanup);
beforeEach(() => sessionStorage.clear());
const bundle = JSON.parse(
	readFileSync(
		resolve("api/domains/capabilities/bundles/settings.bundle.json"),
		"utf8",
	),
) as { artifacts: ArtifactDefinitionV1[] };
const artifacts = Object.fromEntries(
	bundle.artifacts
		.filter((a) => a.id !== "settings.records")
		.map((a) => [a.id.replace(/^settings\./, ""), a]),
);
const catalog = {
	models: ["asr", "tts"].map((purpose) => ({
		id: `@cf/fixture/${purpose}`,
		displayName: `テスト${purpose}`,
		purpose,
		contextWindow: null,
		speech: {
			supported: true,
			reason: null,
			voices: purpose === "tts" ? ["voice-a", "voice-b"] : [],
			languages: [],
			voiceRequired: false,
			languageRequired: false,
			voiceDefault: purpose === "tts" ? "voice-a" : null,
			languageDefault: null,
			voiceSelectable: purpose === "tts",
			languageSelectable: true,
		},
	})),
	account: { auth: "api-key", subscriptionType: null },
};
const save = () =>
	fireEvent.click(
		screen.getByRole("button", { name: "設定の変更をすべて保存" }),
	);
const tab = async (name: string) =>
	fireEvent.mouseDown(await screen.findByRole("tab", { name }), {
		button: 0,
		ctrlKey: false,
	});
function open() {
	const backend = createSettingsBackend({ artifacts, cloud: false });
	backend.client.connectionModels.mockResolvedValue(catalog as never);
	render(
		<Screens
			backend={backend}
			start="ai-connections"
			cache={newCache(backend)}
		/>,
	);
	return backend;
}

test("the shipped form registers Account ID and a confidential token without requiring a URL", async () => {
	const backend = open();
	await tab("登録した接続");
	const form = await screen.findByRole("form", { name: "クラウドAPIを登録" });
	const f = within(form);
	fireEvent.change(f.getByLabelText("接続の種類"), {
		target: { value: "cloudflare-workers-ai" },
	});
	expect(f.queryByLabelText(/APIのベースURL/)).toBeNull();
	fireEvent.change(f.getByLabelText("接続名（必須）"), {
		target: { value: "Workers音声" },
	});
	fireEvent.change(f.getByLabelText("Account ID（必須）"), {
		target: { value: "a".repeat(32) },
	});
	fireEvent.change(f.getByLabelText(/APIキー／APIトークン/), {
		target: { value: "fixture-private-token" },
	});
	fireEvent.submit(form);
	await waitFor(() =>
		expect(
			screen.getByRole("button", { name: "設定の変更をすべて保存" }),
		).toHaveProperty("disabled", false),
	);
	expect(document.body.textContent).not.toContain("fixture-private-token");
	expect(JSON.stringify({ ...sessionStorage })).not.toContain(
		"fixture-private-token",
	);
	save();
	await screen.findAllByText("変更を適用しました");
	expect(backend.saved().connections.at(-1)).toMatchObject({
		name: "Workers音声",
		kind: "cloudflare-workers-ai",
		accountId: "a".repeat(32),
		baseUrl: "https://api.cloudflare.com/client/v4",
	});
	expect((backend.storedKeys.at(-1) as { value?: string })?.value).toBe(
		"fixture-private-token",
	);
	expect(backend.client.connectionModels).not.toHaveBeenCalled();
});

test("catalog choices stage ASR and TTS with language/voice, survive saving, and block duplicate registration", async () => {
	const backend = createSettingsBackend({ artifacts, cloud: false });
	const saved = backend.saved();
	const connectionId = crypto.randomUUID();
	saved.connections.push({
		id: connectionId,
		kind: "cloudflare-workers-ai",
		name: "Workers音声",
		baseUrl: "https://api.cloudflare.com/client/v4",
		accountId: "a".repeat(32),
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	backend.setSaved(saved);
	backend.client.connectionModels.mockResolvedValue(catalog as never);
	render(
		<Screens
			backend={backend}
			start="ai-connections"
			cache={newCache(backend)}
		/>,
	);
	await tab("音声モデル");
	fireEvent.click(
		await screen.findByRole("button", { name: "接続確認・モデル一覧を更新" }),
	);
	await waitFor(() =>
		expect(
			screen.getByLabelText("取得したモデル").querySelectorAll("option"),
		).toHaveLength(2),
	);
	fireEvent.change(screen.getByLabelText("取得したモデル"), {
		target: { value: "@cf/fixture/asr" },
	});
	fireEvent.change(screen.getByLabelText("モデルの言語"), {
		target: { value: "ja" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "選んだモデルを下書きに追加" }),
	);
	await screen.findByText(/下書きに追加しました/);
	fireEvent.change(screen.getByLabelText("モデルの用途"), {
		target: { value: "tts" },
	});
	fireEvent.change(screen.getByLabelText("取得したモデル"), {
		target: { value: "@cf/fixture/tts" },
	});
	fireEvent.change(screen.getByLabelText("モデルの声"), {
		target: { value: "voice-b" },
	});
	fireEvent.click(
		screen.getByRole("button", { name: "選んだモデルを下書きに追加" }),
	);
	save();
	await screen.findAllByText("変更を適用しました");
	expect(
		backend.saved().resources.filter((r) => r.connectionId === connectionId),
	).toEqual([
		expect.objectContaining({
			purpose: "asr",
			model: "@cf/fixture/asr",
			language: "ja",
		}),
		expect.objectContaining({
			purpose: "tts",
			model: "@cf/fixture/tts",
			voice: "voice-b",
		}),
	]);
	fireEvent.click(
		screen.getByRole("button", { name: "選んだモデルを下書きに追加" }),
	);
	await screen.findByText(/このモデルと声・言語は登録済み/);
	expect(backend.client.connectionModels).toHaveBeenCalledWith(
		connectionId,
		expect.any(AbortSignal),
		true,
	);
});

test("catalog failures explain the next step and never expose an upstream response", async () => {
	const backend = createSettingsBackend({ artifacts, cloud: false });
	const saved = backend.saved();
	saved.connections.push({
		id: crypto.randomUUID(),
		kind: "cloudflare-workers-ai",
		name: "Workers音声",
		baseUrl: "https://api.cloudflare.com/client/v4",
		accountId: "a".repeat(32),
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	backend.setSaved(saved);
	backend.client.connectionModels.mockRejectedValue(
		new Error("provider-secret"),
	);
	render(
		<Screens
			backend={backend}
			start="ai-connections"
			cache={newCache(backend)}
		/>,
	);
	await tab("音声モデル");
	fireEvent.click(
		await screen.findByRole("button", { name: "接続確認・モデル一覧を更新" }),
	);
	await screen.findByText(/Account ID・APIトークン・Workers AIの権限/);
	expect(document.body.textContent).not.toContain("provider-secret");
	expect(
		screen.getByRole("button", { name: "選んだモデルを下書きに追加" }),
	).toHaveProperty("disabled", true);
});

test("a failed refresh disables cached choices until the catalog can be read again", async () => {
	const backend = createSettingsBackend({ artifacts, cloud: false });
	const saved = backend.saved();
	saved.connections.push({
		id: crypto.randomUUID(),
		kind: "cloudflare-workers-ai",
		name: "Workers音声",
		baseUrl: "https://api.cloudflare.com/client/v4",
		accountId: "a".repeat(32),
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	backend.setSaved(saved);
	backend.client.connectionModels
		.mockResolvedValueOnce(catalog as never)
		.mockRejectedValueOnce(new Error("unavailable"));
	render(
		<Screens
			backend={backend}
			start="ai-connections"
			cache={newCache(backend)}
		/>,
	);
	await tab("音声モデル");
	const refresh = () =>
		screen.getByRole("button", { name: "接続確認・モデル一覧を更新" });
	fireEvent.click(refresh());
	await waitFor(() =>
		expect(screen.getByLabelText("取得したモデル")).toHaveProperty(
			"disabled",
			false,
		),
	);
	fireEvent.change(screen.getByLabelText("取得したモデル"), {
		target: { value: "@cf/fixture/asr" },
	});
	fireEvent.click(refresh());
	await screen.findByText(/Account ID・APIトークン・Workers AIの権限/);
	expect(screen.getByLabelText("取得したモデル")).toHaveProperty(
		"disabled",
		true,
	);
	expect(
		screen.getByRole("button", { name: "選んだモデルを下書きに追加" }),
	).toHaveProperty("disabled", true);
});
