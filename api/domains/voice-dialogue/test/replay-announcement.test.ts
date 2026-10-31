import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { Run } from "../../dialogue/contracts";
import type { InferencePort } from "../../inference";
import { createVoiceDialogue } from "..";
import { Hono } from "hono";
import { registerVoiceDialogue } from "..";

test("replay accepts only clauses of a completed run's saved announcement when no final answer exists", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-replay-announcement-"));
	const store = openStore(join(dir, "db.sqlite3"), []);
	let run = {
		id: "handover",
		conversationId: "main",
		status: "completed",
		answerMessageId: null,
		announcement: "資料の確認を進めます。",
	} as Run;
	let calls = 0;
	const wav = new Uint8Array(44);
	const dialogue = {
		get: () => run,
		answerText: () => null,
		answerContext: () => null,
	} as unknown as DialogueService;
	const port = {
		speak: async () => {
			calls++;
			return wav;
		},
	} as unknown as InferencePort;
	const service = createVoiceDialogue(store, dialogue, port);
	const app = new Hono();
	registerVoiceDialogue(app, service);
	const request = (text: string) =>
		app.request("/api/voice/replay/audio", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text, runId: run.id }),
		});
	try {
		const valid = await request(run.announcement!);
		expect(valid.status).toBe(200);
		expect(new Uint8Array(await valid.arrayBuffer())).toEqual(wav);
		expect(calls).toBe(1);
		const unrelated = await request("保存されていない文です。");
		expect(unrelated.status).toBe(502);
		expect(await unrelated.json()).toEqual({ error: "replay_text_invalid" });
		for (const status of ["running", "cancelled", "failed"] as const) {
			run = { ...run, status };
			const invalid = await request(run.announcement!);
			expect(invalid.status).toBe(502);
			expect(await invalid.json()).toEqual({ error: "replay_text_invalid" });
		}
		run = { ...run, status: "completed", answerMessageId: "final-answer" };
		const missingFinal = await request(run.announcement!);
		expect(missingFinal.status).toBe(502);
		expect(await missingFinal.json()).toEqual({ error: "replay_text_invalid" });
		expect(calls).toBe(1);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true });
	}
});
