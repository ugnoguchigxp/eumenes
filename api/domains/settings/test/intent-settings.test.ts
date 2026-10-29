import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerSettings } from "..";
import { settingsSchema } from "../contracts";
import { cleanup, setup } from "./settings.fixture";

/**
 * The user-intent judge's settings (the intent gate design, sections 5 and 7): `shadow` until changed, no profile
 * until saved, and changed on their own without touching the speaking-attitude judge's (LARM) settings.
 */
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

test("the judge starts in shadow without a profile, and an older document reads the same", async () => {
	const h = await setup();
	expect(h.settings.get().intent).toEqual({
		mode: "shadow",
		timeoutMs: 1500,
		searchScore: 0.6,
	});
	const older = structuredClone(h.settings.get()) as Record<string, unknown>;
	delete older.intent;
	expect(settingsSchema.parse(older).intent.mode).toBe("shadow");
});

test("a change of the judge's settings moves the revision and leaves the LARM settings as they were", async () => {
	const h = await setup();
	const before = h.settings.get();
	let changed = 0;
	h.settings.onChange(() => changed++);
	expect(
		await h.settings.configureIntent({ mode: "ruri", profile: "judge-p" }),
	).toEqual({
		mode: "ruri",
		profile: "judge-p",
		timeoutMs: 1500,
		searchScore: 0.6,
	});
	const after = h.settings.get();
	expect(after.revision).toBe(before.revision + 1);
	expect(after.larm).toEqual(before.larm);
	expect(changed).toBe(1);
	await h.settings.configureIntent({ mode: "legacy", searchScore: 0.75 });
	expect(h.settings.get().intent).toEqual({
		mode: "legacy",
		profile: "judge-p",
		timeoutMs: 1500,
		searchScore: 0.75,
	});
	await h.settings.configureIntent({ profile: null });
	expect(h.settings.get().intent.profile).toBeUndefined();
});

test("an unknown mode, a field out of range or an unknown field is refused and changes nothing", async () => {
	const h = await setup();
	const before = h.settings.get();
	for (const input of [
		{ mode: "always" },
		{ searchScore: 1.5 },
		{ timeoutMs: 10 },
		{ judge: "attitude" },
		"shadow",
	])
		await expect(h.settings.configureIntent(input)).rejects.toThrow(
			"invalid_intent_settings",
		);
	expect(h.settings.get()).toEqual(before);
});

test("the API reads and changes the judge's settings", async () => {
	const h = await setup();
	const app = new Hono();
	registerSettings(app, h.settings);
	expect(await (await app.request("/api/settings/intent")).json()).toEqual({
		mode: "shadow",
		timeoutMs: 1500,
		searchScore: 0.6,
	});
	const put = await app.request("/api/settings/intent", {
		method: "PUT",
		body: JSON.stringify({ mode: "ruri", timeoutMs: 800 }),
	});
	expect(put.status).toBe(200);
	expect(await put.json()).toMatchObject({ mode: "ruri", timeoutMs: 800 });
	expect(h.settings.get().intent.mode).toBe("ruri");
});
