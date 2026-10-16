import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../../infrastructure/sqlite";
import {
	createGoogleAccounts,
	registerGoogleAccounts,
	migrations,
	type GoogleProvider,
} from "../../domains/google-accounts";
import { createApp } from "../app";
import { createGoogleAccountsAdapter } from "./google-accounts-adapter";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of cleanups.splice(0)) await f();
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "google-http-test-"));
	const store = openStore(
		join(dir, "db"),
		migrations.map((m) => ({ ...m, after: [] })),
	);
	cleanups.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	let codeExchanges = 0;
	let keyAvailable = true;
	const provider: GoogleProvider = {
		identity: "fixture",
		authorization: ({ state }) => `https://accounts.google.com/?state=${state}`,
		async exchange() {
			codeExchanges++;
			return {
				profile: { sub: "person", email: "person@example.com", name: "Person" },
				tokens: {
					refresh: "secret-refresh",
					access: "secret-access",
					expires: Date.now() + 3600_000,
				},
			};
		},
		async refresh() {
			throw new Error("unused");
		},
		async revoke() {},
	};
	const service = createGoogleAccounts(store, {
		key: () => (keyAvailable ? new Uint8Array(32).fill(1) : undefined),
		provider,
	});
	const app = createApp({
		token: "test-token",
		origin: "http://localhost:5173",
		modules: [{ mount: (app) => registerGoogleAccounts(app, service) }],
	});
	const post = (action: string, expectedRevision = service.view().revision) =>
		app.request(`/api/google-accounts/${action}`, {
			method: "POST",
			headers: {
				Authorization: "Bearer test-token",
				"Content-Type": "application/json",
				Origin: "http://localhost:5173",
			},
			body: JSON.stringify({ expectedRevision }),
		});
	return {
		app,
		post,
		service,
		store,
		exchanges: () => codeExchanges,
		loseKey: () => {
			keyAvailable = false;
		},
	};
}
test("OAuth callback is cookie-bound; API stays authenticated and rejects foreign origins", async () => {
	const h = fixture();
	expect((await h.app.request("/api/google-accounts")).status).toBe(401);
	expect(
		(
			await h.app.request("/api/google-accounts/connect", {
				method: "POST",
				headers: {
					Authorization: "Bearer test-token",
					Origin: "https://evil.example",
				},
			})
		).status,
	).toBe(403);
	const start = await h.post("connect");
	expect(start.status).toBe(200);
	const cookie = start.headers.get("set-cookie")!;
	expect(cookie).toContain("HttpOnly");
	expect(cookie).toContain("SameSite=Lax");
	expect(cookie).toContain("Path=/oauth/google/callback");
	const { url } = await start.json();
	const state = new URL(url).searchParams.get("state");
	const path = `/oauth/google/callback?state=${state}&code=secret-code`;
	expect((await h.app.request(path)).headers.get("Location")).toBe(
		"/oauth/google/result?status=failed",
	);
	expect(h.exchanges()).toBe(0);
	const callback = await h.app.request(path, {
		headers: { Cookie: cookie.split(";")[0]! },
	});
	expect(callback.status).toBe(303);
	expect(callback.headers.get("Location")).toBe(
		"/oauth/google/result?status=connected",
	);
	expect(callback.headers.get("Referrer-Policy")).toBe("no-referrer");
	expect(callback.headers.get("Cache-Control")).toBe("no-store");
	expect(h.service.view().status).toBe("connected");
	expect(
		(
			await h.app.request(path, { headers: { Cookie: cookie.split(";")[0]! } })
		).headers.get("Location"),
	).toContain("failed");
	expect(h.exchanges()).toBe(1);
	const disconnected = await h.post("disconnect");
	expect(disconnected.status).toBe(200);
	expect(h.service.view().status).toBe("disconnected");
});
test("registered artifact exposes no AI operations, bindings, or secret-bearing source", async () => {
	const h = fixture();
	const adapter = createGoogleAccountsAdapter(h.service);
	expect(adapter.describe().operations.size).toBe(0);
	expect(() =>
		h.store.read((db) =>
			adapter.invokeInTransaction(db, {
				operationName: "connect",
				input: {},
				requestId: "id",
				issuedAt: new Date().toISOString(),
				origin: { kind: "ui", scope: "main", actionRequestId: "id" },
			}),
		),
	).toThrow("capability_unavailable");
	const source = h.store.read((db) =>
		adapter.sourceInTransaction(
			db,
			"query:google-accounts.status@1",
			undefined,
		),
	);
	expect(source?.data).toEqual(h.service.view());
	expect(JSON.stringify(source)).not.toMatch(
		/sealed|tokens|refresh|clientSecret|verifier/,
	);
});
test("callback denial is reflected in the settings state without credentials in result HTML", async () => {
	const h = fixture();
	const start = await h.post("connect");
	const { url } = await start.json();
	const response = await h.app.request(
		`/oauth/google/callback?state=${new URL(url).searchParams.get("state")}&error=access_denied&error_description=private-description`,
		{ headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0]! } },
	);
	expect(h.service.view().result).toBe("cancelled");
	expect(h.exchanges()).toBe(0);
	const result = await h.app.request(response.headers.get("Location")!);
	expect(await result.text()).not.toContain("private-description");
});

test("stale callback cannot clear the browser cookie for a newer authorization", async () => {
	const h = fixture();
	const old = await h.post("connect");
	const oldUrl = (await old.json()).url;
	const current = await h.post("connect");
	const currentCookie = current.headers.get("set-cookie")!.split(";")[0]!;
	expect(currentCookie.split("=")[0]).not.toBe(
		old.headers.get("set-cookie")!.split("=")[0],
	);
	const stale = await h.app.request(
		`/oauth/google/callback?state=${new URL(oldUrl).searchParams.get("state")}&code=stale`,
		{ headers: { Cookie: currentCookie } },
	);
	expect(stale.headers.get("set-cookie")).toBeNull();
	expect(h.exchanges()).toBe(0);
	const currentUrl = (await current.json()).url;
	const valid = await h.app.request(
		`/oauth/google/callback?state=${new URL(currentUrl).searchParams.get("state")}&code=current`,
		{ headers: { Cookie: currentCookie } },
	);
	expect(valid.headers.get("Location")).toContain("connected");
});

test("unreadable account returns a sanitized non-cacheable error instead of disconnected", async () => {
	const h = fixture();
	await h.post("connect");
	h.loseKey();
	const response = await h.app.request("/api/google-accounts", {
		headers: { Authorization: "Bearer test-token" },
	});
	expect(response.status).toBe(503);
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(await response.json()).toEqual({ error: "account_unavailable" });
});
