import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadProcessConfig } from "../api/infrastructure/config";
import { readApiToken } from "../api/infrastructure/auth-config";
import { createClient } from "../client";
import type { AnalysisDomain } from "../client/visual-analysis";
import type { AnalysisRecord } from "../api/domains/larm/contracts/visual-perception";
import { imageForInput } from "../api/infrastructure/media-image";
import { waitFor } from "../api/infrastructure/wait-for";
if (!process.argv.includes("--run")) throw new Error("use --run");
const cfg = loadProcessConfig();
const client = createClient(
	`http://127.0.0.1:${cfg.port}`,
	readApiToken(process.env),
);
const out = resolve("spec/verification/visual-perception-2026-10-25");
mkdirSync(out, { recursive: true });
const file = resolve(
	"spec/verification/object-recognition-live-2026-10-13/bus.jpg",
);
const image = await imageForInput(
	new Uint8Array(await Bun.file(file).arrayBuffer()),
	null,
	AbortSignal.timeout(30000),
	["image/png", "image/jpeg"],
	4194304,
	4194304,
);
const prior =
	process.argv.includes("--resume") && existsSync(`${out}/live-api.json`)
		? (JSON.parse(readFileSync(`${out}/live-api.json`, "utf8")) as {
				created: { domain: AnalysisDomain; id: string }[];
				results: unknown[];
			})
		: undefined;
const results: unknown[] = [];
const created: { domain: AnalysisDomain; id: string }[] = prior?.created ?? [];
const report = () =>
	writeFileSync(
		`${out}/live-api.json`,
		JSON.stringify(
			{
				at: new Date().toISOString(),
				fixture: false,
				serverStarted: false,
				created,
				results,
			},
			null,
			2,
		),
	);
const sources = new Map<AnalysisDomain, { id: string; revision: number }>();
for (const domain of ["ocr", "object-recognition"] as const) {
	const upload = new File(
		[new Uint8Array(image.bytes)],
		"詳細分析の接続確認.png",
		{ type: image.mime },
	);
	const id = crypto.randomUUID();
	const existing = created.find((x) => x.domain === domain);
	const source = existing
		? domain === "ocr"
			? await client.ocrGet(existing.id)
			: await client.recognitionGet(existing.id)
		: domain === "ocr"
			? await client.ocrUpload(upload, "main", id)
			: await client.recognitionUpload(upload, "main", id);
	if (!existing) created.push({ domain, id: source.id });
	report();
	await waitFor(
		async () => {
			const current =
				domain === "ocr"
					? await client.ocrGet(source.id)
					: await client.recognitionGet(source.id);
			if (["completed", "failed", "cancelled"].includes(current.state)) {
				sources.set(domain, current);
				return true;
			}
			return false;
		},
		{ timeout: 120000, interval: 1000 },
	);
}
for (const test of [
	{
		domain: "ocr",
		task: "describe",
		query: "この画像で何が起きているか説明してください。",
	},
	{
		domain: "object-recognition",
		task: "referring",
		query: "道路に停車しているバス",
	},
	{ domain: "object-recognition", task: "segmentation", query: "バス" },
] as const) {
	const source = sources.get(test.domain)!;
	const old = process.argv.includes("--resume")
		? (await client.analysesList(test.domain, source.id, "main")).find(
				(x) =>
					x.options.task === test.task &&
					x.options.query === test.query &&
					!["failed", "cancelled"].includes(x.state),
			)
		: undefined;
	const requestId = old?.id ?? crypto.randomUUID();
	const started = performance.now();
	let saved: AnalysisRecord;
	console.log(
		JSON.stringify({
			domain: test.domain,
			task: test.task,
			state: "submitting",
		}),
	);
	try {
		if (!old)
			await client.analysisCreate(test.domain, source.id, {
				requestId,
				conversationId: "main",
				expectedRevision: source.revision,
				task: test.task,
				query: test.query,
			});
		await waitFor(
			async () => {
				try {
					saved = await client.analysisGet(
						test.domain,
						source.id,
						requestId,
						"main",
					);
				} catch {
					return false;
				}
				return ["completed", "failed", "cancelled"].includes(saved.state);
			},
			{ timeout: 370000, interval: 1000 },
		);
		const record = saved!;
		if (record.state !== "completed")
			throw new Error(record.errorCode ?? "analysis_failed");
		const normalized = await client.analysisAsset(
			test.domain,
			source.id,
			record.id,
			"main",
			"image",
		);
		writeFileSync(
			`${out}/${test.task}-input.${normalized.type === "image/png" ? "png" : "jpg"}`,
			new Uint8Array(await normalized.arrayBuffer()),
		);
		for (let i = 0; i < (record.result?.masks.length ?? 0); i++) {
			const mask = await client.analysisAsset(
				test.domain,
				source.id,
				record.id,
				"main",
				`masks/${i}`,
			);
			writeFileSync(
				`${out}/${test.task}-mask-${i}.png`,
				new Uint8Array(await mask.arrayBuffer()),
			);
		}
		results.push({
			domain: test.domain,
			task: test.task,
			sourceId: source.id,
			record,
			clientElapsedMs: performance.now() - started,
		});
		report();
		console.log(
			JSON.stringify({
				domain: test.domain,
				task: test.task,
				state: record.state,
				detections: record.result?.detections.length,
				masks: record.result?.masks.length,
				releaseConfirmed: record.releaseConfirmed,
			}),
		);
	} catch (error) {
		results.push({
			domain: test.domain,
			task: test.task,
			state: "failed",
			error: error instanceof Error ? error.message : "failed",
		});
		report();
		throw error;
	}
}
console.log("live_api_complete");
