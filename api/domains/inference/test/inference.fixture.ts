import {
	createAttitudeDataset,
	migration as datasetMigration,
} from "../../attitude-dataset";
import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createSettings,
	migration as settingsMigration,
	epochsMigration as settingsEpochsMigration,
} from "../../settings";
import type { LarmPort } from "../../larm";
import {
	createInference,
	migration,
	parentsMigration,
	diagnosticsMigration,
	controlMigration,
	migrations as inferenceMigrations,
} from "..";
/** A neutral stand-in for the model name a connected system-one classifier reports. */
export const ATTITUDE_MODEL = "attitude-test-model";
export const cleanup: Array<() => Promise<void>> = [];
export async function until(condition: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (condition()) return;
		await Bun.sleep(5);
	}
	throw new Error("condition_not_reached");
}
export const messages = [
	{ role: "system" as const, content: "system" },
	{ role: "user" as const, content: "hello" },
];
export async function setup(
	options: {
		local?: LarmPort["answer"];
		localStream?: LarmPort["answerStream"];
		localSpeech?: LarmPort["speak"];
		judge?: LarmPort["judge"];
		prepareVoice?: LarmPort["prepareVoice"];
		decisionMs?: number;
		dataset?: boolean;
		speechText?: (text: string) => string;
		fetch?: typeof fetch;
		localMs?: number;
	} = {},
) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-inference-"));
	const dbPath = join(dir, "test.db");
	const store = openStore(dbPath, [
		settingsMigration,
		migration,
		settingsEpochsMigration,
		parentsMigration,
		diagnosticsMigration,
		controlMigration,
		...inferenceMigrations.slice(4).map((m) => m.sql),
	]);
	const settings = await createSettings(store, { dbPath, env: {} });
	const s = settings.get();
	const connectionId = crypto.randomUUID();
	for (const purpose of ["llm", "asr", "tts"] as const) {
		const id = crypto.randomUUID();
		s.resources.push({
			id,
			connectionId,
			purpose,
			model: `fixture-${purpose}`,
			contextWindow: purpose === "llm" ? 8192 : null,
			voice: purpose === "tts" ? "fixture-voice" : null,
		});
		s.routes[purpose].fallbackId = id;
	}
	s.connections.push({
		id: connectionId,
		name: "Fixture",
		baseUrl: "http://127.0.0.1:19999/v1",
		enabled: true,
		epoch: 0,
		envRef: null,
	});
	await settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: 0,
		settings: s,
		keys: [{ connectionId, value: "fixture-key" }],
	});
	const calls: string[] = [];
	const seen: Array<{ voice: string; style?: string; speed?: number }> = [];
	const payloads: unknown[] = [];
	const port: LarmPort = {
		decisionModel: () => (options.dataset ? ATTITUDE_MODEL : null),
		prepareVoice: options.prepareVoice,
		status: () => ({ state: "unconfigured", capabilities: [] }),
		answerStream: options.localStream,
		judge: options.judge,
		connect: async () => {},
		answer:
			options.local ??
			(async () => {
				throw new Error("larm_unconfigured");
			}),
		transcribe: async () => {
			throw new Error("larm_control_503");
		},
		speak:
			options.localSpeech ??
			(async () => {
				throw new Error("larm_control_503");
			}),
		close: async () => {},
	};
	const fetcher = (async (url: URL | Request | string, init?: RequestInit) => {
		calls.push(String(url));
		payloads.push(init?.body);
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer fixture-key",
		);
		if (String(url).endsWith("audio/speech")) return new Response(wav());
		if (String(url).endsWith("audio/transcriptions"))
			return Response.json({ text: "音声入力" });
		return Response.json({
			choices: [{ message: { content: "cloud-answer" } }],
			usage: { prompt_tokens: 7, completion_tokens: 3 },
		});
	}) as typeof fetch;
	const datasetStore = options.dataset
		? openStore(join(dir, "dataset.sqlite3"), [datasetMigration])
		: undefined;
	const dataset = datasetStore
		? createAttitudeDataset(datasetStore, dir)
		: undefined;
	const inference = createInference(store, settings, {
		attitudeDataset: dataset,
		larmFactory: (s) => {
			seen.push(s.larm);
			return port;
		},
		fetch: options.fetch ?? fetcher,
		localMs: options.localMs,
		cloudMs: 1000,
		decisionMs: options.decisionMs,
		speechText: options.speechText,
	});
	cleanup.push(async () => {
		await inference.close();
		await dataset?.close();
		await datasetStore?.close();
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { store, settings, inference, calls, payloads, seen, dataset, port };
}
export function wav() {
	const b = new Uint8Array(48);
	b.set(new TextEncoder().encode("RIFF"));
	b.set(new TextEncoder().encode("WAVE"), 8);
	return b;
}
export function freshSignal() {
	return new AbortController().signal;
}
export const judged = {
	answers: {
		emotion: {
			type: "choice",
			choice: "warmth",
			confidence: 0.9,
			answer_confidence: 0.8,
		},
	},
};
// RT-12: a probe row must never stay "running" and block new probes.
export const probeRow = (
	store: Awaited<ReturnType<typeof setup>>["store"],
	id: string,
) =>
	store.read(
		(db) =>
			db
				.query("SELECT status,error FROM inference_probes WHERE id=?")
				.get(id) as { status: string; error: string | null } | null,
	);
export async function enableEnglishSpeech(
	h: Awaited<ReturnType<typeof setup>>,
	localOnly = false,
) {
	const s = h.settings.get();
	s.larm.englishSpeechEnabled = true;
	if (localOnly) s.routes.tts.mode = "larm-only";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: s.revision,
		settings: s,
		keys: [],
	});
}
