import { afterEach, expect, test } from "bun:test";
import { createSettings } from "..";
import { settingsSchema } from "../contracts";
import { cleanup, setup } from "./settings.fixture";
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("the agenda's settings survive reopening, and an old document's agency.runtime is dropped on read", async () => {
	const h = await setup();
	const before = h.settings.get();
	const settings = structuredClone(before);
	Object.assign(settings.agency, {
		thinkResourceId: crypto.randomUUID(),
		speechIntervalSec: 60,
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
	// A document saved while the F host still existed carries the removed switch.
	const old = JSON.parse(JSON.stringify(reopened.get())) as Record<string, any>;
	old.agency.runtime = "F";
	await h.store.write((db) =>
		db
			.query("UPDATE settings_document SET document=? WHERE id=1")
			.run(JSON.stringify(old)),
	);
	const again = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(again.get().agency).not.toHaveProperty("runtime");
	expect(again.get().agency).toEqual(settings.agency);
});

test("the saved thinking level defaults to low, survives reopening, and an old document's agency.thinkReasoning is dropped on read", async () => {
	const h = await setup();
	expect(h.settings.get().general.reasoningEffort).toBe("low");
	const settings = structuredClone(h.settings.get());
	settings.general.reasoningEffort = "xhigh";
	await h.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings,
		keys: [],
	});
	expect(
		(await createSettings(h.store, { dbPath: h.dbPath, env: {} })).get().general
			.reasoningEffort,
	).toBe("xhigh");
	// A document saved before the level existed carries the removed background level and no general level.
	const old = JSON.parse(JSON.stringify(h.settings.get())) as Record<
		string,
		any
	>;
	old.agency.thinkReasoning = "high";
	delete old.general.reasoningEffort;
	await h.store.write((db) =>
		db
			.query("UPDATE settings_document SET document=? WHERE id=1")
			.run(JSON.stringify(old)),
	);
	const reopened = await createSettings(h.store, { dbPath: h.dbPath, env: {} });
	expect(reopened.get().general.reasoningEffort).toBe("low");
	expect(reopened.get().agency).not.toHaveProperty("thinkReasoning");
	for (const bad of ["", "Low High", "x".repeat(65)])
		expect(
			settingsSchema.safeParse({
				...settings,
				general: { ...settings.general, reasoningEffort: bad },
			}).success,
		).toBe(false);
});
