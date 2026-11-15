import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { registerSettings } from "..";
import { settingsSchema } from "../contracts";
import { cleanup, setup } from "./settings.fixture";

afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

const defaults = {
	structureResourceId: null,
	structureTimeoutMs: 8000,
	feedbackNear: 0.95,
	feedbackWeight: 2,
};

test("the router has defaults and older documents without router settings read the same", async () => {
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
		await h.settings.configureRouter({ structureTimeoutMs: 3500 }),
	).toEqual({ ...defaults, structureTimeoutMs: 3500 });
	const after = h.settings.get();
	expect(after.revision).toBe(before.revision + 1);
	expect(after.larm).toEqual(before.larm);
	expect(changed).toBe(1);
	await h.settings.configureRouter({ feedbackWeight: 0 });
	expect(h.settings.get().router).toEqual({
		...defaults,
		structureTimeoutMs: 3500,
		feedbackWeight: 0,
	});
});

test("an unknown mode, a field out of range or an unknown field is refused and changes nothing", async () => {
	const h = await setup();
	const before = h.settings.get();
	for (const input of [
		{ mode: "legacy" },
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
		body: JSON.stringify({ structureTimeoutMs: 1200, feedbackNear: 0.9 }),
	});
	expect(patch.status).toBe(200);
	expect(await patch.json()).toMatchObject({
		structureTimeoutMs: 1200,
		feedbackNear: 0.9,
	});
	expect(h.settings.get().router.feedbackNear).toBe(0.9);
	const invalid = await app.request("/api/settings/router", {
		method: "PATCH",
		body: "not json",
	});
	expect(invalid.status).toBe(400);
	expect(await invalid.json()).toEqual({ error: "invalid_router_settings" });
});

test("persisted settings keep decision and feedback settings when the reranker fields are retired", async () => {
	const h = await setup();
	const old = {
		...h.settings.get(),
		router: {
			...defaults,
			entry: "routeStructured",
			profile: "previous",
			accept: 0.7,
			feedbackNear: 0.85,
		},
	};
	await h.store.write((db) =>
		db
			.query("UPDATE settings_document SET document=? WHERE id=1")
			.run(JSON.stringify(old)),
	);
	expect(h.settings.get().router).toEqual({ ...defaults, feedbackNear: 0.85 });
});
