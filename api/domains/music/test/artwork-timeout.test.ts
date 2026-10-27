import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { waitFor } from "../../../infrastructure/wait-for";
import { createQueue, migrations as queueMigrations } from "../../queue";
import type { LarmPlayground } from "../../larm";
import { MEDIA_GENERATION_TIMEOUT_MS } from "../../capabilities";
import { migrations, record, row } from "../repository";
import { createArtwork } from "../service/artwork";

for (const outcome of [
	"success",
	"expired",
	"cancelled",
	"http-error",
] as const)
	test(`artwork on-demand wait: ${outcome} retains finite deadline, cancellation and single submission`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "artwork-timeout-"));
		const store = openStore(join(dir, "db"), [
			...queueMigrations,
			...migrations,
		]);
		let now = Date.now(),
			calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const queue = createQueue(store, {
			now: () => now,
			leaseMs: 3_600_000,
			pollMs: 5,
		});
		const gateway = {
			catalog: async () => ({
				targets: [
					{
						mode: "service",
						capability: "media.image.generate",
						protocol: "larm.image-generation.v1",
						description: "On-demand image",
					},
				],
			}),
			execute: async () => {
				calls++;
				await gate;
				if (outcome === "http-error") throw new Error("larm_http_500");
				return { bytes: new Uint8Array([1, 2]), mime: "image/png" };
			},
		} as unknown as LarmPlayground;
		const artwork = createArtwork({
			store,
			queue,
			gateway: () => gateway,
		} as Parameters<typeof createArtwork>[0]);
		const current = () => store.read((db) => record(row(db, "track")!).artwork);
		try {
			await store.write((db) =>
				db
					.query(`INSERT INTO music_generations
				(id,run_id,conversation_id,record_json,request_json,bindings_json,deadline)
				VALUES('track','run','main',?,'{}','{}',0)`)
					.run(
						JSON.stringify({
							id: "track",
							state: "completed",
							title: "Track",
							prompt: "Instrumental",
							description: "",
						}),
					),
			);
			await artwork.request("track");
			const id = queue.list({ kind: "music.artwork" }).items[0]!.id;
			const deadline = queue.get(id)!.deadlineAtMs!;
			expect(deadline - now).toBeGreaterThanOrEqual(
				MEDIA_GENERATION_TIMEOUT_MS,
			);
			queue.start();
			await waitFor(() => calls === 1);
			now += 4 * 60_000;
			await queue.tick();
			expect(current()?.state).toBe("generating");
			if (outcome === "expired") {
				now = deadline + 1;
				await queue.tick();
			} else if (outcome === "cancelled") {
				await queue.cancel(id);
			}
			release();
			await waitFor(() => current()?.state !== "generating");
			expect(calls).toBe(1);
			expect(current()).toMatchObject(
				outcome === "success"
					? { state: "completed", errorCode: null }
					: {
							state: "failed",
							errorCode:
								outcome === "expired"
									? "deadline_exceeded"
									: outcome === "cancelled"
										? "cancel_requested"
										: "larm_http_500",
						},
			);
			expect(artwork.content("track")).toEqual(
				outcome === "success"
					? { bytes: new Uint8Array([1, 2]), mime: "image/png" }
					: null,
			);
		} finally {
			release();
			await queue.close(100);
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
