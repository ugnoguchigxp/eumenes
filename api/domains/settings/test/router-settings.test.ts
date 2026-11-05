import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerSettings } from "..";
import { settingsSchema } from "../contracts";
import { cleanup, setup } from "./settings.fixture";

/**
 * The router's settings (spec router-package-integration 2026-11-04 §3): no profile until saved, the package's
 * `route` entry, changed on their own without touching the speaking-attitude judge's settings.
 */
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

const defaults = {
	entry: "route" as const,
	structureResourceId: null,
	structureTimeoutMs: 8000,
	timeoutMs: 2000,
	accept: 0.6,
	low: 0.3,
	margin: 0.15,
	approve: 0.85,
	multi: 0.5,
	feedbackNear: 0.95,
	feedbackWeight: 2,
};

test("the router starts without a profile, and an older document reads the same", async () => {
	const h = await setup();
	expect(h.settings.get().router).toEqual(defaults);
	const older = structuredClone(h.settings.get()) as Record<string, unknown>;
	delete older.router;
	expect(settingsSchema.parse(older).router).toEqual(defaults);
});

test("a change of the router's settings moves the revision, notifies once and leaves the others as they were", async () => {
	const h = await setup();
	const before = h.settings.get();
	let changed = 0;
	h.settings.onChange(() => changed++);
	expect(
		await h.settings.configureRouter({
			profile: "router-p",
			entry: "routeStructured",
		}),
	).toEqual({
		...defaults,
		profile: "router-p",
		entry: "routeStructured",
	});
	const after = h.settings.get();
	expect(after.revision).toBe(before.revision + 1);
	expect(after.larm).toEqual(before.larm);
	expect(changed).toBe(1);
	await h.settings.configureRouter({ accept: 0.7, feedbackWeight: 0 });
	expect(h.settings.get().router).toEqual({
		...defaults,
		profile: "router-p",
		entry: "routeStructured",
		accept: 0.7,
		feedbackWeight: 0,
	});
	await h.settings.configureRouter({ profile: null });
	expect(h.settings.get().router.profile).toBeUndefined();
});

test("an unknown mode, a field out of range or an unknown field is refused and changes nothing", async () => {
	const h = await setup();
	const before = h.settings.get();
	for (const input of [
		{ mode: "legacy" },
		// The router has no mode: it decides every utterance turn (a saved one is dropped at startup).
		{ mode: "on" },
		{ entry: "direct" },
		{ structureTimeoutMs: 500 },
		{ structureResourceId: "not-a-uuid" },
		// A structure model must be a saved LLM resource.
		{ structureResourceId: "00000000-0000-4000-8000-000000000001" },
		{ accept: 1.5 },
		{ low: -0.1 },
		{ timeoutMs: 10 },
		{ timeoutMs: 20000 },
		{ feedbackWeight: 6 },
		{ profile: "" },
		{ threshold: 0.5 },
		"on",
		// The lines keep their order (low ≤ accept ≤ approve), alone or with the saved ones.
		{ approve: 0.5 },
		{ low: 0.7 },
		{ accept: 0.2, low: 0.3 },
	])
		await expect(h.settings.configureRouter(input)).rejects.toThrow(
			"invalid_router_settings",
		);
	expect(h.settings.get()).toEqual(before);
});

test("the API reads and changes the router's settings", async () => {
	const h = await setup();
	const app = new Hono();
	// The application maps `invalid_*` codes to 400; here the code itself is the answer.
	app.onError((error, c) => c.json({ error: error.message }, 400));
	registerSettings(app, h.settings);
	const read = await app.request("/api/settings/router");
	expect(read.headers.get("Cache-Control")).toBe("no-store");
	expect(await read.json()).toEqual(defaults);
	const patch = await app.request("/api/settings/router", {
		method: "PATCH",
		body: JSON.stringify({ timeoutMs: 800, profile: "router-p" }),
	});
	expect(patch.status).toBe(200);
	expect(await patch.json()).toMatchObject({
		timeoutMs: 800,
		profile: "router-p",
	});
	expect(h.settings.get().router.profile).toBe("router-p");
	const invalid = await app.request("/api/settings/router", {
		method: "PATCH",
		body: "not json",
	});
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toEqual({ error: "invalid_router_settings" });
});
