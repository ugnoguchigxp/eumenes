import { afterEach, expect, test } from "bun:test";
import { createSettings } from "..";
import { settingsSchema } from "../contracts";
import { cleanup, setup } from "./settings.fixture";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("old settings retain F implicitly and explicit always-on settings survive reopening", async () => {
	const h = await setup();
	const before = h.settings.get();
	expect(before.agency.runtime ?? "F").toBe("F");
	const settings = structuredClone(before);
	Object.assign(settings.agency, {
		runtime: "always-on",
		thinkResourceId: crypto.randomUUID(),
		speechIntervalSec: 60,
		thinkReasoning: "high",
	});
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.get().agency).toEqual(settings.agency);
	expect(reopened.get().routes).toEqual(before.routes);
	for (const speechIntervalSec of [0, 50, 601])
		expect(
			settingsSchema.safeParse({
				...settings,
				agency: { ...settings.agency, speechIntervalSec },
			}).success,
		).toBe(false);
});
