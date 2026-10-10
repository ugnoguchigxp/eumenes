import { liveLarmSettings } from "./live-larm";
import { researchLiveMetrics } from "./research-live-metrics";
import { researchHistoryLiveCases } from "./research-history-live-cases";
import { conversationLiveCases } from "./conversation-live-cases";
import {
	mkdtempSync,
	rmSync,
	mkdirSync,
	writeFileSync,
	existsSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../client";
import {
	checkLiveResearch,
	checkLiveForecastDate,
	checkLiveCitations,
} from "../api/application/toolchain-live-check";
import {
	resolveApiToken,
	resolveLarmToken,
} from "../api/infrastructure/auth-config";
if (
	process.env.EUMENES_LIVE_TOOLCHAIN !== "1" ||
	!resolveLarmToken(process.env)
)
	throw new Error("live_toolchain_requires_explicit_flag_and_token");
// Read only the saved LARM connection through its backend domain, then run in an isolated DB.
const savedLarm = liveLarmSettings();
if (!savedLarm.baseUrl) throw new Error("saved_larm_connection_unconfigured");
const dir = mkdtempSync(join(tmpdir(), "eumenes-live-toolchain-"));
const reservation = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () => new Response(),
});
const port = reservation.port;
reservation.stop(true);
const base = `http://127.0.0.1:${port}`;
const token = resolveApiToken({ EUMENES_DB: join(dir, "db.sqlite3") });
const backend = Bun.spawn([process.execPath, "api/application/server.ts"], {
	env: {
		...process.env,
		EUMENES_DB: join(dir, "db.sqlite3"),
		EUMENES_API_TOKEN: token,
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
	const initialSettings = await client.settings();
	await client.applySettings({
		requestId: crypto.randomUUID(),
		expectedRevision: initialSettings.revision,
		settings: { ...initialSettings, larm: savedLarm },
		keys: [],
	});
	// HTTP startup precedes model connection readiness. Do not spend the
	// coordinator's deadline waiting for the startup probe's connection.
	const connection = await client.connectLarm();
	if (connection.larm.state !== "ready")
		throw new Error("isolated_larm_not_ready");
	const researchHistorySuite = process.argv.includes("research-history");
	const conversationSuite = process.argv.includes("conversation");
	const answerSuite = process.argv.includes("answers");
	if (researchHistorySuite)
		results.push(...(await researchHistoryLiveCases(client)));
	if (conversationSuite) results.push(...(await conversationLiveCases(client)));
	const weatherOnly = process.argv.includes("weather-only");
	const searchSuite = process.argv.includes("search") || answerSuite;
	if (answerSuite) {
		const settings = await client.settings();
		settings.general.persona = "strategist";
		await client.applySettings({
			requestId: crypto.randomUUID(),
			expectedRevision: settings.revision,
			settings,
			keys: [],
		});
	}
	const cases =
		researchHistorySuite || conversationSuite
			? []
			: answerSuite
				? [
						{
							name: "kamakura-today",
							kind: "weather" as const,
							question: "今日の鎌倉の天気教えて。",
						},
						{
							name: "bun-docs",
							kind: "general" as const,
							question:
								"Bunの公式ドキュメントをWeb検索し、テストを実行するコマンドを確認してください。",
						},
					]
				: searchSuite
					? [
							{
								name: "kamakura-today",
								kind: "weather" as const,
								question:
									"今日の鎌倉の天気と最高気温をWeb検索で調べてください。予報対象日も確認してください。",
							},
							{
								name: "kamakura-tomorrow",
								kind: "weather" as const,
								question:
									"明日の鎌倉の天気と最高気温をWeb検索で調べてください。予報対象日も確認してください。",
							},
							{
								name: "bun-docs",
								kind: "general" as const,
								question:
									"Bunの公式ドキュメントをWeb検索し、テストを実行するコマンドを確認してください。",
							},
						]
					: [
							{
								name: "weather",
								kind: "weather" as const,
								question:
									"東京都千代田区の明日の天気と最高気温を調べてください。予報対象日時も確認してください。",
							},
							{
								name: "stock",
								kind: "stock" as const,
								question:
									"Apple (NASDAQ: AAPL) の最新の株価を調べてください。価格、通貨、価格の時点を確認してください。",
							},
						];
	for (const item of cases.filter(
		(item) => !weatherOnly || item.kind === "weather",
	)) {
		const started = performance.now();
		const requestedDate = new Intl.DateTimeFormat("en-CA", {
			timeZone: "Asia/Tokyo",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(
			new Date(Date.now() + (item.name === "kamakura-tomorrow" ? 86400000 : 0)),
		);
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
		const report = current.agentTaskId
			? await client.agentReport(current.agentTaskId!).catch(() => null)
			: null;
		const history = await client.conversation("live-toolchain");
		const answer = history.messages.find(
			(m) => m.id === current.answerMessageId,
		)?.text;
		const { numeric, valuesMatch, priceTimeVerified } =
			item.kind === "general"
				? {
						numeric: true,
						valuesMatch:
							!!answer?.includes("bun test") &&
							!!report &&
							[report.summary, ...report.claims.map((c) => c.text)].some(
								(text) => text.includes("bun test"),
							) &&
							report.claims.some((c) =>
								c.evidence.some(
									(e) =>
										e.quote.includes("bun test") &&
										report.sources.some(
											(s) =>
												s.sourceId === e.sourceId &&
												(/^(?:www\.)?bun\.(?:sh|com)$/.test(
													new URL(s.url!).hostname,
												) ||
													(new URL(s.url!).hostname === "github.com" &&
														new URL(s.url!).pathname.startsWith(
															"/oven-sh/bun/",
														))),
										),
								),
							),
						priceTimeVerified: !!report?.sources.some(
							(s) =>
								/^(?:www\.)?bun\.(?:sh|com)$/.test(new URL(s.url!).hostname) ||
								(new URL(s.url!).hostname === "github.com" &&
									new URL(s.url!).pathname.startsWith("/oven-sh/bun/")),
						),
					}
				: checkLiveResearch(item.kind, report, answer);
		const searchVerified = !!child?.toolOutcomes?.some(
			(t) =>
				t.toolRevisionId.startsWith("tool:web.lookup@") &&
				t.state === "succeeded",
		);
		const fullTextVerified = !!report?.sources.some((s) => s.basis === "page");
		const targetDateVerified =
			!searchSuite ||
			item.kind !== "weather" ||
			checkLiveForecastDate(requestedDate, report);
		// A static command can be supported by an official search excerpt after a
		// guarded read fails. Forecast numbers still require the actual page.
		const acquisitionVerified =
			!searchSuite ||
			(searchVerified && (item.kind === "general" || fullTextVerified));
		const citationsVerified = checkLiveCitations(report, answer);
		const answerHasContext =
			!answerSuite ||
			item.kind !== "weather" ||
			(!!answer &&
				/最高/.test(answer) &&
				/最低/.test(answer) &&
				/降水確率/.test(answer));
		const factualReporting =
			!answerSuite ||
			!/と見ます|結論から|紫外線|お出かけ指数|洗濯|星空/.test(answer ?? "");
		const ok =
			current.status === "completed" &&
			child?.status === "completed" &&
			!!report?.claims.length &&
			!!answer &&
			numeric &&
			valuesMatch &&
			priceTimeVerified &&
			targetDateVerified &&
			acquisitionVerified &&
			citationsVerified &&
			answerHasContext &&
			factualReporting;
		const result = {
			case: item.name,
			citationsVerified,
			answerHasContext,
			factualReporting,
			requestedDate,
			numeric,
			valuesMatch,
			priceTimeVerified,
			searchVerified,
			fullTextVerified,
			targetDateVerified,
			ok,
			status: current.status,
			errorCode: current.error,
			rootError: tasks.find((t) => t.kind === "coordinator")?.errorCode,
			childStatus: child?.status,
			packageRevisionId: child?.packageRevisionId,
			childError: child?.errorCode,
			...researchLiveMetrics(await client.inferenceUsage(), run.id, tasks),
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
		join(
			path,
			conversationSuite
				? "conversation-live.json"
				: researchHistorySuite
					? "research-history-live.json"
					: answerSuite
						? "answer-live.json"
						: searchSuite
							? "search-live.json"
							: "live.json",
		),
		JSON.stringify(
			{
				at: new Date().toISOString(),
				mode: conversationSuite
					? "real_larm_and_raw_history_isolated_backend"
					: "real_larm_and_real_web_isolated_backend",
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
	// Keep the sanitized operational diagnosis when the isolated database is removed.
	const logPath = join(dir, "api.jsonl");
	if (existsSync(logPath)) {
		mkdirSync("verification-reports/toolchain", { recursive: true });
		writeFileSync(
			"verification-reports/toolchain/live-backend.jsonl",
			readFileSync(logPath),
			{ mode: 0o600 },
		);
	}
	rmSync(dir, { recursive: true, force: true });
}
