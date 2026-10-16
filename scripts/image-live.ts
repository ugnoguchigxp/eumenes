import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLarmPlayground, type LarmPort } from "../api/domains/larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createLiveLarm, liveLarmSettings } from "./live-larm";
if (!process.argv.includes("--run"))
	throw new Error(
		"use --run; generation is one attempt without automatic retry",
	);
const libraryOnly = process.argv.includes("--library-only");
const saved = liveLarmSettings();
const live = createLiveLarm();
const out = resolve(
	"verification-reports/image-toolchain",
	new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(out, { recursive: true });
const events: unknown[] = [];
function record(value: Record<string, unknown>) {
	const event = { at: new Date().toISOString(), ...value };
	events.push(event);
	writeFileSync(`${out}/events.json`, JSON.stringify(events, null, 2), {
		mode: 0o600,
	});
	console.log(JSON.stringify(event));
}
const model: LarmPort = {
	...live,
	answer: async (messages, signal, options) => {
		const value = await live.answer(
			messages,
			signal,
			options?.tools?.length
				? {
						...options,
						onToolCalls: (calls) => {
							record({
								stage: "routing",
								calls: calls.map((c) => ({
									name: c.name,
									arguments: c.arguments,
								})),
							});
							options.onToolCalls?.(calls);
						},
					}
				: options,
		);
		if (messages[0]?.content.includes("OUTPUT_SCHEMA="))
			record({ stage: "plan", value });
		else if (value) record({ stage: "answer", value });
		return value;
	},
	answerStream: undefined,
};
let posts = 0;
const gateway = () =>
	createLarmPlayground({
		...saved,
		baseUrl: saved.baseUrl ?? undefined,
		voice: saved.voice ?? undefined,
		token: resolveLarmToken(process.env),
		fetch: (async (url, init) => {
			const path = new URL(String(url)).pathname;
			if (init?.method === "POST" && path === "/v1/images/generations") {
				if (libraryOnly || posts++)
					throw new Error("live_generation_not_allowed");
				record({
					stage: "generation_request",
					body: JSON.parse(String(init.body)),
				});
			}
			const r = await fetch(url, init);
			record({ stage: "http", path, status: r.status });
			return r;
		}) as typeof fetch,
	});
const h = await harness({ model, imageGateway: gateway });
try {
	const settings = h.settings.get();
	const response = await h.request("/api/settings/apply", {
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings: { ...settings, larm: saved },
		keys: [],
	});
	if (!response.ok) throw new Error("test_settings_not_saved");
	const text = libraryOnly
		? "過去に生成した画像の一覧を開いてください。新しい画像は作らないでください。"
		: "朝の穏やかな海と白い灯台を、水彩画で1枚生成してください。512×384px、PNG、シード42。文字は入れないでください。";
	const submitted = await (
		await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text,
		})
	).json();
	record({ stage: "accepted", runId: submitted.id });
	const run = await h.dialogue.waitForTerminal(submitted.id, {
		timeoutMs: 900000,
	});
	const item = h.image!.list("main")[0];
	record({
		stage: "result",
		runId: run?.id,
		status: run?.status,
		image: item,
		posts,
		answer: h.dialogue.answerText(submitted.id),
	});
	if (
		run?.status !== "completed" ||
		item?.state !== "completed" ||
		item.action !== (libraryOnly ? "library" : "generate")
	)
		throw new Error("live_image_failed");
	const library = await h.image!.library().list(AbortSignal.timeout(15000));
	record({ stage: "library", count: library.images.length });
	if (item.artifactId) {
		const content = await h.image!.content(
			item.artifactId,
			AbortSignal.timeout(30000),
		);
		writeFileSync(
			`${out}/image.${content.mime === "image/png" ? "png" : "webp"}`,
			content.bytes!,
			{ mode: 0o600 },
		);
		record({
			stage: "content",
			artifactId: item.artifactId,
			bytes: content.bytes!.length,
			mime: content.mime,
		});
	}
} finally {
	await h.close();
	await live.close();
}
