import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { Run } from "../../dialogue/contracts";
import type { InferencePort } from "../../inference";
import {
	createVoiceDialogue,
	migrations as voiceMigrations,
	registerVoiceDialogue,
} from "..";
import { insert } from "../repository";
import { errorStatus } from "../contracts";

const PLAYING = crypto.randomUUID();
const OTHER = crypto.randomUUID();

test("an automatic speech is claimed once, by the playback screen, and only for Eumenes' speaker", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-speech-claims-"));
	const store = openStore(join(dir, "db.sqlite3"), voiceMigrations);
	const runs = new Map<string, Run>();
	const completed = (id: string, extra: Partial<Run> = {}) =>
		runs.set(id, {
			id,
			conversationId: "main",
			status: "completed",
			utteranceId: null,
			specialistSessionId: null,
			...extra,
		} as Run);
	let session: { id: string; state: string } | null = null;
	const dialogue = {
		get: (id: string) => runs.get(id) ?? null,
		specialistSession: () => session,
	} as unknown as DialogueService;
	const port = {
		isPlaybackScreen: (id: string) => id === PLAYING,
	} as unknown as InferencePort;
	const app = new Hono();
	app.onError((error) => {
		const code = error.message as keyof typeof errorStatus;
		return Response.json({ error: code }, { status: errorStatus[code] ?? 500 });
	});
	registerVoiceDialogue(app, createVoiceDialogue(store, dialogue, port));
	const claim = async (screenId: string, sourceKey: string) => {
		const response = await app.request("/api/voice/speech-claims", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ screenId, sourceKey }),
		});
		return [response.status, await response.json()] as const;
	};
	try {
		completed("answer");
		expect(await claim(OTHER, "run:answer:answer")).toEqual([
			409,
			{ error: "not_playback_screen" },
		]);
		expect(await claim(PLAYING, "run:answer:answer")).toEqual([
			200,
			{ claimed: true },
		]);
		expect(await claim(PLAYING, "run:answer:answer")).toEqual([
			409,
			{ error: "speech_already_claimed" },
		]);
		expect(await claim(PLAYING, "message:agency:main.t1-1")).toEqual([
			200,
			{ claimed: true },
		]);
		expect(await claim(PLAYING, "notice:todo:notice-1")).toEqual([
			200,
			{ claimed: true },
		]);

		// A voice turn's answer is spoken in chunks by the screen holding the microphone.
		const utteranceId = crypto.randomUUID();
		completed("voiced", { utteranceId });
		await store.write((db) =>
			insert(
				db,
				{
					utteranceId,
					sessionId: crypto.randomUUID(),
					generation: 1,
					sequence: 1,
					status: "completed",
					text: "質問",
					runId: "voiced",
					error: null,
					revision: 1,
				},
				new Date().toISOString(),
			),
		);
		expect(await claim(PLAYING, "run:voiced:answer")).toEqual([
			409,
			{ error: "speech_owned_by_voice_turn" },
		]);

		// A specialist is read only while the conversation is switched to it.
		completed("specialist", { specialistSessionId: "s1" });
		session = { id: "s1", state: "active" };
		expect(await claim(PLAYING, "run:specialist:answer")).toEqual([
			200,
			{ claimed: true },
		]);
		completed("late", { specialistSessionId: "s1" });
		session = null;
		expect(await claim(PLAYING, "run:late:announcement:2")).toEqual([
			409,
			{ error: "speech_not_speaker" },
		]);
		runs.set("running", {
			...runs.get("answer")!,
			id: "running",
			status: "running",
		});
		expect(await claim(PLAYING, "run:running:answer")).toEqual([
			409,
			{ error: "speech_not_speaker" },
		]);
		expect((await claim(PLAYING, "anything else"))[0]).toBe(400);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
