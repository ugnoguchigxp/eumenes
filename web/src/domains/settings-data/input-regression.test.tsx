import { readFileSync } from "node:fs";
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
import { settingsSchema } from "../../../../api/domains/settings/contracts";
import { createSettingsBackend, newCache, Screens } from "./settings.fixture";
import { draftStoreFor } from "../toolchain-artifacts/drafts";

afterEach(cleanup);
beforeEach(() => sessionStorage.clear());
const bundle = JSON.parse(
	readFileSync("api/domains/capabilities/bundles/settings.bundle.json", "utf8"),
) as { artifacts: ArtifactDefinitionV1[] };
const artifacts = Object.fromEntries(
	bundle.artifacts
		.filter((a) => a.id !== "settings.records")
		.map((a) => [a.id.replace(/^settings\./, ""), a]),
);
const route = () => ({
	mode: "larm-preferred",
	cloudAllowed: true,
	fallbackId: null,
	epoch: 0,
});
function initial() {
	return settingsSchema.parse({
		revision: 1,
		larm: { baseUrl: null, audience: "saaa-desktop", voice: "", speed: 1 },
		connections: [],
		resources: [],
		routes: { llm: route(), asr: route(), tts: route() },
		voice: {
			autoSpeak: true,
			outputVolume: 1,
			bargeIn: true,
			inputDevice: "",
			outputDevice: "",
			threshold: 0.008,
			silenceMs: 1500,
			echoCancellation: true,
			noiseSuppression: true,
			autoGainControl: true,
		},
		general: {
			agentName: "",
			userName: "",
			persona: "butler",
			theme: "system",
			subtitles: { enabled: false, style: "netflix", size: "large" },
		},
	});
}
function open(start = "ai-connections", cloud = false) {
	const backend = createSettingsBackend({
		artifacts,
		initial: initial(),
		...(cloud ? { cloud: false } : {}),
	});
	const cache = newCache(backend);
	render(<Screens backend={backend} start={start} cache={cache} />);
	return {
		backend,
		store: draftStoreFor(backend.client.identity, "document:settings@1"),
	};
}
async function tab(name: string) {
	fireEvent.mouseDown(await screen.findByRole("tab", { name }), {
		button: 0,
		ctrlKey: false,
	});
}
const save = () =>
	screen.getByRole("button", { name: "設定の変更をすべて保存" });
async function form() {
	await tab("登録した接続");
	const element = await screen.findByRole("form", {
		name: "クラウドAPIを登録",
	});
	const f = within(element);
	fireEvent.change(f.getByLabelText("接続の種類"), {
		target: { value: "cloudflare-workers-ai" },
	});
	fireEvent.change(f.getByLabelText("接続名（必須）"), {
		target: { value: "Workers接続" },
	});
	return { element, f };
}

test("invalid registration keeps all input, identifies Account ID/token, and allows correction then saving", async () => {
	const { backend, store } = open();
	const { element, f } = await form();
	const account = () => f.getByLabelText("Account ID（必須）");
	const token = () => f.getByLabelText(/APIキー／APIトークン/);
	fireEvent.change(account(), { target: { value: "bad-account" } });
	fireEvent.change(token(), { target: { value: "private-review-token" } });
	fireEvent.submit(element);
	await screen.findByText(/Account ID:.*形式/);
	expect(account()).toHaveProperty("value", "bad-account");
	expect(token()).toHaveProperty("value", "private-review-token");
	expect(store.getView().structural).toHaveLength(0);
	expect(save()).toHaveProperty("disabled", true);
	expect(screen.queryByText("すべての変更を保存済み")).toBeNull();
	expect(
		screen.getAllByText(/先に「クラウドAPIを登録」/).length,
	).toBeGreaterThan(0);
	fireEvent.click(screen.getByRole("button", { name: "変更一覧を開く" }));
	await waitFor(() =>
		expect(
			screen.getByRole("form", { name: "クラウドAPIを登録" }),
		).toBeTruthy(),
	);
	expect(account()).toHaveProperty("value", "bad-account");
	fireEvent.change(account(), { target: { value: "a".repeat(32) } });
	fireEvent.change(token(), { target: { value: "" } });
	fireEvent.submit(element);
	await screen.findByText(/APIキー／APIトークン:.*入力/);
	expect(account()).toHaveProperty("value", "a".repeat(32));
	expect(store.getView().structural).toHaveLength(0);
	fireEvent.change(token(), { target: { value: "private-review-token" } });
	fireEvent.submit(element);
	await screen.findByText(/下書きに追加しました/);
	await waitFor(() => expect(save()).toHaveProperty("disabled", false));
	expect(backend.saved().connections).toHaveLength(0);
	expect(JSON.stringify(store.getView())).not.toContain("private-review-token");
	fireEvent.click(save());
	await screen.findAllByText("変更を適用しました");
	expect(backend.saved().connections[0]).toMatchObject({
		name: "Workers接続",
		accountId: "a".repeat(32),
	});
	expect(backend.storedKeys).toEqual([
		expect.objectContaining({ value: "private-review-token" }),
	]);
	expect(JSON.stringify({ ...sessionStorage })).not.toContain(
		"private-review-token",
	);
});

test("unregistered input blocks saving other changes across tabs until it is registered or cleared", async () => {
	const { backend } = open();
	const { f } = await form();
	await tab("利用するAI");
	fireEvent.change(screen.getByLabelText("LARMのURL"), {
		target: { value: "http://127.0.0.1:9100" },
	});
	expect(save()).toHaveProperty("disabled", true);
	expect(backend.sent).toHaveLength(0);
	await tab("登録した接続");
	expect(f.getByLabelText("接続名（必須）")).toHaveProperty(
		"value",
		"Workers接続",
	);
	fireEvent.change(f.getByLabelText("接続名（必須）"), {
		target: { value: "" },
	});
	fireEvent.change(f.getByLabelText("接続の種類"), {
		target: { value: "openai-compatible" },
	});
	await waitFor(() => expect(save()).toHaveProperty("disabled", false));
});

test("middle insertion, deletion and selection replacement preserve the complete token through a rejected save and retry", async () => {
	const { backend, store } = open("ai-connections", true);
	await tab("利用するAI");
	fireEvent.click(await screen.findByRole("button", { name: "クラウド音声" }));
	const box = screen.getByLabelText(/APIキー／APIトークン／setup-tokenの更新/);
	expect(box).toHaveProperty("type", "password");
	for (const value of ["abcdef", "abXcdef", "abXdef", "abZZef"]) {
		fireEvent.change(box, { target: { value } });
		expect(box).toHaveProperty("value", value);
		expect(
			store.peekSecret("connection.api-key", backend.cloud.connectionId),
		).toBe(value);
		expect(JSON.stringify(store.getView())).not.toContain(value);
	}
	backend.client.submitToolchainAction.mockResolvedValueOnce({
		httpStatus: 200,
		view: {
			eventId: crypto.randomUUID(),
			status: "rejected",
			errorCode: "secret_key_unavailable",
			createdAt: new Date().toISOString(),
		},
	} as never);
	fireEvent.click(save());
	await screen.findAllByText(/認証情報を保存できませんでした/);
	expect(box).toHaveProperty("value", "abZZef");
	expect(save()).toHaveProperty("disabled", false);
	fireEvent.click(save());
	await screen.findAllByText("変更を適用しました");
	expect(backend.storedKeys).toEqual([
		expect.objectContaining({ value: "abZZef" }),
	]);
	await waitFor(() =>
		expect(
			screen.getByLabelText(/APIキー／APIトークン／setup-tokenの更新/),
		).toHaveProperty("value", ""),
	);
});

test("numeric intermediate text survives edits and tab changes, blocks invalid saves, and saves only the final valid value", async () => {
	const { backend } = open("voice-input");
	fireEvent.click(await screen.findByRole("button", { name: "聞き取り" }));
	const input = screen.getByLabelText("声を検出するしきい値");
	for (const value of ["", "0.", "-"]) {
		fireEvent.change(input, { target: { value } });
		await waitFor(() => expect(input).toHaveProperty("value", value));
		expect(save()).toHaveProperty("disabled", true);
		expect(backend.sent).toHaveLength(0);
	}
	fireEvent.click(await screen.findByRole("button", { name: "機器" }));
	fireEvent.click(await screen.findByRole("button", { name: "聞き取り" }));
	expect(screen.getByLabelText("声を検出するしきい値")).toHaveProperty(
		"value",
		"-",
	);
	fireEvent.change(screen.getByLabelText("声を検出するしきい値"), {
		target: { value: "0.02" },
	});
	await waitFor(() => expect(save()).toHaveProperty("disabled", false));
	fireEvent.click(save());
	await screen.findAllByText("変更を適用しました");
	expect(backend.saved().voice.threshold).toBe(0.02);
});
