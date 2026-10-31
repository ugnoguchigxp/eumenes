import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInference, type CallSession } from "../api/domains/inference";
import { createSettings } from "../api/domains/settings";
import { openStore } from "../api/infrastructure/sqlite";
import { migrations } from "../api/application/migrations";
import { configureLogging } from "../api/infrastructure/logger";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import { liveLarmSettings } from "./live-larm";

if (!process.argv.includes("--run")) throw new Error("live_requires_run");
configureLogging({ level: "silent" });
const saved = liveLarmSettings(),
	token = resolveLarmToken(process.env);
if (!saved.baseUrl || !token)
	throw new Error("saved_larm_connection_unconfigured");
const directory = resolve("spec/verification/larm-agent-capacity-2026-11-01");
mkdirSync(directory, { recursive: true });
const temporary = mkdtempSync(join(tmpdir(), "eumenes-capacity-live-"));
const dbPath = join(temporary, "fixture.db"),
	store = openStore(dbPath, migrations);
const settings = await createSettings(store, { dbPath, env: {} });
const snapshot = settings.get();
snapshot.larm = saved;
snapshot.routes.llm.mode = "larm-only";
snapshot.routes.llm.cloudAllowed = false;
await settings.apply({
	requestId: crypto.randomUUID(),
	expectedRevision: snapshot.revision,
	settings: snapshot,
	keys: [],
});
const creations: Array<{
	id: string;
	requestedTokens: number | null;
	status: number;
	bootEpoch: string | null;
}> = [];
const claims: Array<{
	id: string;
	maxTokens: number | null;
	bootEpoch: string | null;
}> = [];
const generations: Array<{
	status: number;
	stream: boolean;
	hasCacheKey: boolean;
	standardBody: boolean;
}> = [];
const observations: unknown[] = [];
const inference = createInference(store, settings, {
	token,
	providerHosts: process.env.EUMENES_LARM_PROVIDER_HOSTS?.split(",").map((s) =>
		s.trim(),
	),
	fetch: async (input, init) => {
		const path = new URL(String(input)).pathname;
		const response = await fetch(input, init);
		if (path === "/v1/agent-connections" && init?.method === "POST") {
			const body = JSON.parse(String(init.body)),
				result = await response.clone().json();
			creations.push({
				id: result.id ?? "",
				requestedTokens: body.contextTokens ?? null,
				status: response.status,
				bootEpoch: result.bootEpoch ?? null,
			});
		} else if (path.endsWith("/claim") && response.ok) {
			const result = await response.clone().json();
			claims.push({
				id: result.id,
				maxTokens:
					result.providers.find((p: { name: string }) => p.name === "llm")
						?.contextWindow?.maxTokens ?? null,
				bootEpoch:
					result.bootEpoch ??
					creations.find((c) => c.id === result.id)?.bootEpoch ??
					null,
			});
		} else if (path === "/v1/chat/completions") {
			const body = JSON.parse(String(init?.body));
			generations.push({
				status: response.status,
				stream: body.stream,
				hasCacheKey: typeof body.prompt_cache_key === "string",
				standardBody: ![
					"connectionId",
					"connection_id",
					"role",
					"slot",
					"sessionRole",
				].some((key) => key in body),
			});
		}
		return response;
	},
});
const report: Record<string, unknown> = {
	date: new Date().toISOString(),
	lane: "live",
	creations,
	claims,
	generations,
	observations,
	passed: false,
};
const conversationId = crypto.randomUUID();
async function run(
	role: "main" | "subagent",
	agentId: string,
	stream: boolean,
) {
	const requestId = await store.write((db) =>
		inference.captureInTransaction!(
			db,
			crypto.randomUUID(),
			"llm",
			Date.now() + 120000,
		),
	);
	const session: CallSession = {
		sessionRole: role,
		...(role === "subagent"
			? { taskId: agentId }
			: { reasoning: { larm: "off", cloud: "off" } }),
		agentSession: { conversationId, agentId },
		outputLimit: 64,
	};
	const messages = [
		{ role: "user" as const, content: "Respond with only OK." },
	];
	const receipt = stream
		? await inference.executeStream!(
				requestId,
				messages,
				AbortSignal.timeout(120000),
				() => {},
				undefined,
				undefined,
				session,
			)
		: await inference.executeRequest!(
				requestId,
				messages,
				AbortSignal.timeout(120000),
				undefined,
				session,
			);
	observations.push({
		role,
		stream,
		hasAnswer: typeof receipt.value === "string" && receipt.value.length > 0,
	});
}
try {
	await Promise.all([
		run("main", conversationId, false),
		run("subagent", crypto.randomUUID(), true),
		run("subagent", crypto.randomUUID(), true),
	]);
	await run("main", conversationId, true);
	if (
		creations.filter((c) =>
			claims.some((claim) => claim.id === c.id && claim.maxTokens !== null),
		).length !== 3 ||
		claims
			.filter((c) => c.maxTokens !== null)
			.map((c) => c.maxTokens)
			.sort()
			.join() !== "131072,131072,200000" ||
		generations.length !== 4 ||
		generations.some(
			(g) => g.status !== 200 || !g.hasCacheKey || !g.standardBody,
		)
	)
		throw new Error("live_capacity_contract_failed");
	report.passed = true;
} catch (error) {
	report.error =
		error instanceof Error && /^[a-zA-Z0-9_]+$/.test(error.message)
			? error.message
			: "live_failed";
	process.exitCode = 1;
} finally {
	await inference.close();
	await store.close();
	rmSync(temporary, { recursive: true, force: true });
	writeFileSync(
		join(directory, `live-${String(report.date).replaceAll(":", "-")}.json`),
		JSON.stringify(report, null, 2) + "\n",
	);
	console.log(JSON.stringify(report));
}
