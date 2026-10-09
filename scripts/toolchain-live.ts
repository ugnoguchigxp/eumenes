import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../client";
import { checkLiveResearch } from "../api/application/toolchain-live-check";
import {
	resolveApiToken,
	resolveLarmToken,
} from "../api/infrastructure/auth-config";
if (
	process.env.EUMENES_LIVE_TOOLCHAIN !== "1" ||
	!resolveLarmToken(process.env)
)
	throw new Error("live_toolchain_requires_explicit_flag_and_larm_token");
// Always spawn an isolated real backend. Never copy or open the user's product database.
const dir = mkdtempSync(join(tmpdir(), "eumenes-live-toolchain-"));
const reservation = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = reservation.port;
reservation.stop(true);
const base = `http://127.0.0.1:${port}`;
const token = resolveApiToken(process.env);
const backend = Bun.spawn([process.execPath, "api/application/server.ts"], {
	env: {
		...process.env,
		EUMENES_DB: join(dir, "db.sqlite3"),
		EUMENES_ATTITUDE_DATASET: join(dir, "attitude.sqlite3"),
		EUMENES_MEMORY_JOURNAL: join(dir, "journal.jsonl"),
		EUMENES_LOG_FILE: join(dir, "api.jsonl"),
		EUMENES_HOST: "127.0.0.1",
		EUMENES_PORT: String(port),
		EUMENES_TOOLCHAIN_ENABLED: "1",
	},
	stdout: "ignore",
	stderr: "ignore",
});
const client = createClient(base, token);
const results: Array<Record<string, unknown>> = [];
try {
	let ready = false;
	for (let i = 0; i < 100; i++) {
		try {
			await client.capabilities();
			ready = true;
			break;
		} catch {
			if (backend.exitCode !== null)
				throw new Error("isolated_backend_start_failed");
			await Bun.sleep(100);
		}
	}
	if (!ready) throw new Error("isolated_backend_start_timeout");
	const cases = [
		{
			name: "weather",
			question:
				"東京都千代田区の明日の天気と最高気温を調べてください。予報対象日時も確認してください。",
		},
		{
			name: "stock",
			question:
				"Apple (NASDAQ: AAPL) の最新の株価を調べてください。価格、通貨、価格の時点を確認してください。",
		},
	];
	for (const item of cases) {
		const started = performance.now();
		const run = await client.submit({
			requestId: crypto.randomUUID(),
			conversationId: "live-toolchain",
			text: item.question,
		});
		let current = run;
		const deadline = Date.now() + 190000;
		while (
			Date.now() < deadline &&
			["queued", "running"].includes(current.status)
		) {
			await Bun.sleep(250);
			current = await client.run(run.id);
		}
		const tasks = await client.agentTasks(run.id);
		const child = tasks.find((t) => t.kind === "worker");
		const report = run.agentTaskId
			? await client.agentReport(run.agentTaskId).catch(() => null)
			: null;
		const history = await client.conversation("live-toolchain");
		const answer = history.messages.find(
			(m) => m.id === current.answerMessageId,
		)?.text;
		const { numeric, valuesMatch, priceTimeVerified } = checkLiveResearch(
			item.name as "weather" | "stock",
			report,
			answer,
		);
		const ok =
			current.status === "completed" &&
			child?.status === "completed" &&
			!!report?.claims.length &&
			!!answer &&
			numeric &&
			valuesMatch &&
			priceTimeVerified;
		const result = {
			case: item.name,
			numeric,
			valuesMatch,
			priceTimeVerified,
			ok,
			status: current.status,
			errorCode: current.error,
			rootError: tasks.find((t) => t.kind === "coordinator")?.errorCode,
			childStatus: child?.status,
			childError: child?.errorCode,
			modelCalls: tasks.reduce((s, t) => s + t.modelCalls, 0),
			toolCalls: child?.toolCalls,
			toolOutcomes: child?.toolOutcomes,
			sourceCount: report?.sources.length,
			coverage: report?.coverage,
			ms: Math.round(performance.now() - started),
			summary: report?.summary,
			claims: report?.claims,
			answer,
			limitations: report?.limitations,
			sources: report?.sources,
		};
		results.push(result);
		console.log(JSON.stringify(result));
	}
	const path = "verification-reports/toolchain";
	mkdirSync(path, { recursive: true });
	writeFileSync(
		join(path, "live.json"),
		JSON.stringify(
			{
				at: new Date().toISOString(),
				mode: "real_larm_and_real_web_isolated_backend",
				results,
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	if (results.some((r) => !r.ok)) process.exitCode = 1;
} finally {
	backend.kill("SIGTERM");
	await Promise.race([backend.exited, Bun.sleep(12000)]);
	if (backend.exitCode === null) {
		backend.kill("SIGKILL");
		await backend.exited;
	}
	rmSync(dir, { recursive: true, force: true });
}
