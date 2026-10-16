import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import sharp from "sharp";
import * as bmp from "bmp-ts";
import { createLarm } from "../api/domains/larm";
import { liveLarmSettings } from "./live-larm";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { harness } from "../api/application/toolchain/toolchain.fixture";

if (!process.argv.includes("--run")) throw new Error("image_live_requires_run");
const saved = liveLarmSettings();
const token = resolveLarmToken(process.env);
if (!saved.baseUrl || !token)
	throw new Error("saved_larm_connection_unconfigured");
const output = resolve("spec/verification/chat-image-attachments-2026-10-13");
mkdirSync(output, { recursive: true });
const events: unknown[] = [];
const live = createLarm({
	...saved,
	baseUrl: saved.baseUrl,
	voice: saved.voice ?? undefined,
	token,
	fetch: async (url, init) => {
		const path = new URL(String(url)).pathname;
		const r = await fetch(url, init);
		if (path.endsWith("/chat/completions/input-tokens") && r.ok) {
			const count = await r.clone().json();
			events.push({
				operation: "count",
				status: r.status,
				imageCount: count.imageCount,
				promptTokens: count.promptTokens,
				imageTokens: count.imageTokens,
				fits: count.fits,
				bootEpoch: count.bootEpoch,
				configRevision: count.configRevision,
			});
		} else if (path.endsWith("/chat/completions"))
			events.push({ operation: "generate", status: r.status });
		return r;
	},
});
const h = await harness({ model: live });
const report: Record<string, unknown> = {
	date: new Date().toISOString(),
	lane: "live",
	events,
	cases: [],
};
try {
	const settings = h.settings.get();
	const applied = await h.request("/api/settings/apply", {
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings: { ...settings, larm: saved },
		keys: [],
	});
	if (!applied.ok) throw new Error("test_settings_not_saved");
	const jpeg = await sharp({
		create: { width: 64, height: 48, channels: 3, background: "#ff0000" },
	})
		.jpeg()
		.toBuffer();
	const png = await sharp({
		create: { width: 64, height: 48, channels: 3, background: "#0000ff" },
	})
		.png()
		.toBuffer();
	const bitmap = bmp.encode({
		data: Buffer.from(
			Array.from({ length: 64 * 48 }, () => [255, 0, 220, 0]).flat(),
		),
		width: 64,
		height: 48,
		bitPP: 24,
	}).data;
	const ids: string[] = [];
	for (const [name, mime, bytes] of [
		["red.jpg", "image/jpeg", jpeg],
		["blue.png", "image/png", png],
		["green.bmp", "image/bmp", bitmap],
	] as const) {
		const form = new FormData();
		form.set("file", new File([new Uint8Array(bytes)], name, { type: mime }));
		const r = await h.app.request(
			`/api/conversations/main/attachments?requestId=${crypto.randomUUID()}`,
			{
				method: "POST",
				headers: {
					Authorization: "Bearer fixture-token-for-toolchain-browser",
				},
				body: form,
			},
		);
		if (!r.ok) throw new Error("live_upload_failed");
		const a = await r.json();
		ids.push(a.id);
		writeFileSync(`${output}/${name}`, bytes);
		report[`${mime}_uploaded`] = true;
	}
	for (const [label, text, attachmentIds] of [
		[
			"three-formats",
			"添付した3枚の画像の色を、添付順に教えてください。画像そのものを見て、日本語で短く答えてください。",
			ids,
		],
		[
			"history-resend",
			"さっきの3枚の画像は、それぞれ何色でしたか。添付順に短く答えてください。",
			[],
		],
		["image-only", "", [ids[0]!]],
		[
			"two-images",
			"今回添付した2枚の画像の色の違いを短く教えてください。",
			ids.slice(0, 2),
		],
	] as const) {
		const before = events.length;
		const submitted = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text,
			attachmentIds,
		});
		if (!submitted.ok) throw new Error("live_submit_failed");
		const run = await submitted.json();
		const terminal = await h.dialogue.waitForTerminal(run.id, {
			timeoutMs: 240000,
		});
		const answer = h.dialogue.answerText(run.id);
		const passed =
			terminal?.status === "completed" &&
			!!answer &&
			(label === "image-only"
				? /赤/.test(answer)
				: label === "two-images"
					? /赤/.test(answer) && /青/.test(answer)
					: /赤/.test(answer) && /青/.test(answer) && /緑/.test(answer));
		(report.cases as unknown[]).push({
			label,
			status: terminal?.status,
			error: terminal?.error,
			passed,
			answer,
			events: events.slice(before),
		});
		writeFileSync(`${output}/live.json`, JSON.stringify(report, null, 2));
		console.log(
			JSON.stringify({
				label,
				status: terminal?.status,
				error: terminal?.error,
				passed,
			}),
		);
		if (!passed) throw new Error("live_image_acceptance_failed");
	}
	report.passed = true;
} finally {
	await h.close();
	await live.close();
	writeFileSync(`${output}/live.json`, JSON.stringify(report, null, 2));
}
