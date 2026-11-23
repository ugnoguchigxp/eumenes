/** 合成データだけでCanvasの保存・復元・起動を測る。保持・削除・移行は行わない。 */
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CanvasService } from "eumenes-canvas/src/core/service";
import { Store } from "eumenes-canvas/src/core/store";

const counts = process.argv.includes("--large")
	? [1, 10, 100, 1000]
	: [1, 10, 100];
const output = resolve(
	process.argv.find((arg) => arg.startsWith("--output="))?.slice(9) ??
		"verification-reports/canvas-capacity.json",
);
const dir = mkdtempSync(join(tmpdir(), "eumenes-canvas-capacity-"));
const body = {
	title: "容量検証の合成作品",
	entry:
		"canvasApp.start(api => ({frame(){api.ctx.fillRect(0,0,8,8)}}));/*" +
		"x".repeat(4096) +
		"*/",
};
// 実際の保存でdigestを検査するため、同じ契約の公開生成関数から値を得る。
const result: Array<Record<string, unknown>> = [];
const timing = async <T>(operation: () => T | Promise<T>) => {
	const start = performance.now();
	const value = await operation();
	return { value, ms: performance.now() - start };
};
const p95 = (values: number[]) =>
	[...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
try {
	for (const count of counts) {
		const path = join(dir, String(count));
		const store = new Store(path);
		const service = new CanvasService({
			store,
			contract: "canvas-artwork/1",
			model: {
				label: "capacity-fixture",
				async generate() {
					return { body, changes: "", unconfirmed: [], reply: "" };
				},
			},
			observer: {
				suite: "capacity-fixture",
				async observe() {
					return {
						environment: "fixture",
						checks: [
							{ id: "boot", level: "loaded", pass: true },
							{ id: "responds", level: "operated", pass: true },
						],
						observations: [],
					};
				},
				async close() {},
			},
		});
		try {
			const seed = await service.startRun("fixture", "seed", {
				message: "capacity fixture",
			});
			await service.drain();
			const complete = service.getRun("fixture", seed.id);
			const receipt = await service.save(
				"fixture",
				complete.presentedCandidateId!,
				{ expectedRevision: 0, idempotencyKey: "capacity_seed" },
			);
			const saved = receipt.result as { artworkId: string; digest: string };
			const template = store.revisionsOf(saved.artworkId)[0]!;
			await store.write((commit) =>
				commit(["artworks", "revisions"], (state) => {
					for (let n = 0; n < count; n++) {
						const id = "a_" + n.toString().padStart(12, "0");
						state.artworks[id] = {
							id,
							owner: "fixture",
							title: body.title,
							currentRevision: 3,
							createdAt: 1,
							updatedAt: n + 1,
						};
						state.revisions[id] = [1, 2, 3].map((revision) => ({
							...template,
							artworkId: id,
							revision,
							parent: revision === 1 ? null : revision - 1,
							candidateId: null,
						}));
					}
				}),
			);
			const loaded = await timing(() => new Store(path));
			const fileBytes = statSync(join(path, "store.json")).size;
			const metrics = loaded.value.metrics();
			if (metrics.bytes !== fileBytes)
				throw new Error("canvas_capacity_size_mismatch");
			const saveMs: number[] = [];
			const restoreMs: number[] = [];
			const target = "a_000000000000";
			for (let attempt = 0; attempt < 3; attempt++) {
				const current = service.getArtwork("fixture", target).currentRevision;
				const run = await service.startRun("fixture", "measure", {
					message: "capacity fixture",
					artworkId: target,
					expectedBase: { revision: current, digest: saved.digest },
				});
				await service.drain();
				const candidate = service.getRun(
					"fixture",
					run.id,
				).presentedCandidateId!;
				saveMs.push(
					(
						await timing(() =>
							service.save("fixture", candidate, {
								expectedRevision: current,
								idempotencyKey: `capacity_save_${attempt}`,
							}),
						)
					).ms,
				);
				restoreMs.push(
					(
						await timing(() =>
							service.restore("fixture", target, {
								revision: 1,
								expectedRevision: current + 1,
								idempotencyKey: `capacity_restore_${attempt}`,
							}),
						)
					).ms,
				);
			}
			result.push({
				seededArtworks: count,
				revisionsPerArtwork: 3,
				entryBytes: Buffer.byteLength(body.entry),
				metrics,
				fileBytes,
				openMs: loaded.ms,
				saveMs,
				saveP95Ms: p95(saveMs),
				restoreMs,
				restoreP95Ms: p95(restoreMs),
				rssBytes: process.memoryUsage().rss,
			});
		} finally {
			await service.close();
		}
	}
	mkdirSync(dirname(output), { recursive: true });
	const report = {
		measuredAt: new Date().toISOString(),
		scope:
			"synthetic fixture; one saved template plus seeded copies; no model calls, browser, product database or deletion",
		bun: Bun.version,
		platform: process.platform,
		arch: process.arch,
		samples: result,
		inputDigest: new Bun.CryptoHasher("sha256")
			.update(JSON.stringify({ body, counts, revisions: 3, attempts: 3 }))
			.digest("hex"),
	};
	writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
	console.log(
		JSON.stringify({
			output,
			samples: result.map(
				({ seededArtworks, fileBytes, openMs, saveP95Ms, restoreP95Ms }) => ({
					seededArtworks,
					fileBytes,
					openMs,
					saveP95Ms,
					restoreP95Ms,
				}),
			),
		}),
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
