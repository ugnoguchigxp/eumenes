import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../client";
import {
	resolveApiToken,
	resolveLarmToken,
} from "../api/infrastructure/auth-config";

if (
	process.env.EUMENES_LIVE_RESEARCH_ROUTES !== "1" ||
	!resolveLarmToken(process.env) ||
	!process.env.LARM_BASE_URL
)
	throw new Error(
		"live_research_routes_requires_explicit_flag_larm_base_url_and_token",
	);
// Always an isolated real backend with a temporary DB. No fixture fallback, no product DB.
const dir = mkdtempSync(join(tmpdir(), "eumenes-live-research-routes-"));
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
const digest = (v: string) =>
	new Bun.CryptoHasher("sha256").update(v).digest("hex").slice(0, 12);
const cases = [
	{ name: "kamakura-weather", question: "天気予報 鎌倉", target: "鎌倉" },
	{ name: "shizuoka-weather", question: "天気予報 静岡市", target: "静岡市" },
	{ name: "aapl-quote", question: "株価 AAPL", target: "AAPL" },
];
type Phase = {
	phase: "cold" | "warm";
	status: string;
	errorCode: string | null;
	modelCalls: number;
	toolCalls: number;
	acquisitionMode: string | null;
	childStatus: string | null;
	ms: number;
	answered: boolean;
};
async function ask(question: string, phase: "cold" | "warm"): Promise<Phase> {
	const started = performance.now();
	const run = await client.submit({
		requestId: crypto.randomUUID(),
		conversationId: "live-research-routes",
		text: question,
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
	const ms = Math.round(performance.now() - started);
	const tasks = await client.agentTasks(run.id);
	const child = tasks.find((t) => t.kind === "worker");
	const history = await client.conversation("live-research-routes");
	return {
		phase,
		status: current.status,
		errorCode: current.error ?? null,
		modelCalls: tasks.reduce((s, t) => s + t.modelCalls, 0),
		toolCalls: child?.toolCalls ?? 0,
		acquisitionMode: child?.acquisitionMode ?? null,
		childStatus: child?.status ?? null,
		ms,
		answered: !!history.messages.find((m) => m.id === current.answerMessageId)
			?.text,
	};
}
async function routes() {
	return (await client.researchRoutes({ limit: 50 })).items;
}
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
	for (const item of cases) {
		const cold = await ask(item.question, "cold");
		// Registration happens after the answer: wait separately so it never enters cold time.
		let route = (await routes()).find((r) => r.keywords.includes(item.target));
		const registrationStarted = performance.now();
		while (
			performance.now() - registrationStarted < 150000 &&
			route &&
			route.state !== "active" &&
			route.draftStatus &&
			!["activated", "rejected", "interrupted", "superseded"].includes(
				route.draftStatus.state,
			)
		) {
			await Bun.sleep(1000);
			route = (await routes()).find((r) => r.keywords.includes(item.target));
		}
		const registrationMs = Math.round(performance.now() - registrationStarted);
		const before = route
			? {
					draftId: route.draftStatus?.id ?? null,
					activeVersionId: route.activeVersionId,
				}
			: null;
		const active = route?.state === "active";
		const warm = active ? await ask(item.question, "warm") : null;
		const after = (await routes()).find((r) =>
			r.keywords.includes(item.target),
		);
		const warmRegistrationJobs =
			warm && before && after
				? Number(
						after.draftStatus?.id !== before.draftId ||
							after.activeVersionId !== before.activeVersionId,
					)
				: null;
		// Functional pass is judged here only on observable counters. Target/value/date match
		// against the answer must be reviewed by a person (see README), never auto-claimed.
		const functional = {
			coldCompleted: cold.status === "completed" && cold.answered,
			coldRealSearch: cold.acquisitionMode === "search" && cold.toolCalls >= 2,
			registered: active,
			warmCompleted: warm
				? warm.status === "completed" && warm.answered
				: false,
			warmDirect: warm ? warm.acquisitionMode === "cached" : false,
			warmSingleTool: warm ? warm.toolCalls === 1 : false,
			warmTwoModelCalls: warm ? warm.modelCalls === 2 : false,
			warmRegistrationJobs,
		};
		const functionalPass =
			functional.coldCompleted &&
			functional.coldRealSearch &&
			functional.registered &&
			functional.warmCompleted &&
			functional.warmDirect &&
			functional.warmSingleTool &&
			functional.warmTwoModelCalls &&
			functional.warmRegistrationJobs === 0;
		const result = {
			case: item.name,
			keyDigest: digest(item.question),
			routeState: after?.state ?? null,
			draftState: after?.draftStatus?.state ?? null,
			draftErrorCode: after?.draftStatus?.errorCode ?? null,
			registrationMs,
			cold,
			warm,
			functional,
			functionalPass,
			speed: {
				// Speed goals are recorded apart from the functional verdict.
				warmUnder10s: warm ? warm.ms <= 10000 : null,
				warmHalfOfCold: warm ? warm.ms * 2 <= cold.ms : null,
				note: "single pair only; at least 5 pairs per comparison target are needed, and sourceChanged/unsupported must be noted by a person",
			},
			valueReview: "required_manual",
		};
		results.push(result);
		console.log(JSON.stringify(result));
	}
	const path = "verification-reports/research-routes";
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
	if (results.some((r) => !r.functionalPass)) process.exitCode = 1;
} finally {
	backend.kill("SIGTERM");
	await Promise.race([backend.exited, Bun.sleep(12000)]);
	if (backend.exitCode === null) {
		backend.kill("SIGKILL");
		await backend.exited;
	}
	rmSync(dir, { recursive: true, force: true });
}
