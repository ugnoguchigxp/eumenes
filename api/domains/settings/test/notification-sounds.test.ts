import { afterEach, expect, test } from "bun:test";
import { createSettings } from "..";
import { settingsSchema } from "../contracts";
import { notificationSoundIds } from "../contracts/notification-sounds";
import { cleanup, setup } from "./settings.fixture";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
test("notification choice persists across reopen; old documents and only registered IDs are accepted", async () => {
	const h = await setup();
	const original = h.settings.get();
	expect(
		settingsSchema.parse(original).voice.notificationSound,
	).toBeUndefined();
	for (const notificationSound of notificationSoundIds) {
		const settings = h.settings.get();
		settings.voice.notificationSound = notificationSound;
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		const reopened = await createSettings(h.store, {
			dbPath: h.dbPath,
			env: {},
		});
		expect(reopened.get().voice.notificationSound).toBe(notificationSound);
		expect(reopened.get().routes).toEqual(original.routes);
	}
	expect(
		settingsSchema.safeParse({
			...original,
			voice: { ...original.voice, notificationSound: "../custom.wav" },
		}).success,
	).toBe(false);
});

test("completion voice is optional for old settings, persists independently and rejects arbitrary assets", async () => {
	const h = await setup();
	const original = h.settings.get();
	expect(settingsSchema.parse(original).voice.completionVoice).toBeUndefined();
	for (const completionVoice of [
		"none",
		"task-completed-ja-male",
		"task-completed-en-male",
	] as const) {
		const settings = h.settings.get();
		settings.voice.completionVoice = completionVoice;
		await h.settings.apply({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
		const reopened = await createSettings(h.store, {
			dbPath: h.dbPath,
			env: {},
		});
		expect(reopened.get().voice.completionVoice).toBe(completionVoice);
		expect(reopened.get().voice.notificationSound).toBe(
			original.voice.notificationSound,
		);
		expect(reopened.get().larm).toEqual(original.larm);
	}
	expect(
		settingsSchema.safeParse({
			...original,
			voice: {
				...original.voice,
				completionVoice: "https://outside.test/voice.wav",
			},
		}).success,
	).toBe(false);
});
