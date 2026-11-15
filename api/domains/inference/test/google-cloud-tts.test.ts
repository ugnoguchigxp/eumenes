import { afterEach, expect, test } from "bun:test";
import { googleCloudTts } from "../../settings/contracts";
import { createConnectionModels } from "../service/connection-models";
import { probeWav } from "../service/wav";
import { cleanup, freshSignal, setup } from "./inference.fixture";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("selects a Japanese female catalog voice and synthesizes through the cloud TTS route", async () => {
	const language = googleCloudTts.language;
	const firstVoice = `${language}-Chirp3-HD-AFixture`;
	const voice = `${language}-Chirp3-HD-ZFixture`;
	const describeVoice = (
		name: string,
		ssmlGender = "FEMALE",
		locale: string = language,
	) => ({
		name,
		languageCodes: [locale],
		ssmlGender,
	});
	const audio = probeWav();
	const sent: unknown[] = [];
	const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		expect(url.origin).toBe(new URL(googleCloudTts.baseUrl).origin);
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(
			"fixture-key",
		);
		if (url.pathname === "/v1/voices") {
			expect(url.searchParams.get("languageCode")).toBe(language);
			return Response.json({
				voices: [
					describeVoice(voice),
					describeVoice(`${language}-Chirp3-HD-0Fixture`, "MALE"),
					describeVoice(`${language}-Chirp3-HD-0English`, "FEMALE", "en-US"),
					describeVoice(`${language}-Other-Female`),
					describeVoice(firstVoice),
				],
			});
		}
		expect(url.pathname).toBe("/v1/text:synthesize");
		expect(init?.method).toBe("POST");
		sent.push(JSON.parse(String(init?.body)));
		return Response.json({
			audioContent: Buffer.from(audio).toString("base64"),
		});
	}) as typeof fetch;
	const h = await setup({
		fetch: send,
		env: { [googleCloudTts.envRef]: "fixture-key" },
	});
	const settings = h.settings.get();
	const connection = settings.connections.find(
		(c) => c.kind === googleCloudTts.kind,
	)!;
	expect(settings.routes.tts.mode).toBe("larm-only");
	const list = await createConnectionModels(
		h.settings,
		{},
		{ fetch: send },
	).list(connection.id, freshSignal());
	expect(list?.models.map((model) => [model.id, model.displayName])).toEqual([
		[firstVoice, "AFixture"],
		[voice, "ZFixture"],
	]);
	const model = list!.models[1]!;
	const resourceId = crypto.randomUUID();
	settings.resources.push({
		id: resourceId,
		connectionId: connection.id,
		purpose: "tts",
		model: model.id,
		contextWindow: null,
		voice: model.speech!.voiceDefault,
		language: model.speech!.languageDefault!,
	});
	settings.routes.tts = {
		...settings.routes.tts,
		mode: "cloud-only",
		fallbackId: resourceId,
	};
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	const spoken = await h.inference.speak("読み上げの確認です。", freshSignal());
	expect(Buffer.from(spoken)).toEqual(Buffer.from(audio));
	expect(sent).toEqual([
		{
			input: { text: "読み上げの確認です。" },
			voice: { name: voice, languageCode: language, ssmlGender: "FEMALE" },
			audioConfig: { audioEncoding: Bun.which("ffmpeg") ? "MP3" : "LINEAR16" },
		},
	]);
});
