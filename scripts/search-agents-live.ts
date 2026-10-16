import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createCodexResearch } from "../api/domains/inference";
import { createWebAcquisition } from "../api/domains/web-research";
import { createLiveLarm } from "./live-larm";
import { researchLiveMetrics } from "./research-live-metrics";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import {
	searchAgentCases,
	assessSearchAgent,
	type SearchAgentResult,
} from "../api/application/toolchain/search-agents.fixture";
const args = process.argv.slice(2);
const selectedId = args[args.indexOf("--case") + 1];
const cases = args.includes("--case")
	? searchAgentCases.filter((c) => c.id === selectedId)
	: searchAgentCases.slice(0, 2);
if (!cases.length) throw new Error("unknown_search_case");
const inspectAt = args.indexOf("--check-results");
if (inspectAt >= 0) {
	const recorded: Array<SearchAgentResult & { question: string }> = JSON.parse(
		readFileSync(args[inspectAt + 1]!, "utf8"),
	);
	const results = cases.map((c) => {
		const result = recorded.find((r) => r.question === c.question);
		return {
			case: c.id,
			...(result
				? assessSearchAgent(c, result)
				: { ok: false, error: "case_missing" }),
		};
	});
	console.log(JSON.stringify(results, null, 2));
	process.exit(results.every((r) => r.ok) ? 0 : 1);
}
if (!args.includes("--run"))
	throw new Error(
		"use --run for one live attempt per case, or --check-results <file> for offline inspection",
	);

const out =
	"verification-reports/search-agents/" +
	new Date().toISOString().replaceAll(":", "-");
mkdirSync(out, { recursive: true });
const events: unknown[] = [];
function record(event: Record<string, unknown>) {
	events.push({ at: new Date().toISOString(), ...event });
	writeFileSync(out + "/events.json", JSON.stringify(events, null, 2), {
		mode: 0o600,
	});
}
function observeDecision(raw: string, engine: string) {
	let decision;
	try {
		decision = JSON.parse(raw);
	} catch {}
	record({
		stage: "worker",
		engine,
		parsedJson: !!decision,
		action: decision?.action,
		tool: decision?.tool,
		query:
			typeof decision?.arguments?.query === "string"
				? decision.arguments.query.slice(0, 500)
				: undefined,
		url:
			typeof decision?.arguments?.url === "string"
				? decision.arguments.url.slice(0, 2000)
				: undefined,
		fields: decision
			? Object.keys(decision).filter((k) =>
					["action", "tool", "arguments", "report", "requirements"].includes(k),
				)
			: [],
		outcome: decision?.report?.outcome,
		claims: decision?.report?.claims?.length,
	});
}
function observeContext(
	messages: Parameters<ReturnType<typeof createLiveLarm>["answer"]>[0],
	engine: string,
) {
	const system = messages.find(
		(m) => m.role === "system" && m.content.includes("TOOLS="),
	);
	if (!system) return;
	const data = JSON.parse(
		messages.filter((m) => m.role === "user").at(-1)!.content,
	);
	const listed = JSON.parse(system.content.split("TOOLS=")[1]!.split("\n")[0]!);
	record({
		stage: "worker_context",
		engine,
		tools: listed.map((t: { id: string; mode: string }) => ({
			id: t.id,
			mode: t.mode,
		})),
		capacityReached: data.evidenceCapacityReached,
		rejection: data.lastResult,
	});
}
const liveModel = createLiveLarm();
type LiveOptions = Parameters<typeof liveModel.answer>[2];
const argumentKeys = new Set(["kind", "question", "requirementProfiles"]);
// Routing is recorded for both the plain and the streaming conversation path.
// For routing only offered tool names, the call count and contract keys are
// kept; argument values, body text and provider output are never written.
// Worker decisions and acquisitions separately record the bounded search query
// and URL in the 0600 verification artifact, as the acceptance plan requires;
// they are fixed fixture questions and never reach the operational log.
function observedOptions(options: LiveOptions): LiveOptions {
	if (!options?.tools?.length) return options;
	const offered = new Set(options.tools.map((t) => t.function.name));
	return {
		...options,
		onToolCalls: (calls) => {
			record({
				stage: "routing",
				count: calls.length,
				tools: calls.map((call) =>
					offered.has(call.name) ? call.name : "unknown",
				),
				arguments: calls.map((call) => {
					try {
						const value = JSON.parse(call.arguments);
						return value && typeof value === "object" && !Array.isArray(value)
							? {
									json: true,
									keys: Object.keys(value).map((k) =>
										argumentKeys.has(k) ? k : "unknown",
									),
								}
							: { json: true, keys: [] };
					} catch {
						return { json: false, keys: [] };
					}
				}),
			});
			options.onToolCalls?.(calls);
		},
	};
}
const isWorker = (messages: Parameters<typeof liveModel.answer>[0]) =>
	messages.some((m) => m.role === "system" && m.content.includes("TOOLS="));
const model = {
	...liveModel,
	answer: async (...args: Parameters<typeof liveModel.answer>) => {
		const [messages, signal, options] = args;
		observeContext(messages, "larm");
		const raw = await liveModel.answer(
			messages,
			signal,
			observedOptions(options),
		);
		if (isWorker(messages)) observeDecision(raw, "larm");
		return raw;
	},
	...(liveModel.answerStream
		? {
				answerStream: async (
					...args: Parameters<NonNullable<typeof liveModel.answerStream>>
				) => {
					const [messages, signal, delta, options] = args;
					observeContext(messages, "larm");
					const raw = await liveModel.answerStream!(
						messages,
						signal,
						delta,
						observedOptions(options),
					);
					if (isWorker(messages)) observeDecision(raw, "larm");
					return raw;
				},
			}
		: {}),
};
const codex = createCodexResearch(process.env);
if (!codex && cases.some((c) => c.expectedPackage === "package:web.search@1"))
	throw new Error("codex_unavailable");
const acquire = createWebAcquisition();
let operations: Array<{
	operation: string;
	query?: string;
	language?: string;
	region?: string;
	timeRange?: string;
	readPages?: number;
	url?: string;
}> = [];
let caseIndex = 0;
const h = await harness({
	model,
	codexResearch: codex
		? {
				execute: async (messages, signal, control, model) => {
					const system = messages
						.filter((m) => m.role === "system")
						.map((m) => m.content)
						.join("\n");
					const listed = JSON.parse(
						system.split("\nTOOLS=")[1]!.split("\n")[0]!,
					);
					console.log(
						JSON.stringify({
							offeredTools: listed.map((t: { id: string }) => t.id),
						}),
					);
					observeContext(messages, "codex");
					const raw = await codex.execute(messages, signal, control, model);
					observeDecision(raw, "codex");
					let action;
					try {
						action = JSON.parse(raw);
					} catch {}
					console.log(
						JSON.stringify({
							nextAction: action?.action,
							nextTool: action?.tool,
							claims: action?.report?.claims?.length,
							outcome: action?.report?.outcome,
						}),
					);
					return raw;
				},
			}
		: undefined,
	acquire: async (r, s) => {
		operations.push(
			r.operation === "lookup"
				? {
						operation: r.operation,
						query: r.query,
						language: r.language,
						region: r.region,
						timeRange: r.timeRange,
						readPages: r.readPages,
					}
				: { operation: r.operation, url: r.url },
		);
		writeFileSync(
			out + "/operations-" + caseIndex + ".json",
			JSON.stringify(operations, null, 2),
			{ mode: 0o600 },
		);
		record({ stage: "acquisition_started", ...operations.at(-1) });
		const received = await acquire.execute(r, s).catch((error) => {
			record({
				stage: "acquisition_failed",
				code:
					error instanceof Error &&
					["web_timeout", "web_cancelled", "web_result_too_large"].includes(
						error.message,
					)
						? error.message
						: "web_acquisition_failed",
			});
			throw error;
		});
		const overview = {
			operation: r.operation,
			hits: received.result.hits.map((hit) => ({
				title: hit.title,
				url: hit.url,
			})),
			documents: received.result.documents.map((doc) => ({
				title: doc.title,
				url: doc.url,
			})),
			failures: received.result.failures,
		};
		writeFileSync(
			out + "/acquisition-" + caseIndex + "-" + operations.length + ".json",
			JSON.stringify(overview, null, 2),
			{ mode: 0o600 },
		);
		record({ stage: "acquisition_completed", ...overview });
		return received;
	},
});
try {
	await h.inference.connect();
	const results = [];
	for (const c of cases) {
		const { question, expectedPackage } = c;
		caseIndex++;
		operations = [];
		const start = performance.now();
		const response = await h.request("/api/runs", {
			requestId: crypto.randomUUID(),
			conversationId: crypto.randomUUID(),
			text: question,
		});
		if (response.status !== 202) throw new Error("submission_failed");
		const run = await response.json();
		record({ stage: "accepted", case: c.id, runId: run.id });
		writeFileSync(
			out + "/current.json",
			JSON.stringify(
				{ caseIndex, question, expectedPackage, runId: run.id },
				null,
				2,
			),
			{ mode: 0o600 },
		);
		const final = await h.dialogue.waitForTerminal(run.id, {
			timeoutMs: 190000,
		});
		const tasks = h.toolchain.agents.list(run.id);
		const worker = tasks.find((t) => t.kind === "worker");
		const report =
			worker?.status === "completed"
				? h.toolchain.agents.report(worker.id)
				: null;
		const answer = h.dialogue.answerText(run.id) ?? undefined;
		const verifierCalls = worker
			? h.store.read(
					(db) =>
						db
							.query(
								"SELECT COUNT(*) AS n FROM agent_steps WHERE task_id=? AND action_kind='verify_requirements'",
							)
							.get(worker.id) as { n: number } | null,
				)
			: null;
		const controlDiagnostics = worker
			? h.store.read((db) => {
					const task = db
						.query(
							"SELECT json_repairs,control_repair_json FROM agent_tasks WHERE id=?",
						)
						.get(worker.id) as {
						json_repairs: number;
						control_repair_json: string | null;
					};
					const steps = db
						.query(
							"SELECT ordinal,state,action_kind,error_code FROM agent_steps WHERE task_id=? ORDER BY ordinal",
						)
						.all(worker.id);
					return {
						repairs: task.json_repairs,
						issues: JSON.parse(task.control_repair_json ?? "[]"),
						steps,
					};
				})
			: null;
		const item = {
			question,
			expectedPackage,
			operations,
			runId: run.id,
			status: final?.status,
			error: final?.error,
			milliseconds: Math.round(performance.now() - start),
			tasks,
			report,
			answer,
			verifierCalls,
			controlDiagnostics,
			...researchLiveMetrics(
				h.inference
					.usage()
					.map((entry) => ({ ...entry, model: entry.model ?? "unknown" })),
				run.id,
				tasks,
			),
		};
		const assessment = assessSearchAgent(c, item);
		results.push({ ...item, ...assessment });
		writeFileSync(out + "/live.json", JSON.stringify(results, null, 2), {
			mode: 0o600,
		});
		console.log(
			JSON.stringify({
				runId: run.id,
				milliseconds: item.milliseconds,
				status: item.status,
				workerStatus: worker?.status,
				workerError: worker?.errorCode,
				modelCalls: worker?.modelCalls,
				toolCalls: worker?.toolCalls,
				reportVersion: report?.version,
				claims: report?.claims.length,
				verifierCalls,
				stages: item.stages,
			}),
		);
		console.log(
			JSON.stringify({ case: c.id, ...assessment, evidenceDirectory: out }),
		);
		if (!assessment.ok) process.exitCode = 1;
	}
} finally {
	await h.close();
	await acquire.close();
}
