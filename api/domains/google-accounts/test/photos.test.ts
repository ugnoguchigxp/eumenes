import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createGoogleAccounts } from "../service";
import { migrations, read } from "../repository";
import {
	PHOTOS_SCOPE,
	type Authorization,
	type GoogleProvider,
} from "../contracts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0)) await fn();
});
async function setup(grant = true) {
	const dir = mkdtempSync(join(tmpdir(), "google-photos-test-"));
	const store = openStore(
		join(dir, "db"),
		migrations.map((m) => ({ ...m, after: [] })),
	);
	cleanups.push(async () => {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	let now = Date.now(),
		auth!: Authorization,
		ready = false,
		badHost = false,
		video = false;
	let release: (() => Promise<void>) | undefined;
	const calls: { path: string; method: string }[] = [];
	const provider: GoogleProvider = {
		identity: "fixture-provider",
		authorization(a) {
			auth = a;
			return "https://accounts.google.com/";
		},
		async exchange() {
			return {
				profile: { sub: "one", name: "test", email: "test@example.com" },
				tokens: {
					access: "private-access",
					refresh: "private-refresh",
					expires: now + 3600_000,
					scopes: grant ? [PHOTOS_SCOPE] : [],
				},
			};
		},
		async refresh() {
			throw new Error("not_needed");
		},
		async revoke() {},
	};
	const fetcher = (async (url, init) => {
		const u = new URL(String(url));
		const method = init?.method ?? "GET";
		calls.push({ path: u.pathname, method });
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer private-access",
		);
		expect(init?.redirect).toBe("error");
		if (u.hostname.endsWith("googleusercontent.com")) {
			await release?.();
			return new Response(new Uint8Array([1, 2, 3]), {
				headers: { "Content-Type": "image/jpeg" },
			});
		}
		if (method === "DELETE") return new Response(null, { status: 204 });
		if (u.pathname === "/v1/mediaItems")
			return Response.json({
				mediaItems: [
					{
						id: "item-one",
						type: video ? "VIDEO" : "PHOTO",
						mediaFile: {
							baseUrl: badHost
								? "https://evil.example/private"
								: "https://lh3.googleusercontent.com/private",
							mimeType: "image/jpeg",
							filename: "private-photo.jpg",
						},
					},
				],
			});
		if (method === "POST")
			expect(JSON.parse(String(init?.body))).toEqual({
				pickingConfig: { maxItemCount: "1" },
			});
		return Response.json({
			id: "google-session",
			pickerUri: "https://photos.google.com/picker/fixture",
			expireTime: new Date(now + 600_000).toISOString(),
			mediaItemsSet: ready,
			pollingConfig: { pollInterval: "2s", timeoutIn: "300s" },
		});
	}) as typeof fetch;
	const service = createGoogleAccounts(store, {
		key: () => new Uint8Array(32).fill(8),
		provider,
		now: () => now,
		fetch: fetcher,
	});
	const flow = await service.begin(service.view().revision, true);
	await service.finish({
		state: auth.state,
		browser: flow.browser,
		code: "private-code",
	});
	return {
		service,
		store,
		calls,
		select: () => {
			ready = true;
			now += 2000;
		},
		advance: (ms: number) => {
			now += ms;
		},
		badHost: () => {
			badHost = true;
		},
		video: () => {
			video = true;
		},
		block: (fn: () => Promise<void>) => {
			release = fn;
		},
	};
}
const signal = new AbortController().signal;
test("Photos needs the explicit grant, observes the polling interval, and exposes only selected same-origin thumbnails", async () => {
	const denied = await setup(false);
	await expect(denied.service.photos.begin(signal)).rejects.toThrow(
		"photos_authorization_required",
	);
	const h = await setup();
	const p = await h.service.photos.begin(signal);
	expect(h.service.view().photosAuthorized).toBe(true);
	expect(await h.service.photos.read(p.handle, signal)).toMatchObject({
		status: "pending",
		pollAfterMs: 2000,
	});
	expect(h.calls).toHaveLength(1);
	h.select();
	const selected = await h.service.photos.read(p.handle, signal);
	expect(selected.status).toBe("ready");
	expect(selected.items[0]?.thumbnailUrl).toStartWith(
		"/api/google-accounts/photos/",
	);
	expect(JSON.stringify(selected)).not.toContain("googleusercontent");
	expect(JSON.stringify(selected)).not.toContain("private-photo");
	const file = await h.service.photos.file(p.handle, "item-one", signal);
	expect(file.type).toBe("image/jpeg");
	expect(JSON.stringify(h.store.read(read))).not.toContain("private-access");
	await h.service.photos.cancel(p.handle, signal);
	await expect(
		h.service.photos.file(p.handle, "item-one", signal),
	).rejects.toThrow("photos_session_changed");
	expect(h.calls.at(-1)).toMatchObject({ method: "DELETE" });
});
test("Photos rejects videos, hostile download origins and expired sessions", async () => {
	const video = await setup();
	const v = await video.service.photos.begin(signal);
	video.select();
	video.video();
	await expect(video.service.photos.read(v.handle, signal)).rejects.toThrow();
	const host = await setup();
	const p = await host.service.photos.begin(signal);
	host.select();
	host.badHost();
	await host.service.photos.read(p.handle, signal);
	await expect(
		host.service.photos.file(p.handle, "item-one", signal),
	).rejects.toThrow("photos_response_invalid");
	expect(host.calls).toHaveLength(3);
	host.advance(600_001);
	await expect(host.service.photos.read(p.handle, signal)).rejects.toThrow(
		"photos_session_expired",
	);
	await host.service.photos.cancel(p.handle, signal);
	expect(host.service.photos.status()).toBeNull();
});
test("a photo download completing after disconnect cannot be adopted", async () => {
	const h = await setup();
	const p = await h.service.photos.begin(signal);
	h.select();
	await h.service.photos.read(p.handle, signal);
	let release!: () => void, entered!: () => void;
	const waiting = new Promise<void>((r) => (release = r)),
		started = new Promise<void>((r) => (entered = r));
	h.block(async () => {
		entered();
		await waiting;
	});
	const download = h.service.photos.file(p.handle, "item-one", signal);
	await started;
	await h.service.disconnect(h.service.view().revision);
	release();
	await expect(download).rejects.toThrow("photos_authorization_required");
});
