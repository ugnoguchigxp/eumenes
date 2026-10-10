import { test, expect } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import {
	createCapabilities,
	migrations,
	registerCapabilities,
	errorStatus,
} from "..";
import { sampleProfile } from "./requirements.test";
test("management API validates bodies, exposes CAS state and keeps requirement profiles out of executable catalog", async () => {
	const dir = mkdtempSync(join(tmpdir(), "requirement-api-")),
		store = openStore(join(dir, "db"), migrations),
		caps = createCapabilities(store),
		app = new Hono();
	app.onError((e, c) =>
		c.json(
			{ error: e.message },
			errorStatus[e.message as keyof typeof errorStatus] ?? 400,
		),
	);
	registerCapabilities(app, caps);
	try {
		const path = "/api/capabilities/requirements/test";
		const put = async (body: unknown) =>
			app.request(path, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		expect(
			(
				await put({
					expectedStateToken: null,
					data: { ...sampleProfile, backend: "web" },
				})
			).status,
		).toBe(400);
		const created = await put({
			expectedStateToken: null,
			data: sampleProfile,
		});
		expect(created.status).toBe(201);
		const p = await created.json();
		expect(
			(await put({ expectedStateToken: null, data: sampleProfile })).status,
		).toBe(409);
		expect(
			(await put({ expectedStateToken: p.stateToken, data: sampleProfile }))
				.status,
		).toBe(200);
		expect(
			(await app.request("/api/capabilities/requirements?limit=0")).status,
		).toBe(400);
		expect(
			(
				await put({
					expectedStateToken: null,
					data: { ...sampleProfile, title: "x".repeat(33000) },
				})
			).status,
		).toBe(413);
		expect(
			(await (await app.request("/api/capabilities/requirements")).json())
				.items,
		).toHaveLength(1);
		expect(caps.list().items).toHaveLength(0);
	} finally {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
