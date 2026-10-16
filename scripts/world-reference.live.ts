/** Explicit opt-in: bun test ./scripts/world-reference.live.ts (EUMENES_SEED_FILE required).
 * Only the research worker uses the real stored LARM connection. Parent dialogue is a fixture.
 */
import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import {
	boot,
	SCOPE,
	type Step,
} from "../api/application/world/world-research.fixture";
import { createLiveLarm } from "./live-larm";
import { worldDocumentInput } from "../api/domains/world/contracts/documents";

test("live World worker searches collected material and cites an original passage", async () => {
	const path = process.env.EUMENES_SEED_FILE;
	if (!path) throw new Error("EUMENES_SEED_FILE_required");
	const records = readFileSync(path, "utf8")
		.trimEnd()
		.split("\n")
		.map((line) => worldDocumentInput.parse(JSON.parse(line)));
	const live = createLiveLarm();
	const events: unknown[] = [];
	let h: Awaited<ReturnType<typeof boot>>;
	const step: Step = async () => {
		const started = performance.now();
		const raw = await live.answer(
			JSON.parse(h.workerMessages.at(-1)!),
			AbortSignal.timeout(45000),
			{ sessionRole: "auxiliary", jsonOutput: true, contextPolicy: "exact" },
		);
		const parsed = JSON.parse(raw);
		events.push({
			action: parsed.action,
			tool: parsed.tool,
			arguments: parsed.arguments,
			milliseconds: Math.round(performance.now() - started),
		});
		return parsed;
	};
	const out = "verification-reports/world-reference-live";
	mkdirSync(out, { recursive: true });
	try {
		await live.connect();
		h = await boot(Array.from({ length: 7 }, () => step));
		for (const record of records) await h.world.documents.import(SCOPE, record);
		const { run } = await h.ask(
			"取り込んだ収集資料にある RFC 6979 では、秘密鍵のサイドチャネル漏えい対策について何を求めていますか。資料を根拠に答え、実装が対策済みかは推測しないでください。",
		);
		const done = await h.dialogue.waitForTerminal(run.id, {
			timeoutMs: 180000,
		});
		const reports = h.store.read((db) =>
			db.query("SELECT report_json FROM agent_reports").all(),
		) as { report_json: string }[];
		const tasks = h.store.read((db) =>
			db
				.query("SELECT state, error_code FROM agent_tasks WHERE kind='worker'")
				.all(),
		);
		writeFileSync(
			`${out}/result.json`,
			JSON.stringify(
				{
					documents: records.length,
					events,
					status: done?.status,
					tasks,
					reports: reports.map((r) => JSON.parse(r.report_json)),
				},
				null,
				2,
			) + "\n",
			{ mode: 0o600 },
		);
		expect(reports).toHaveLength(1);
		const report = JSON.parse(reports[0]!.report_json);
		expect(
			report.sources.some((s: { kind: string }) => s.kind === "world_document"),
		).toBe(true);
		expect(events.length).toBeLessThanOrEqual(7);
	} finally {
		await live.close();
	}
}, 240000);
