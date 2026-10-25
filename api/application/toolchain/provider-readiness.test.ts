import { afterEach, expect, test } from "bun:test";
import { independent } from "../../domains/larm/test/provider-readiness.fixture";
import { setup, cleanup } from "../../domains/inference/test/inference.fixture";
import { freshSignal } from "../../domains/larm/test/larm.fixture";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

for (const readiness of ["ready", "failed", "probing"] as const)
	test(`real adapter through inference: ASR ${readiness} chooses cloud only on its own failure/deadline`, async () => {
		const f = independent();
		f.readiness.asr = readiness;
		f.readiness.llm = "failed";
		f.status("failed");
		const h = await setup({
			localTranscribe: f.larm.transcribe.bind(f.larm),
			localMs: readiness === "probing" ? 30 : undefined,
		});
		try {
			const text = await h.inference.transcribe(
				new Uint8Array(44),
				freshSignal(),
			);
			expect(text).toBe(readiness === "ready" ? "こんにちは" : "音声入力");
			expect(
				h.calls.filter((url) => url.endsWith("audio/transcriptions")),
			).toHaveLength(readiness === "ready" ? 0 : 1);
			expect((await f.larm.speak("確認", freshSignal())).length).toBe(44);
			expect(f.deleted).toEqual([]);
		} finally {
			await f.larm.close();
		}
	});
