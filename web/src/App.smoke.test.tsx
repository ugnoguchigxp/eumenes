import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { ApiError } from "../../client";
import type { ContextCapture, Run } from "../../api/domains/dialogue/contracts";
import {
	post,
	stubWorkletNode,
	workletModule,
} from "./domains/audio/test/worklet-fake";
import { settingsFixture } from "./domains/settings/sections/fixture";

// App builds its own client; every call goes to this in-memory stand-in.
const api = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("../../client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../client")>()),
	createClient: () => api.current,
}));
import { App } from "./App";

function mockClient(overrides: Record<string, unknown> = {}) {
	const calls: Record<string, ReturnType<typeof vi.fn>> = {};
	const known: Record<string, unknown> = {
		identity: "smoke",
		settings: async () => settingsFixture(),
		conversation: async () => ({ id: "main", revision: 0, messages: [] }),
		runs: async () => [],
		status: async () => ({
			phase: "ready",
			larm: { state: "ready", error: null },
		}),
		inferenceUsage: async () => [],
		timerNotifications: async () => ({
			serverNow: new Date().toISOString(),
			items: [],
			nextCursor: null,
		}),
		subscribeChanges: () => () => {},
		subscribeChangesState: () => () => {},
		changesState: () => "open",
		reconnectChanges: () => {},
		settingsDiagnostics: async () => ({}),
		inferenceProbes: async () => [],
		larmDetails: async () => null,
		larmProfiles: async () => [],
		memoryStatus: async () => ({ enabled: false }),
		...overrides,
	};
	return new Proxy(known, {
		get(target, key: string) {
			if (key in target) {
				const value = target[key];
				if (typeof value !== "function") return value;
				return (calls[key] ??= vi.fn(value as (...a: unknown[]) => unknown));
			}
			// Anything this smoke test does not stub fails loudly at its call site.
			return (calls[key] ??= vi.fn(async () => {
				throw new Error(`client.${key} is not stubbed`);
			}));
		},
	});
}

beforeEach(() => {
	api.current = mockClient();
	window.location.hash = "";
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		})),
	);
});

test("a rejected chat submission shows a copyable diagnostic in the chat history", async () => {
	const writeText = vi.fn(async () => {});
	vi.stubGlobal(
		"navigator",
		Object.assign(Object.create(navigator), {
			clipboard: { writeText },
		}),
	);
	const requestId = crypto.randomUUID();
	const submit = vi.fn(async () => {
		throw new ApiError(
			503,
			"fixture_submit_failed",
			requestId,
			"private provider detail",
		);
	});
	api.current = mockClient({ submit });
	const { container } = render(<App />);
	const textbox = await screen.findByRole("textbox", { name: "メッセージ" });
	fireEvent.change(textbox, { target: { value: "送信内容の確認" } });
	fireEvent.click(screen.getByRole("button", { name: "送信" }));
	const failure = await screen.findByRole("article", { name: "会話エラー" });
	expect(container.querySelector(".chat-history")?.contains(failure)).toBe(
		true,
	);
	expect(container.querySelector(".chat-error")).toBeNull();
	fireEvent.click(
		within(failure).getByRole("button", { name: "エラーの詳細" }),
	);
	const report = await screen.findByLabelText("エラーレポート本文");
	expect(report.textContent).toContain("エラーコード: fixture_submit_failed");
	expect(report.textContent).toContain(`X-Request-Id: ${requestId}`);
	expect(report.textContent).not.toMatch(
		/private provider detail|送信内容の確認/,
	);
	fireEvent.click(screen.getByRole("button", { name: "レポートをコピー" }));
	expect(writeText).toHaveBeenCalledWith(report.textContent);
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	window.location.hash = "";
});

test("A01 boot: the conversation screen renders without a settings button", async () => {
	render(<App />);
	expect(await screen.findByRole("region", { name: "会話" })).toBeTruthy();
	expect(
		screen.queryByRole("separator", {
			name: "会話とアーティファクトのサイズを調整",
		}),
	).toBeNull();
	expect(
		(screen.getByRole("textbox", { name: "メッセージ" }) as HTMLTextAreaElement)
			.disabled,
	).toBe(false);
	expect(screen.getByRole("button", { name: "音声を開始" })).toBeTruthy();
	await waitFor(() =>
		expect(screen.getByLabelText("LARMの接続状態: 接続済み")).toBeTruthy(),
	);

	expect(screen.queryByRole("button", { name: "設定" })).toBeNull();
	expect(screen.queryByRole("button", { name: "コンテキスト" })).toBeNull();
});

test("the debug button follows the latest run and a saved reply opens its own input", async () => {
	const changes = new Set<(kind: "change") => void>();
	const settings = settingsFixture();
	settings.agency.debugMode = true;
	const at = Date.now();
	const createdAt = new Date(at).toISOString();
	const turns = ["過去", "最新"].map((label, index) => {
		const id = `turn-${index}`;
		const run: Run = {
			id,
			conversationId: "main",
			inputMessageId: `${id}-user`,
			answerMessageId: `${id}-reply`,
			requestId: id,
			utteranceId: null,
			status: "completed",
			revision: 1,
			error: null,
			jobId: null,
			deadlineAt: null,
			sourceKind: "manual",
			scheduleId: null,
			occurrenceId: null,
			specialistSessionId: null,
			createdAt,
			updatedAt: createdAt,
		};
		const capture: ContextCapture = {
			summary: {
				id: `${id}-capture`,
				runId: id,
				number: 1,
				at,
				expiresAt: at + 60_000,
				inferenceId: id,
				attemptId: id,
				boundary: "larm",
				status: "succeeded",
				accepted: true,
				available: true,
			},
			input: {
				boundary: "larm",
				messages: [
					{ role: "user", content: `${label}の送信入力`, origins: [] },
				],
			},
			cut: null,
			previous: null,
		};
		const message = {
			id: run.answerMessageId,
			role: "assistant",
			text: `${label}の返答`,
			conversationId: "main",
			runId: id,
			createdAt,
		};
		return { run, capture, message };
	});
	const captureFor = (id: string) =>
		turns.find(({ run }) => run.id === id)!.capture;
	api.current = mockClient({
		settings: async () => structuredClone(settings),
		runs: async () => turns.map(({ run }) => run),
		conversation: async () => ({
			id: "main",
			revision: 1,
			messages: turns.map(({ message }) => message),
		}),
		debugDiagnostics: async () => ({ entries: [], omitted: 0 }),
		subscribeChanges: (notify: (kind: "change") => void) => {
			changes.add(notify);
			return () => changes.delete(notify);
		},
		runContext: async (runId: string) => {
			const { summary } = captureFor(runId);
			return {
				runId,
				conversationId: "main",
				status: "completed",
				captures: [summary],
				preferredId: summary.id,
				empty: "unavailable",
			};
		},
		contextCapture: async (runId: string) => captureFor(runId),
	});
	render(<App />);
	const context = await screen.findByRole("button", { name: "コンテキスト" });
	expect(context.textContent).toBe("");
	expect(context.nextElementSibling).toBe(
		screen.getByRole("button", { name: "チャットを隠す" }),
	);
	fireEvent.click(context);
	expect(await screen.findByText("最新の送信入力")).toBeTruthy();
	const earlier = (await screen.findByText("過去の返答")).closest("article")!;
	fireEvent.click(
		within(earlier).getByRole("button", { name: "この返答の入力を見る" }),
	);
	expect(await screen.findByText("過去の送信入力")).toBeTruthy();
	expect(screen.queryByText("最新の送信入力")).toBeNull();
	expect(screen.getByRole("textbox", { name: "メッセージ" })).toBeTruthy();

	settings.agency.debugMode = false;
	act(() => {
		for (const notify of changes) notify("change");
	});
	await waitFor(() => expect(screen.queryByText("過去の送信入力")).toBeNull());
	expect(screen.queryByRole("button", { name: "コンテキスト" })).toBeNull();
});

test("confirming a transcript from the chat microphone sends its capture timing", async () => {
	const nodes = stubWorkletNode();
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
		},
	});
	vi.stubGlobal(
		"AudioContext",
		class {
			sampleRate = 16_000;
			audioWorklet = workletModule;
			destination = {};
			async resume() {}
			async close() {}
			createMediaStreamSource() {
				return { connect() {}, disconnect() {} };
			}
		},
	);
	const transcript = "音声入力の計測を確認します。";
	const ready = {
		status: "input_ready",
		text: transcript,
		revision: 1,
	};
	const voiceCommit = vi.fn(async () => ready);
	api.current = mockClient({
		watchVoiceInput: async () => new Promise<void>(() => {}),
		voiceStart: async () => {},
		voiceSend: async () => {},
		voiceStop: async () => {},
		voiceTurn: async (utteranceId: string) => ({ ...ready, utteranceId }),
		voiceCommit,
	});
	render(<App />);
	fireEvent.click(await screen.findByRole("button", { name: "音声を開始" }));
	await waitFor(() => expect(nodes).toHaveLength(1));
	act(() => {
		const speech = Float32Array.from({ length: 2048 }, (_, i) =>
			i % 16 < 8 ? 0.05 : -0.05,
		);
		for (let i = 0; i < 3; i++) post(nodes[0], speech);
		const silence = new Float32Array(2048);
		for (let i = 0; i < 16; i++) post(nodes[0], silence);
	});
	const message = screen.getByRole<HTMLTextAreaElement>("textbox", {
		name: "メッセージ",
	});
	await waitFor(() => expect(message.value).toBe(transcript));
	expect(voiceCommit).toHaveBeenCalledExactlyOnceWith(
		expect.any(String),
		1,
		undefined,
		expect.objectContaining({
			audioMs: expect.any(Number),
			uploadToShownMs: expect.any(Number),
		}),
	);
});
