import { expect, test } from "bun:test";
import type { Connection, Resource } from "../../settings/contracts";
import { createConnectionModels } from "../service/connection-models";
import { speechContract, workersUrl } from "../adapters/workers-ai";
import {
	workersAudio,
	workersSpeechRequest,
} from "../adapters/workers-ai-speech";
import { probeWav } from "../service/wav";

const connection: Connection = {
	id: crypto.randomUUID(),
	kind: "cloudflare-workers-ai",
	name: "音声クラウド",
	baseUrl: "https://api.cloudflare.com/client/v4",
	accountId: "a".repeat(32),
	enabled: true,
	epoch: 0,
	envRef: null,
};
const asr = {
	input: {
		type: "object",
		required: ["audio"],
		properties: {
			audio: { anyOf: [{ type: "string" }, { type: "object" }] },
			language: { type: "string" },
		},
	},
	output: { type: "object", properties: { text: { type: "string" } } },
};
const tts = {
	input: {
		type: "object",
		properties: {
			text: { type: "string" },
			speaker: {
				type: "string",
				enum: ["voice-a", "voice-b"],
				default: "voice-a",
			},
			encoding: { type: "string", enum: ["linear16", "mp3"] },
			container: { type: "string", enum: ["wav"] },
		},
	},
	output: { type: "string", contentType: "audio/mpeg", format: "binary" },
};
const idOf = () => `@cf/fixture/${crypto.randomUUID()}`;
const asrId = idOf(),
	ttsId = idOf(),
	unknownId = idOf();

function fixture(
	over: { schema?: unknown; run?: () => Response; onSchema?: () => void } = {},
) {
	const requests: Array<{ url: URL; init?: RequestInit }> = [];
	const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		requests.push({ url, init });
		if (url.pathname.endsWith("models/search"))
			return Response.json({
				success: true,
				result:
					url.searchParams.get("task") === "Text-to-Speech"
						? [{ name: ttsId }]
						: [{ name: asrId }, { name: unknownId }],
			});
		if (url.pathname.endsWith("models/schema")) {
			over.onSchema?.();
			return Response.json({
				success: true,
				result:
					over.schema ??
					(url.searchParams.get("model") === asrId
						? asr
						: url.searchParams.get("model") === ttsId
							? tts
							: {}),
			});
		}
		return (
			over.run?.() ??
			Response.json({ success: true, result: { text: "聞き取れました" } })
		);
	}) as typeof fetch;
	return { send, requests };
}

test("Workers AI discovers both tasks and schemas, retains unsupported entries, and exposes no credential", async () => {
	const { send, requests } = fixture();
	const settings = {
		get: () => ({ connections: [connection] }) as never,
		credential: () => "fixture-secret",
	};
	const service = createConnectionModels(settings, {}, { fetch: send });
	const signal = new AbortController().signal;
	const first = await service.list(connection.id, signal);
	expect(first?.models).toHaveLength(3);
	expect(first?.models.find((m) => m.id === unknownId)?.speech?.supported).toBe(
		false,
	);
	expect(first?.models.find((m) => m.id === ttsId)?.speech).toMatchObject({
		supported: true,
		voices: ["voice-a", "voice-b"],
		voiceDefault: "voice-a",
	});
	expect(JSON.stringify(first)).not.toContain("fixture-secret");
	const count = requests.length;
	await service.list(connection.id, signal);
	expect(requests).toHaveLength(count);
	await service.list(connection.id, signal, true);
	expect(requests).toHaveLength(count * 2);
	for (const r of requests) {
		expect(r.url.origin).toBe("https://api.cloudflare.com");
		expect(r.url.pathname).toStartWith(
			`/client/v4/accounts/${connection.accountId}/ai/`,
		);
		expect(new Headers(r.init?.headers).get("authorization")).toBe(
			"Bearer fixture-secret",
		);
		expect(r.init?.redirect).toBe("error");
	}
});

test("model discovery cannot adopt a response after an account or credential generation changes", async () => {
	let current = { ...connection };
	const { send } = fixture({
		onSchema: () => {
			current = { ...current, epoch: 1 };
		},
	});
	const service = createConnectionModels(
		{
			get: () => ({ connections: [current] }) as never,
			credential: () => "fixture",
		},
		{},
		{ fetch: send },
	);
	await expect(
		service.list(connection.id, new AbortController().signal),
	).rejects.toThrow("stale_connection_settings");
});

test("an upstream rejection never returns provider error text or credentials", async () => {
	const send = (async () =>
		new Response("sensitive provider error", {
			status: 403,
		})) as unknown as typeof fetch;
	const service = createConnectionModels(
		{
			get: () => ({ connections: [connection] }) as never,
			credential: () => "fixture",
		},
		{},
		{ fetch: send },
	);
	await expect(
		service.list(connection.id, new AbortController().signal),
	).rejects.toThrow("workers_ai_http_403");
});

test("wire compatibility follows schemas, including unknown required fields and optional voices", () => {
	expect(speechContract(asr, "asr").supported).toBe(true);
	expect(
		speechContract(
			{ ...asr, input: { ...asr.input, required: ["audio", "unhandled"] } },
			"asr",
		).supported,
	).toBe(false);
	expect(
		speechContract(
			{ ...tts, input: { ...tts.input, required: ["speaker"] } },
			"tts",
		).voiceRequired,
	).toBe(true);
	expect(
		speechContract(
			{
				...tts,
				input: {
					type: "object",
					properties: {
						text: { type: "string" },
						encoding: tts.input.properties.encoding,
						container: tts.input.properties.container,
					},
				},
			},
			"tts",
		).voiceRequired,
	).toBe(false);
	expect(() =>
		workersUrl(
			{ ...connection, baseUrl: "https://other.example" },
			"models/search",
		),
	).toThrow("workers_ai_invalid_connection");
});

const resource = (purpose: "asr" | "tts", model: string): Resource => ({
	id: crypto.randomUUID(),
	connectionId: connection.id,
	purpose,
	model,
	contextWindow: null,
	voice: null,
});
test("ASR serializes audio as the discovered contract and unwraps the response", async () => {
	const { send, requests } = fixture();
	const audio = probeWav();
	expect(
		await workersSpeechRequest(
			send,
			connection,
			"fixture",
			{ ...resource("asr", asrId), language: "ja" },
			audio,
			new AbortController().signal,
		),
	).toBe("聞き取れました");
	const call = requests.at(-1)!;
	expect(call.url.pathname).toEndWith(`/ai/run/${asrId}`);
	expect(JSON.parse(String(call.init?.body))).toEqual({
		audio: Buffer.from(audio).toString("base64"),
		language: "ja",
	});
});

test("TTS requests WAV where supported; invalid options and unsupported schemas never run a model", async () => {
	const { send, requests } = fixture({
		run: () =>
			new Response(probeWav(), { headers: { "content-type": "audio/wav" } }),
	});
	const signal = new AbortController().signal;
	const r = { ...resource("tts", ttsId), voice: "voice-b" };
	expect(
		await workersSpeechRequest(send, connection, "fixture", r, "試聴", signal),
	).toEqual(probeWav());
	expect(JSON.parse(String(requests.at(-1)!.init?.body))).toEqual({
		text: "試聴",
		speaker: "voice-b",
		encoding: "linear16",
		container: "wav",
	});
	const count = requests.length;
	await expect(
		workersSpeechRequest(
			send,
			connection,
			"fixture",
			{ ...r, voice: "missing" },
			"試聴",
			signal,
		),
	).rejects.toThrow("workers_ai_option_invalid");
	expect(requests).toHaveLength(count + 1);
	await expect(
		workersSpeechRequest(
			send,
			connection,
			"fixture",
			resource("tts", unknownId),
			"試聴",
			signal,
		),
	).rejects.toThrow("workers_ai_schema_unsupported");
});

test("an aborted provider response cannot yield adopted speech", async () => {
	const controller = new AbortController();
	const { send } = fixture({
		run: () => {
			controller.abort();
			return Response.json({ success: true, result: { text: "late" } });
		},
	});
	await expect(
		workersSpeechRequest(
			send,
			connection,
			"fixture",
			resource("asr", asrId),
			probeWav(),
			controller.signal,
		),
	).rejects.toThrow();
});

test.skipIf(!Bun.which("ffmpeg"))(
	"encoded provider audio becomes WAV and malformed audio is rejected",
	async () => {
		const encoded = Bun.spawnSync([
			Bun.which("ffmpeg")!,
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"anullsrc=r=16000:cl=mono",
			"-t",
			"0.02",
			"-f",
			"mp3",
			"pipe:1",
		]);
		expect(encoded.exitCode).toBe(0);
		const signal = new AbortController().signal;
		const wav = await workersAudio(new Uint8Array(encoded.stdout), signal);
		expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
		expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
		await expect(
			workersAudio(new Uint8Array([1, 2, 3]), signal),
		).rejects.toThrow("invalid_tts_audio");
	},
);
