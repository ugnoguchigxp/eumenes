import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { Settings } from "../../../../api/domains/settings/contracts";
import { settingsFixture } from "./sections/fixture";
import { useSpeechModels } from "./useSpeechModels";

afterEach(cleanup);

function setup(workersModels: unknown[] = []) {
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
		...(workersModels.length
			? [
					{
						id: "workers",
						kind: "cloudflare-workers-ai" as const,
						name: "Workers",
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
			models: workersModels,
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
		).toBe("larm-preferred");
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

test("lists unregistered Workers AI speech models and registers one when picked", async () => {
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
	await waitFor(() =>
		expect(hook.result.current.tts.options.map((o) => o.label)).toEqual([
			"LARM",
			"音声接続 / test-tts",
			"Workers / @cf/vendor/speak",
		]),
	);
	expect(hook.result.current.asr.options.map((o) => o.label)).toContain(
		"Workers / @cf/vendor/listen",
	);
	const option = hook.result.current.tts.options[2]!;
	await act(() => hook.result.current.select("tts", option.id));
	const sent = client.applySettings.mock.calls[0]![0].settings;
	const added = sent.resources.find(
		(r: Settings["resources"][number]) => r.model === "@cf/vendor/speak",
	)!;
	expect(added).toMatchObject({
		connectionId: "workers",
		purpose: "tts",
		voice: "angus",
		contextWindow: null,
	});
	expect(sent.resources).toHaveLength(saved.resources.length + 1);
	expect(sent.routes.tts).toMatchObject({
		mode: "cloud-only",
		cloudAllowed: true,
		fallbackId: added.id,
	});
});
