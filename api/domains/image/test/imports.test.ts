import { afterEach, expect, test } from "bun:test";
import sharp from "sharp";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SqliteStore } from "../../../infrastructure/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { createLarmPlayground } from "../../larm";
import { migrations as queueMigrations } from "../../queue";
import { migrations } from "..";
import { createImageUpload } from "../service/imports";

const signal = new AbortController().signal;
const dirs: string[] = [],
	stores: SqliteStore[] = [];
afterEach(async () => {
	for (const s of stores.splice(0)) await s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function setup(
	mode: "normal" | "lost-after" | "lost-before" | "failed" = "normal",
) {
	const dir = mkdtempSync(join(tmpdir(), "image-import-"));
	dirs.push(dir);
	const path = join(dir, "db");
	const open = () => {
		const s = openStore(path, [...queueMigrations, ...migrations]);
		stores.push(s);
		return s;
	};
	let store = open();
	let token = "first-token",
		now = Date.now(),
		posts = 0,
		gets = 0,
		deleted = false;
	const receipts = new Map<string, unknown>(),
		bodies: Uint8Array[] = [];
	const gateway = () =>
		createLarmPlayground({
			baseUrl: "http://127.0.0.1:1234",
			token,
			audience: "same-host",
			fetch: (async (url, init) => {
				const route = new URL(String(url)).pathname;
				if (route === "/v1/image-artifacts/imports") {
					posts++;
					const id = new Headers(init!.headers).get("Idempotency-Key")!;
					// The immutable body and UUID exist before any external POST.
					expect(
						store.read((db) =>
							db
								.query("SELECT attempted FROM image_imports WHERE request_id=?")
								.get(id),
						),
					).toMatchObject({ attempted: 1 });
					const bytes = new Uint8Array(
						await ((init!.body as FormData).get("file") as File).arrayBuffer(),
					);
					bodies.push(bytes);
					const meta = await sharp(Buffer.from(bytes)).metadata();
					expect(meta.format).toBe("webp");
					expect(meta.width).toBeLessThanOrEqual(2000);
					if (mode === "lost-before" && posts === 1)
						throw new TypeError("lost");
					const common = {
						requestId: id,
						createdAt: new Date(now).toISOString(),
						expiresAt: new Date(now + 7 * 86400_000).toISOString(),
						statusUrl: `/v1/image-imports/${id}`,
					};
					const artifactId = `image_${"a".repeat(32)}`;
					const receipt =
						mode === "failed"
							? {
									...common,
									status: "failed",
									error: { code: "invalid_image", message: "invalid" },
								}
							: {
									...common,
									status: "succeeded",
									deleted: false,
									artifact: {
										id: artifactId,
										createdAt: common.createdAt,
										format: "webp",
										mimeType: "image/webp",
										width: meta.width,
										height: meta.height,
										hasAlpha: meta.hasAlpha,
										bytes: bytes.length,
										sha256: sha256Hex(bytes),
										contentUrl: `/v1/image-artifacts/${artifactId}/content`,
									},
								};
					receipts.set(id, receipt);
					if (mode === "lost-after" && posts === 1) throw new TypeError("lost");
					return Response.json(receipt, {
						status: mode === "failed" ? 400 : 201,
					});
				}
				gets++;
				const id = route.split("/").at(-1)!;
				const r = receipts.get(id) as Record<string, unknown> | undefined;
				if (!r)
					return Response.json(
						{ error: { code: "image_import_not_found", message: "missing" } },
						{ status: 404 },
					);
				return Response.json(
					deleted
						? {
								...r,
								deleted: true,
								artifact: undefined,
								artifactId: `image_${"a".repeat(32)}`,
							}
						: r,
				);
			}) as typeof fetch,
		});
	const service = () => createImageUpload({ store, gateway, now: () => now });
	const file = new File(
		[
			await sharp({
				create: {
					width: 2400,
					height: 1200,
					channels: 4,
					background: { r: 40, g: 100, b: 180, alpha: 0.5 },
				},
			})
				.png()
				.toBuffer(),
		],
		"private-name.png",
		{ type: "image/png" },
	);
	return {
		file,
		service,
		bodies,
		stats: () => ({ posts, gets }),
		rotate: () => {
			token = "second-token";
		},
		expire: () => {
			now += 8 * 86400_000;
		},
		remove: () => {
			deleted = true;
		},
		restart: async () => {
			await store.close();
			stores.splice(stores.indexOf(store), 1);
			store = open();
		},
	};
}
test("upload persists before sending, coalesces a concurrent UUID and uses the same artifact", async () => {
	const h = await setup();
	const s = h.service(),
		id = crypto.randomUUID();
	const [a, b] = await Promise.all([
		s.upload(id, h.file, signal),
		s.upload(id, h.file, signal),
	]);
	expect(a.status).toBe("succeeded");
	expect(b.artifact?.id).toBe(a.artifact?.id);
	expect(h.stats().posts).toBe(1);
	await expect(
		s.upload(
			id,
			new File(["different"], "other.png", { type: "image/png" }),
			signal,
		),
	).rejects.toThrow("idempotency_conflict");
});
test("an expected connection is enforced for new and previously accepted imports", async () => {
	const h = await setup();
	const service = h.service(),
		id = crypto.randomUUID();
	await expect(
		service.upload(id, h.file, signal, "different-connection"),
	).rejects.toThrow("image_import_connection_changed");
	expect(h.stats().posts).toBe(0);
	expect((await service.upload(id, h.file, signal)).status).toBe("succeeded");
	await expect(
		service.upload(id, h.file, signal, "different-connection"),
	).rejects.toThrow("image_import_connection_changed");
	expect(h.stats().posts).toBe(1);
});
test("lost completion is queried after restart without another POST; deleted receipt never recreates", async () => {
	const h = await setup("lost-after"),
		id = crypto.randomUUID();
	expect((await h.service().upload(id, h.file, signal)).status).toBe("unknown");
	await h.restart();
	expect((await h.service().resume(id, signal)).status).toBe("succeeded");
	expect(h.stats().posts).toBe(1);
	h.remove();
	expect((await h.service().resume(id, signal)).status).toBe("deleted");
	expect(h.stats().posts).toBe(1);
});
test("only a queried 404 resends the same persisted WebP bytes, even after restart", async () => {
	const h = await setup("lost-before"),
		id = crypto.randomUUID();
	await h.service().upload(id, h.file, signal);
	await h.restart();
	expect((await h.service().read(id, signal)).status).toBe("ready");
	expect(h.stats().posts).toBe(1);
	expect((await h.service().resume(id, signal)).status).toBe("succeeded");
	expect(h.stats().posts).toBe(2);
	expect(Buffer.from(h.bodies[0]!).equals(Buffer.from(h.bodies[1]!))).toBe(
		true,
	);
});
test("a failed receipt, expired UUID or changed authentication never silently sends again", async () => {
	const failed = await setup("failed"),
		id = crypto.randomUUID();
	expect((await failed.service().upload(id, failed.file, signal)).status).toBe(
		"failed",
	);
	await failed.service().resume(id, signal);
	expect(failed.stats().posts).toBe(1);
	failed.expire();
	expect((await failed.service().read(id, signal)).status).toBe("expired");
	const changed = await setup("lost-before"),
		next = crypto.randomUUID();
	await changed.service().upload(next, changed.file, signal);
	changed.rotate();
	expect((await changed.service().resume(next, signal)).status).toBe("blocked");
	expect(changed.stats()).toEqual({ posts: 1, gets: 0 });
	changed.expire();
	expect((await changed.service().resume(next, signal)).status).toBe("expired");
	expect(changed.stats().posts).toBe(1);
});
