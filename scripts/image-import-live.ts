import { strict as assert } from "node:assert";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../api/application/app";
import sharp from "sharp";
import { openStore } from "../api/infrastructure/sqlite";
import { sha256Hex } from "../api/infrastructure/digest";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { createLarmPlayground } from "../api/domains/larm";
import { migrations as queueMigrations } from "../api/domains/queue";
import { migrations as imageMigrations } from "../api/domains/image";
import { registerImage } from "../api/domains/image/controller";
import { createImageUpload } from "../api/domains/image/service/imports";
import type { ImageImportView } from "../api/domains/image/contracts";
import { liveLarmSettings } from "./live-larm";

/** Explicit live acceptance: creates/deletes only this run's imported images; never opens a server. */
export async function imageImportLive(filePath: string) {
	const saved = liveLarmSettings();
	const token = resolveLarmToken(process.env);
	if (!saved.baseUrl || !token) throw new Error("larm_unconfigured");
	const directory = mkdtempSync(join(tmpdir(), "eumenes-import-live-"));
	const dbPath = join(directory, "db");
	const open = () =>
		openStore(dbPath, [...queueMigrations, ...imageMigrations]);
	let store = open();
	let mode = "normal";
	let attempts = 0;
	let wirePosts = 0;
	let reads = 0;
	const bodies: Uint8Array[] = [];
	const created = new Set<string>();
	const gateway = createLarmPlayground({
		...saved,
		baseUrl: saved.baseUrl,
		token,
		fetch: (async (url, init) => {
			const path = new URL(String(url)).pathname;
			assert(
				path.startsWith("/v1/image-artifacts") ||
					path.startsWith("/v1/image-imports/"),
				"unexpected_live_operation",
			);
			if (path === "/v1/image-artifacts/imports") {
				attempts++;
				const file = (init!.body as FormData).get("file") as File;
				bodies.push(new Uint8Array(await file.arrayBuffer()));
				if (mode === "lost-before" && attempts === 1)
					throw new TypeError("simulated_response_loss");
				wirePosts++;
				const response = await fetch(url, init);
				const value = await response
					.clone()
					.json()
					.catch(() => null);
				if (value?.artifact?.id) created.add(value.artifact.id);
				if (mode === "lost-after" && attempts === 1) {
					await response.body?.cancel();
					throw new TypeError("simulated_response_loss");
				}
				return response;
			}
			if (path.startsWith("/v1/image-imports/")) reads++;
			return fetch(url, init);
		}) as typeof fetch,
	});
	const build = () => {
		const imports = createImageUpload({ store, gateway: () => gateway });
		const service = {
			imports,
			library: () => gateway.images,
			list: () => [],
			content: async (id: string, signal: AbortSignal) => {
				const a = await gateway.images.get(id, signal);
				return gateway.artifact(
					{ id: a.id, path: a.contentUrl, mime: a.mimeType },
					signal,
				);
			},
		};
		const app = createApp({
			token: "live-fixture-local-token",
			origin: "http://localhost",
			modules: [{ mount: (app) => registerImage(app, service) }],
		});
		return {
			request: (path: string, init: RequestInit = {}) =>
				app.request(path, {
					...init,
					headers: {
						...init.headers,
						Authorization: "Bearer live-fixture-local-token",
					},
				}),
		};
	};

	const signal = () => AbortSignal.timeout(60_000);
	const report: unknown[] = [];
	try {
		const alpha = await sharp({
			create: {
				width: 2000,
				height: 2000,
				channels: 4,
				background: { r: 30, g: 120, b: 180, alpha: 0.5 },
			},
		})
			.png()
			.toBuffer();
		for (const scenario of ["normal", "lost-after", "lost-before"]) {
			mode = scenario;
			attempts = 0;
			wirePosts = 0;
			reads = 0;
			bodies.length = 0;
			let app = build();
			const id = crypto.randomUUID();
			const form = new FormData();
			form.append(
				"file",
				new File(
					[scenario === "normal" ? readFileSync(filePath) : alpha],
					"acceptance.png",
					{ type: "image/png" },
				),
			);
			const first = await app.request(`/api/images/imports?requestId=${id}`, {
				method: "POST",
				body: form,
				signal: signal(),
			});
			assert.equal(first.status, 200, "upload_route_status");
			let view = (await first.json()) as ImageImportView;
			if (scenario !== "normal") {
				assert.equal(view.status, "unknown", "lost_result_state");
				await store.close();
				store = open();
				app = build();
			}
			const deadline = Date.now() + 60_000;
			while (view.status !== "succeeded" && Date.now() < deadline) {
				if (view.status === "pending")
					await Bun.sleep(Math.max(1000, view.retryAfterMs));
				const next = await app.request(`/api/images/imports/${id}/resume`, {
					method: "POST",
					signal: signal(),
				});
				view = (await next.json()) as ImageImportView;
				assert(
					!["failed", "expired", "blocked"].includes(view.status),
					"live_import_terminal_failure",
				);
			}
			assert.equal(view.status, "succeeded", "live_import_incomplete");
			assert(view.artifact, "missing_artifact");
			const a = view.artifact;
			created.add(a.id);
			const library = await (
				await app.request("/api/images/library", { signal: signal() })
			).json();
			assert(
				library.images.some((i: { id: string }) => i.id === a.id),
				"library_missing_import",
			);
			const content = await app.request(`/api/images/${a.id}/content`, {
				signal: signal(),
			});
			assert.equal(content.status, 200, "content_route_status");
			const bytes = Buffer.from(await content.arrayBuffer());
			assert.equal(sha256Hex(bytes), a.sha256, "stored_sha_mismatch");
			assert(bytes.equals(Buffer.from(bodies[0]!)), "webp_bytes_changed");
			const metadata = await sharp(bytes).metadata();
			assert.equal(metadata.width, a.width);
			assert.equal(metadata.height, a.height);
			if (scenario !== "normal") {
				assert.equal(a.width, 2000);
				assert.equal(a.height, 2000);
				assert.equal(a.hasAlpha, true);
				const pixel = await sharp(bytes)
					.extract({ left: 0, top: 0, width: 1, height: 1 })
					.raw()
					.toBuffer();
				assert(pixel[3]! >= 127 && pixel[3]! <= 128, "alpha_changed");
			}
			if (scenario === "lost-before") {
				assert.equal(attempts, 2);
				assert(
					Buffer.from(bodies[0]!).equals(Buffer.from(bodies[1]!)),
					"resend_bytes_changed",
				);
			} else assert.equal(attempts, 1);
			assert.equal(wirePosts, 1, "duplicate_wire_post");
			const deletion = await app.request(`/api/images/${a.id}`, {
				method: "DELETE",
				signal: signal(),
			});
			assert.equal(deletion.status, 200, "delete_failed");
			created.delete(a.id);
			const replay = await (
				await app.request(`/api/images/imports/${id}/resume`, {
					method: "POST",
					signal: signal(),
				})
			).json();
			assert.equal(replay.status, "deleted", "deleted_image_recreated");
			assert.equal(wirePosts, 1, "deleted_resend");
			const after = await (
				await app.request("/api/images/library", { signal: signal() })
			).json();
			assert(
				!after.images.some((i: { id: string }) => i.id === a.id),
				"deleted_image_visible",
			);
			report.push({
				scenario,
				requestId: id,
				width: a.width,
				height: a.height,
				hasAlpha: a.hasAlpha,
				bytes: a.bytes,
				attempts,
				wirePosts,
				reads,
				byteExact: true,
				library: true,
				content: true,
				deletedReplay: true,
			});
			console.log(
				JSON.stringify({
					scenario,
					result: "passed",
					width: a.width,
					height: a.height,
					bytes: a.bytes,
				}),
			);
		}
		return {
			checkedAt: new Date().toISOString(),
			transport:
				"authenticated in-process Eumenes app + middleware -> production LARM",
			serverRestarted: false,
			googlePhotos: "not tested live",
			threeD: "ID handoff fixture only; no generation",
			cases: report,
		};
	} finally {
		for (const id of created)
			await gateway.images
				.remove(id, AbortSignal.timeout(15_000))
				.catch(() => console.error("live_test_cleanup_unconfirmed"));
		await store.close();
		rmSync(directory, { recursive: true, force: true });
	}
}
if (import.meta.main) {
	const file = process.argv[3];
	if (process.argv[2] !== "--run" || !file)
		throw new Error("usage: bun scripts/image-import-live.ts --run <png-file>");
	const report = await imageImportLive(file);
	const output = "spec/verification/model3d-image-import-2026-10-19";
	mkdirSync(output, { recursive: true });
	writeFileSync(
		join(output, "live.json"),
		JSON.stringify(report, null, 2) + "\n",
	);
}
