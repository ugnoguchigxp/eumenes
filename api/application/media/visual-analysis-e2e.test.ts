import { expect, test } from "bun:test";
import { harness } from "../toolchain/toolchain.fixture";
import { CONVERSATION_DEFAULT_PRINCIPAL as owner } from "../../domains/conversation/contracts";
import {
	visualImage,
	visualResult,
} from "../../domains/larm/test/visual-perception.fixture";
import type { PerceptionPort } from "../../domains/larm";
import { waitFor } from "../../infrastructure/wait-for";
test("OCR and recognition detail analysis share one queue resource and the real authenticated API", async () => {
	let concurrent = 0,
		maxConcurrent = 0,
		calls = 0;
	const port: PerceptionPort = {
		version: () => "fixture",
		release: async () => {},
		perceive: async (_image, options, signal, progress) => {
			calls++;
			concurrent++;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			try {
				await progress("connection", `fixture-${calls}`);
				await progress("running");
				await Bun.sleep(20);
				signal.throwIfAborted();
				return {
					result: await visualResult(options.task),
					waitingMs: 1,
					inferenceMs: 20,
					elapsedMs: 21,
					releaseConfirmed: true,
				};
			} finally {
				concurrent--;
				await progress("released");
			}
		},
	};
	const h = await harness({
		visual: () => port,
		settingsEnv: { LARM_API_TOKEN: "fixture" },
		ocrFetcher: (async () =>
			Response.json({
				kind: "image",
				model: "fixture",
				width: 8,
				height: 6,
				text: "原文",
				lines: [],
			})) as unknown as typeof fetch,
		recognitionFetcher: (async () =>
			Response.json({
				kind: "image",
				model: "fixture",
				width: 8,
				height: 6,
				objects: [],
			})) as unknown as typeof fetch,
	});
	try {
		await h.settings.configureOcr({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:9",
		});
		await h.settings.configureObjectRecognition({
			expectedRevision: 0,
			baseUrl: "http://127.0.0.1:9",
			credentialSource: "larm",
		});
		const image = await visualImage();
		const file = () =>
			new File([image.bytes], "source.png", { type: "image/png" });
		const o = await h.ocr!.upload(owner, "main", file(), crypto.randomUUID());
		const r = await h.objectRecognition!.upload(
			owner,
			"main",
			file(),
			crypto.randomUUID(),
		);
		await waitFor(
			() =>
				h.ocr!.get(owner, o.id).state === "completed" &&
				h.objectRecognition!.get(owner, r.id).state === "completed",
		);
		const targets = [
			{ domain: "ocr", source: h.ocr!.get(owner, o.id) },
			{
				domain: "object-recognition",
				source: h.objectRecognition!.get(owner, r.id),
			},
		];
		const ids: string[] = [];
		for (const { domain, source } of targets) {
			const id = crypto.randomUUID();
			ids.push(id);
			const path = `/api/${domain}/${source.id}/analyses`;
			expect(
				(
					await h.app.request(path, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: "{}",
					})
				).status,
			).toBe(401);
			const res = await h.request(path, {
				requestId: id,
				conversationId: "main",
				expectedRevision: source.revision,
				task: "describe",
				query: "説明",
			});
			expect(res.status).toBe(202);
			expect((await res.json()).state).toBe("queued");
		}
		await waitFor(async () => {
			const results = await Promise.all(
				targets.map(
					async (t, i) =>
						(
							await (
								await h.request(
									`/api/${t.domain}/${t.source.id}/analyses/${ids[i]}?conversationId=main`,
								)
							).json()
						).state,
				),
			);
			return results.every((s) => s === "completed");
		});
		expect(maxConcurrent).toBe(1);
		expect(calls).toBe(2);
		for (const [i, t] of targets.entries()) {
			const response = await h.request(
				`/api/${t.domain}/${t.source.id}/analyses/${ids[i]}?conversationId=main`,
			);
			const v = await response.json();
			expect(v.releaseConfirmed).toBe(true);
			expect(v.result.response).toContain("<script>");
			expect(JSON.stringify(v)).not.toContain("credential");
			expect(
				(
					await h.request(
						`/api/${t.domain}/${t.source.id}/analyses/${ids[i]}?conversationId=other`,
					)
				).status,
			).toBe(404);
		}
	} finally {
		await h.close();
	}
});
