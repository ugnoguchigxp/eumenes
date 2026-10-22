/** Explicit live acceptance against isolated production composition and saved LARM settings. */
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../api/infrastructure/config";
import { configureLogging } from "../api/infrastructure/logger";
import { resolveApiToken } from "../api/infrastructure/auth-config";
import { buildServices } from "../api/application/server-services";
import { createLifecycleRunner } from "../api/application/lifecycle";
import { createLifecycles } from "../api/application/server-lifecycles";
import { createApp } from "../api/application/app";
import { appModules } from "../api/application/app-modules";
import { appServices } from "../api/application/server-app-services";
import { createClient } from "../client";
import { liveLarmSettings } from "../scripts/live-larm";
import { livePipelines } from "./live-pipelines";
const args = process.argv.slice(2);
if (args[0] !== "--run") throw Error("explicit_--run_required");
const suite = args[1] ?? "timers",
	count = Number(args[2] ?? 3),
	// Publish the hand-written task pipelines into the isolated database first (spec task-pipeline-design §9).
	pipelined = args.includes("--pipelines"),
	// A similar request with other words is checked like the suite it varies.
	base = suite.replace(/2$/, "");
if (
	![
		"simple",
		"timers",
		"search",
		"multi",
		"ambiguity",
		"memory",
		"amend",
		"image3d",
		"timermusic",
		"pasta",
		"pasta2",
		"image3dmusic",
		"image3dmusic2",
		"video",
	].includes(suite) ||
	!Number.isInteger(count) ||
	count < 1 ||
	count > 10
)
	throw Error("invalid_suite_or_count");
const dir = mkdtempSync(join(tmpdir(), "eumenes-composed-live-"));
const report = `verification-reports/everyday-task-agent/composed-${suite}${pipelined ? "-pipelines" : ""}-${Date.now()}`;
mkdirSync(report, { recursive: true, mode: 0o700 });
const rows: any[] = [];
const record = (r: any) => {
	rows.push(r);
	writeFileSync(join(report, "results.json"), JSON.stringify(rows, null, 2), {
		mode: 0o600,
	});
	console.log(JSON.stringify(r));
};
const productDb = process.env.EUMENES_DB || "./data/eumenes.sqlite3";
const productKeys =
	process.env.EUMENES_KEY_DIR || join(dirname(productDb), "keys");
// Sharing the key directory must never create a key there: every file the isolated host would read must exist.
if (
	suite === "video" &&
	!["settings.key", "api.token", "world-cursor.key"].every((name) =>
		existsSync(join(productKeys, name)),
	)
)
	throw Error("product_key_files_missing");
const config = loadConfig({
	...process.env,
	// The real-browser suite decrypts the saved Bridge credential with the product key; it is never read as text here.
	...(suite === "video"
		? {
				EUMENES_KEY_DIR: productKeys,
			}
		: {}),
	EUMENES_DB: join(dir, "db.sqlite3"),
	EUMENES_LOG_FILE: join(dir, "api.jsonl"),
	EUMENES_ATTITUDE_DATASET: join(dir, "attitude.sqlite3"),
	EUMENES_MEMORY_JOURNAL: join(dir, "journal.jsonl"),
	EUMENES_PORT: "0",
	EUMENES_TOOLCHAIN_ENABLED: "1",
});
configureLogging({ file: config.logFile, level: "warn" });
const saved = liveLarmSettings(),
	s = await buildServices(config);
let server: ReturnType<typeof Bun.serve> | undefined;
const life = createLifecycleRunner(
	createLifecycles(s, { name: "http", close: () => server?.stop(true) }),
);
const execute = s.inference.executeStream.bind(s.inference);
let n = 0;
s.inference.executeStream = async (...args) => {
	const tools = args[5],
		call = ++n;
	record({
		stage: "offered",
		call,
		functions: tools?.map((t) => t.function.name),
	});
	if (tools?.some((tool) => tool.function.name === "report_partial"))
		record({
			stage: "parent_input",
			call,
			packet: JSON.parse(args[1].at(-1)!.content),
		});
	const result = await execute(...args);
	if (tools?.length && !result.toolCalls?.length)
		record({ stage: "missing_function", call, text: result.value });
	if (result.toolCalls)
		record({
			stage: "selected",
			call,
			calls: result.toolCalls.map((c) => ({
				name: c.name,
				arguments: JSON.parse(c.arguments),
			})),
		});
	return result;
};
try {
	const initial = s.settings.get();
	await s.settings.apply({
		requestId: crypto.randomUUID(),
		expectedRevision: initial.revision,
		settings: { ...initial, larm: saved },
		keys: [],
	});
	if (suite === "video") {
		// The saved Brave path and the encrypted Bridge row are copied as stored; the product DB is opened read-only.
		const product = new Database(productDb, { readonly: true });
		const isolated = new Database(config.dbPath);
		try {
			const bridge = product
				.query(
					"SELECT revision, enabled, encrypted FROM settings_browser_bridge WHERE id=1",
				)
				.get() as {
				revision: number;
				enabled: number;
				encrypted: string;
			} | null;
			const paths = product
				.query("SELECT key, value, updated_at FROM browser_settings")
				.all() as Array<{ key: string; value: string; updated_at: number }>;
			if (!bridge?.enabled || !bridge.encrypted || !paths.length)
				throw Error("saved_browser_setting_unavailable");
			isolated
				.query(
					"INSERT OR REPLACE INTO settings_browser_bridge(id,revision,enabled,encrypted) VALUES(1,?,?,?)",
				)
				.run(bridge.revision, bridge.enabled, bridge.encrypted);
			for (const row of paths)
				isolated
					.query(
						"INSERT OR REPLACE INTO browser_settings(key,value,updated_at) VALUES(?,?,?)",
					)
					.run(row.key, row.value, row.updated_at);
		} finally {
			product.close();
			isolated.close();
		}
	}
	await life.recoverAll();
	await s.inference.connect();
	if (pipelined) {
		for (const definition of livePipelines)
			record({
				stage: "pipeline_published",
				id: definition.id,
				result: await s.pipelines!.publish(definition),
			});
	}
	await s.toolchain.refreshVectors();
	life.startAll();
	const token = resolveApiToken({ EUMENES_DB: config.dbPath });
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		idleTimeout: 60,
		fetch: createApp({
			token,
			origin: config.origin,
			modules: appModules(appServices(s)),
		}).fetch,
	});
	const c = createClient(`http://127.0.0.1:${server.port}`, token);
	record({ stage: "ready", directory: dir, report });
	const inputs: Record<string, string> = {
		simple: "12たす30はいくつですか。答えだけ教えてください。",
		timers:
			"「受入A」という名前の90分タイマーを作り、作成結果を確認してから「受入B」という名前の100分タイマーを作ってください。二つの作成結果をまとめてください。",
		search:
			"Bunの公式ドキュメントを検索して、テストを実行するコマンドを一つ教えてください。ブラウザーを開く操作は不要です。",
		multi:
			"Bun公式ドキュメントでテストを実行するコマンドをWebで確認し、その確認が終わったら「確認済み」という名前の90分タイマーを作成してください。確認結果と作成結果をまとめてください。",
		image3d:
			"猫のマスコットの画像を1枚作って、できた画像をもとに3Dモデルを作ってください。作った画像と3Dモデルの結果を教えてください。",
		timermusic:
			"1分のタイマーをセットして、それから明るい曲を1曲作ってください。",
		pasta:
			"パスタの標準的な茹で時間を調べて、その時間でタイマーをセットして、待っている間に流す明るい曲を1曲作ってください。",
		pasta2:
			"うどんを茹でたいので、茹で時間を調べてその時間のタイマーを掛けて、待つ間に流すのんびりした曲も1曲お願い。",
		image3dmusic:
			"猫のマスコットの画像を1枚作って、その画像をもとに3Dモデルを作り、作業用BGMとして明るい曲も1曲作ってください。",
		image3dmusic2:
			"犬のキャラクターの絵を描いて、それを3Dモデルにして、作業用ににぎやかな曲も作ってください。",
		video:
			"Webでおすすめの動画をYouTubeから一つ探して、ブラウザーの別タブで開いて再生してください。再生できたら動画のタイトルとURLを教えてください。",
	};
	for (let i = 0; i < count; i++) {
		const conv = `composed-${crypto.randomUUID()}`;
		if (suite === "memory") {
			const pref = await c.submit({
				requestId: crypto.randomUUID(),
				conversationId: conv,
				text: "私は普段、タイマーを3分にするのが好きです。この好みを覚えてください。",
			});
			await s.dialogue.waitForTerminal(pref.id, { timeoutMs: 180000 });
			const until = Date.now() + 60000;
			while (
				Date.now() < until &&
				!s.memory.list().some((item) => JSON.stringify(item).includes("3分"))
			)
				await Bun.sleep(500);
			if (
				!s.memory.list().some((item) => JSON.stringify(item).includes("3分"))
			) {
				record({
					stage: "setup_failed",
					suite,
					i,
					reason: "memory_preference_not_stored",
				});
				continue;
			}
		}
		const prior = new Set((await c.inferenceUsage()).map((u) => u.id)),
			start = performance.now();
		let run = await c.submit({
			requestId: crypto.randomUUID(),
			conversationId: conv,
			text: inputs[suite] ?? inputs.timers!,
		});
		if (suite === "amend") {
			const until = Date.now() + 180000;
			let amended = false;
			while (Date.now() < until) {
				const timers = await c.timers({ conversationId: conv }),
					works = s.toolchain.agents.executions.list(conv);
				if (
					timers.items.some((t) => t.label === "受入A") &&
					works.some((w) =>
						["queued", "deciding", "waiting_child"].includes(w.status),
					)
				) {
					const update = await c.submit({
						requestId: crypto.randomUUID(),
						conversationId: conv,
						text: "進行中の依頼を訂正します。受入Aは90分のまま、受入Bを120分にしてください。",
					});
					await s.dialogue.waitForTerminal(update.id, { timeoutMs: 180000 });
					amended = true;
					break;
				}
				if (
					works.length &&
					works.every(
						(w) => !["queued", "deciding", "waiting_child"].includes(w.status),
					)
				)
					break;
				await Bun.sleep(200);
			}
			record({ stage: "amendment", i, amended });
		}
		await s.dialogue.waitForTerminal(run.id, { timeoutMs: 180000 });
		run = await c.run(run.id);
		let works = s.toolchain.agents.executions.list(conv);
		while (
			works.some((w) =>
				["queued", "deciding", "waiting_child"].includes(w.status),
			) &&
			performance.now() - start < (pipelined ? 1500000 : 350000)
		) {
			await Bun.sleep(500);
			works = s.toolchain.agents.executions.list(conv);
		}
		if (
			works.length &&
			works.every(
				(w) =>
					!["queued", "deciding", "waiting_child", "waiting_user"].includes(
						w.status,
					),
			)
		)
			while (performance.now() - start < (pipelined ? 1600000 : 500000)) {
				const runs = await c.runs(conv);
				if (
					runs.length > 1 &&
					runs.every((r) => !["queued", "running"].includes(r.status))
				)
					break;
				await Bun.sleep(250);
			}
		// A request goes on as hidden continuation runs: it is settled when none is queued or running.
		while (performance.now() - start < (pipelined ? 1600000 : 500000)) {
			const runs = await c.runs(conv);
			if (runs.every((r) => !["queued", "running"].includes(r.status))) break;
			await Bun.sleep(250);
		}
		const chain = await c.runs(conv);
		let ambiguitySafe = true;
		if (suite === "ambiguity") {
			const follow = await c.submit({
				requestId: crypto.randomUUID(),
				conversationId: conv,
				text: "そのタイマーを取り消してください。",
			});
			await s.dialogue.waitForTerminal(follow.id, { timeoutMs: 180000 });
			const unchanged = await c.timers({ conversationId: conv });
			ambiguitySafe =
				(await c.run(follow.id)).status === "completed" &&
				unchanged.items.length === 2 &&
				unchanged.items.every((t) => t.state === "active") &&
				unchanged.items.some(
					(t) => t.label === "受入A" && t.durationSeconds === 5400,
				) &&
				unchanged.items.some(
					(t) => t.label === "受入B" && t.durationSeconds === 6000,
				);
			record({
				stage: "ambiguity_checkpoint",
				i,
				ambiguitySafe,
				timers: unchanged,
			});
			const answer = await c.submit({
				requestId: crypto.randomUUID(),
				conversationId: conv,
				text: "受入Bのほうです。受入Aはそのまま残してください。",
			});
			await s.dialogue.waitForTerminal(answer.id, { timeoutMs: 180000 });
			while (
				performance.now() - start < (pipelined ? 1600000 : 500000) &&
				s.toolchain.agents.executions
					.list(conv)
					.some((w) =>
						["queued", "deciding", "waiting_child"].includes(w.status),
					)
			)
				await Bun.sleep(500);
		}
		const timers = await c.timers({ conversationId: conv });
		const answers = (await c.conversation(conv)).messages
			.filter((m) => m.role === "assistant")
			.map((m) => m.text);
		const usage = (await c.inferenceUsage()).filter((u) => !prior.has(u.id));
		const active = timers.items.filter((t) => t.state === "active");
		const a = active.find((t) => t.label === "受入A"),
			b = active.find((t) => t.label === "受入B");
		const completed =
			works.some((w) => w.status === "completed") ||
			(chain.length > 0 && chain.every((r) => r.status === "completed"));
		// Owned results in the isolated DB: a generated image, and a 3D model made from that image rather than a prompt.
		let media: {
			images: Array<{ id: string; record: string }>;
			models: Array<{ state: string; source: string }>;
		} = { images: [], models: [] };
		let browser: {
			tasks: Array<{
				state: string;
				result: string | null;
				error: string | null;
			}>;
			tabs: Array<{ url: string; title: string; status: string }>;
			operations: Array<{ kind: string; state: string; url: string | null }>;
		} = { tasks: [], tabs: [], operations: [] };
		if (suite === "video") {
			const db = new Database(config.dbPath, { readonly: true });
			try {
				browser = {
					tasks: db
						.query(
							"SELECT state, result_text AS result, error_code AS error FROM browser_tasks WHERE conversation_id=?",
						)
						.all(conv) as typeof browser.tasks,
					// Only tabs this conversation's operations reached; the user's other tabs are never read out.
					tabs: db
						.query(
							"SELECT DISTINCT b.url, b.title, b.status FROM browser_tabs b JOIN browser_operations o ON o.tab_ref=b.tab_ref JOIN browser_tasks t ON t.id=o.task_id WHERE t.conversation_id=?",
						)
						.all(conv) as typeof browser.tabs,
					operations: db
						.query(
							"SELECT o.tool_kind AS kind, o.state, o.result_url AS url FROM browser_operations o JOIN browser_tasks t ON t.id=o.task_id WHERE t.conversation_id=? ORDER BY o.created_at",
						)
						.all(conv) as typeof browser.operations,
				};
			} finally {
				db.close();
			}
		}
		if (suite === "image3d" || base === "image3dmusic") {
			// A 3D generation finishes minutes after its run answered: wait for it to end, not for a state in between.
			const until = Date.now() + 600000;
			for (;;) {
				const read = new Database(config.dbPath, { readonly: true });
				const pending = read
					.query(
						"SELECT COUNT(*) AS n FROM model3d_generations WHERE conversation_id=? AND deleted=0 AND state IN ('submitting','queued','running')",
					)
					.get(conv) as { n: number };
				read.close();
				if (!pending.n || Date.now() > until) break;
				await Bun.sleep(5000);
			}
			const db = new Database(config.dbPath, { readonly: true });
			try {
				media = {
					images: db
						.query(
							"SELECT id, record_json AS record FROM image_generations WHERE conversation_id=?",
						)
						.all(conv) as Array<{ id: string; record: string }>,
					models: db
						.query(
							"SELECT state, source_json AS source FROM model3d_generations WHERE conversation_id=? AND deleted=0",
						)
						.all(conv) as Array<{ state: string; source: string }>,
				};
			} finally {
				db.close();
			}
		}
		// A song finishes after its run answered: wait for it to end, then read this conversation's songs.
		let songs: Array<{ state: string }> = [];
		if (suite === "timermusic" || base === "pasta" || base === "image3dmusic") {
			const until = Date.now() + 600000;
			for (;;) {
				const read = new Database(config.dbPath, { readonly: true });
				songs = read
					.query(
						"SELECT json_extract(record_json,'$.state') AS state FROM music_generations WHERE conversation_id=?",
					)
					.all(conv) as Array<{ state: string }>;
				read.close();
				if (
					!songs.some(
						(m) => m.state === "planning" || m.state === "generating",
					) ||
					Date.now() > until
				)
					break;
				await Bun.sleep(5000);
			}
		}
		const song = songs.length === 1 && songs[0]!.state === "completed";
		// A 3D model made from an image of this conversation, not from a prompt.
		const modelFromImage =
			media.images.length > 0 &&
			media.models.some((m) => {
				const source = JSON.parse(m.source) as { type: string; id?: string };
				return (
					m.state === "completed" &&
					source.type === "image-artifact" &&
					media.images.some(
						(image) =>
							image.id === source.id || image.record.includes(source.id!),
					)
				);
			});
		// The timer's minutes come from the search step's report as the host handed it on.
		let reports = "";
		if (base === "pasta") {
			const db = new Database(config.dbPath, { readonly: true });
			try {
				reports = (
					db
						.query(
							"SELECT c.steps_json AS steps FROM dialogue_continuations c JOIN dialogue_runs r ON r.id=c.root_run_id WHERE r.conversation_id=?",
						)
						.all(conv) as Array<{ steps: string }>
				)
					.flatMap((row) =>
						(
							JSON.parse(row.steps) as Array<{
								results: Array<{ source: string; value: unknown }>;
							}>
						).flatMap((step) =>
							step.results
								.filter((r) => r.source === "research.result")
								.map((r) => JSON.stringify(r.value)),
						),
					)
					.join("\n");
				// A pipeline hands its search step's result on inside its own run.
				reports += (
					db
						.query(
							"SELECT s.result_json AS result FROM agent_execution_steps s JOIN agent_executions e ON e.id=s.execution_id WHERE e.conversation_id=? AND s.result_json IS NOT NULL",
						)
						.all(conv) as Array<{ result: string }>
				)
					.map((r) => "\n" + r.result)
					.join("");
			} finally {
				db.close();
			}
		}
		const minutes = (timers.items[0]?.durationSeconds ?? 0) / 60;
		const pass =
			base === "pasta"
				? completed &&
					timers.items.length === 1 &&
					Number.isInteger(minutes) &&
					minutes >= 1 &&
					minutes <= 30 &&
					new RegExp(`(?<![0-9])${minutes}(?![0-9])`).test(reports) &&
					song
				: base === "image3dmusic"
					? completed && modelFromImage && song
					: suite === "timermusic"
						? completed &&
							timers.items.length === 1 &&
							timers.items[0]!.durationSeconds === 60 &&
							songs.length === 1 &&
							songs[0]!.state === "completed"
						: suite === "simple"
							? run.status === "completed" &&
								works.length === 0 &&
								answers.some((x) =>
									/^(?:答え(?:は|：|:)\s*)?(?:42|四十二)(?:です|になります)?[。.!！]?$/u.test(
										x.trim(),
									),
								)
							: suite === "search"
								? run.status === "completed" &&
									works.length === 0 &&
									!!run.agentTaskId &&
									answers.some((x) => x.includes("bun test"))
								: suite === "multi"
									? completed &&
										active.length === 1 &&
										active.some(
											(t) =>
												t.label === "確認済み" && t.durationSeconds === 5400,
										) &&
										chain.length >= 2 &&
										answers.some((x) => x.includes("bun test"))
									: suite === "image3d"
										? completed && modelFromImage
										: suite === "video"
											? completed &&
												browser.tasks.some((t) => t.state === "completed") &&
												browser.operations.some(
													(o) =>
														o.state === "observed" &&
														/^https:\/\/(www\.|m\.)?youtube\.com\/watch\?/.test(
															o.url ?? "",
														),
												)
											: suite === "ambiguity"
												? ambiguitySafe &&
													completed &&
													active.length === 1 &&
													a?.durationSeconds === 5400 &&
													timers.items.some(
														(t) =>
															t.label === "受入B" && t.state === "cancelled",
													) &&
													!b
												: suite === "amend"
													? works.some(
															(w) => w.revision > 0 && w.status === "completed",
														) &&
														active.length === 2 &&
														a?.durationSeconds === 5400 &&
														b?.durationSeconds === 7200
													: completed &&
														active.length === 2 &&
														a?.durationSeconds === 5400 &&
														b?.durationSeconds === 6000;
		// With the pipelines published, the request must also have been run by one of them.
		const byPipeline = works.some(
			(w) => w.pipeline && w.status === "completed",
		);
		const passed = pipelined ? pass && byPipeline : pass;
		if (!passed) process.exitCode = 1;
		record({
			stage: "case",
			i,
			conv,
			pass: passed,
			...(pipelined ? { byPipeline } : {}),
			elapsedMs: Math.round(performance.now() - start),
			run,
			works,
			chain: chain.map((r) => ({
				id: r.id,
				sourceKind: r.sourceKind,
				status: r.status,
				error: r.error,
			})),
			timers,
			...(suite === "image3d" ? { media } : {}),
			...(suite === "timermusic" || base === "pasta" || base === "image3dmusic"
				? { songs }
				: {}),
			...(base === "image3dmusic" ? { media } : {}),
			...(base === "pasta" ? { reports } : {}),
			...(suite === "video" ? { browser } : {}),
			answers,
			usage: usage.map((u) => ({
				subject: u.subject,
				status: u.status,
				inputTokens: u.inputTokens,
				outputTokens: u.outputTokens,
				started: u.started,
				ended: u.ended,
			})),
		});
	}
} catch (e) {
	record({ stage: "error", code: String(e) });
	process.exitCode = 1;
} finally {
	await life.closeAll(30000);
	console.log(JSON.stringify({ report }));
}
