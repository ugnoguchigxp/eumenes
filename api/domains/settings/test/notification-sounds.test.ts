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
