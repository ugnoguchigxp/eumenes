import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { Settings } from "../../../../api/domains/settings/contracts";
import { settingsFixture } from "./sections/fixture";
import { useSpeechModels } from "./useSpeechModels";

afterEach(cleanup);

function setup(
	catalog: unknown[] = [],
	provider:
		"cloudflare-workers-ai" | "google-cloud-tts" = "cloudflare-workers-ai",
) {
	const saved = settingsFixture();
	saved.connections = [
		{
			id: "cloud",
			kind: "openai-compatible",
			name: "音声接続",
			baseUrl: "https://example.test",
			enabled: true,
			epoch: 0,
			envRef: null,
		},
		...(catalog.length
			? [
					{
						id: "workers",
						kind: provider,
						name:
							provider === "google-cloud-tts"
								? "Google Cloud（日本語・女性）"
								: "Workers",
						baseUrl: "https://workers.test",
						enabled: true,
						epoch: 0,
						envRef: null,
					},
				]
			: []),
	];
	saved.resources = (["asr", "tts"] as const).map((purpose) => ({
		id: purpose,
		purpose,
		connectionId: "cloud",
		model: `test-${purpose}`,
		voice: null,
		contextWindow: null,
	}));
	const client = {
		identity: "speech-test",
		settings: vi.fn(async () => saved),
		larmDetails: vi.fn(async () => ({
			providers: [{ name: "asr", model: "local-recognition" }],
		})),
		connectionModels: vi.fn(async () => ({
			models: catalog,
			account: { auth: "api-key", subscriptionType: null },
		})),
		applySettings: vi.fn(async ({ settings }: { settings: Settings }) => ({
			...settings,
			revision: settings.revision + 1,
		})),
	};
	const cache = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={cache}>{children}</QueryClientProvider>
	);
	const hook = renderHook(() => useSpeechModels(client as never), { wrapper });
	return { saved, client, hook };
}

for (const purpose of ["asr", "tts"] as const) {
	test(`${purpose} selects its saved resource and returns to LARM without changing other settings`, async () => {
		const { saved, client, hook } = setup();
		await waitFor(() => expect(hook.result.current.ready).toBe(true));
		expect(hook.result.current[purpose].options.map((o) => o.id)).toEqual([
			"larm",
			purpose,
		]);
		await act(() => hook.result.current.select(purpose, purpose));
		expect(hook.result.current[purpose].selected).toBe(purpose);
		const sent = client.applySettings.mock.calls[0]![0].settings;
		expect(sent.routes[purpose]).toMatchObject({
			mode: "cloud-only",
			cloudAllowed: true,
			fallbackId: purpose,
		});
		expect(sent.routes.llm).toEqual(saved.routes.llm);
		expect(sent.larm).toEqual(saved.larm);
		await act(() => hook.result.current.select(purpose, "larm"));
		expect(hook.result.current[purpose].selected).toBe("larm");
		expect(
			client.applySettings.mock.calls[1]![0].settings.routes[purpose].mode,
			// Speech has no cloud fallback; recognition keeps LARM first with its fallback.
		).toBe(purpose === "tts" ? "larm-only" : "larm-preferred");
	});
}

test("failed save keeps the saved selection and reports an error", async () => {
	const { client, hook } = setup();
	await waitFor(() => expect(hook.result.current.ready).toBe(true));
	client.applySettings.mockRejectedValueOnce(new Error("save failed"));
	await act(() => hook.result.current.select("tts", "tts"));
	expect(hook.result.current.error).toBeTruthy();
	expect(hook.result.current.tts.selected).toBe("larm");
});

test("keeps the saved Google voice and offers another voice as a separate TTS option", async () => {
	const voiceId = (name: string) => `ja-JP-Chirp3-HD-${name}`;
	const voice = voiceId("FixtureB");
	const { saved, hook, client } = setup(
		["FixtureA", "FixtureB"].map((name) => ({
			id: voiceId(name),
			displayName: name,
			purpose: "tts",
			contextWindow: null,
			speech: speech({
				voiceRequired: true,
				voiceDefault: voiceId(name),
				languageRequired: true,
				languageDefault: "ja-JP",
			}),
		})),
		"google-cloud-tts",
	);
	saved.resources.push({
		id: "current-google-voice",
		connectionId: "workers",
		purpose: "tts",
		model: voiceId("FixtureA"),
		voice: voiceId("FixtureA"),
		language: "ja-JP",
		contextWindow: null,
	});
	saved.routes.tts.mode = "cloud-only";
	saved.routes.tts.fallbackId = "current-google-voice";
	await waitFor(() =>
		expect(hook.result.current.tts.options.map((o) => o.label)).toEqual([
			"LARM",
			"音声接続 / test-tts",
			"Google Cloud（日本語・女性） / FixtureA",
			"Google Cloud（日本語・女性） / FixtureB",
		]),
	);
	expect(hook.result.current.tts.selected).toBe("current-google-voice");
	expect(hook.result.current.asr.options.map((o) => o.id)).toEqual([
		"larm",
		"asr",
	]);
	const option = hook.result.current.tts.options.at(-1)!;
	await act(() => hook.result.current.select("tts", option.id));
	const { resources, routes } = client.applySettings.mock.calls[0]![0].settings;
	expect(resources.at(-1)).toMatchObject({
		purpose: "tts",
		model: voice,
		voice,
		language: "ja-JP",
	});
	expect(routes.tts).toMatchObject({
		mode: "cloud-only",
		fallbackId: resources.at(-1)!.id,
	});
});

const speech = (overrides: Record<string, unknown> = {}) => ({
	supported: true,
	reason: null,
	voices: [],
	languages: [],
	voiceRequired: false,
	languageRequired: false,
	voiceDefault: null,
	languageDefault: null,
	voiceSelectable: false,
	languageSelectable: false,
	...overrides,
});

test("offers Workers AI for ASR and hides its registered and catalog TTS models", async () => {
	const { saved, client, hook } = setup([
		{
			id: "@cf/vendor/speak",
			displayName: "@cf/vendor/speak",
			purpose: "tts",
			speech: speech({ voiceRequired: true, voiceDefault: "angus" }),
			contextWindow: null,
		},
		{
			id: "@cf/vendor/listen",
			displayName: "@cf/vendor/listen",
			purpose: "asr",
			speech: speech(),
			contextWindow: null,
		},
		{
			id: "@cf/vendor/unsupported",
			displayName: "@cf/vendor/unsupported",
			purpose: "tts",
			speech: speech({ supported: false }),
			contextWindow: null,
		},
		{
			id: "@cf/vendor/no-default",
			displayName: "@cf/vendor/no-default",
			purpose: "tts",
			speech: speech({ voiceRequired: true }),
			contextWindow: null,
		},
	]);
	saved.resources.push({
		id: "workers-tts",
		connectionId: "workers",
		purpose: "tts",
		model: "@cf/vendor/saved-speak",
		contextWindow: null,
		voice: "angus",
	});
	await waitFor(() =>
		expect(hook.result.current.asr.options.map((o) => o.label)).toContain(
			"Workers / @cf/vendor/listen",
		),
	);
	expect(hook.result.current.tts.options.map((o) => o.label)).toEqual([
		"LARM",
		"音声接続 / test-tts",
	]);
	const option = hook.result.current.asr.options[2]!;
	await act(() => hook.result.current.select("asr", option.id));
	const sent = client.applySettings.mock.calls[0]![0].settings;
	const added = sent.resources.find(
		(r: Settings["resources"][number]) => r.model === "@cf/vendor/listen",
	)!;
	expect(added).toMatchObject({
		connectionId: "workers",
		purpose: "asr",
		voice: null,
		contextWindow: null,
	});
	expect(sent.resources).toHaveLength(saved.resources.length + 1);
	expect(sent.routes.asr).toMatchObject({
		mode: "cloud-only",
		cloudAllowed: true,
		fallbackId: added.id,
	});
});
