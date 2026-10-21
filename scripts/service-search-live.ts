/** Backend acceptance: fixed delegation, real search/browser decisions and transports. No server is started. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness } from "../api/application/toolchain/toolchain.fixture";
import { createWebReview } from "../api/application/toolchain/web-content-review";
import {
	createTaskRunner,
	type TaskRunnerPorts,
} from "../api/application/browser/browser-task-runner";
import { registerBrowserEffects } from "../api/application/browser/browser-effects";
import {
	createBrowser,
	createMcpBrowserDriver,
	createCaptureFiles,
	createWebpEncoder,
} from "../api/domains/browser";
import { createWebAcquisition } from "../api/domains/web-research";
import type { LarmPort, LarmCallOptions } from "../api/domains/larm";
import {
	analysisReceipt,
	isAnalysisRound,
} from "../api/domains/dialogue/test/analysis.fixture";
import { readApiToken } from "../api/infrastructure/auth-config";
import { createLiveLarm, liveLarmSettings } from "./live-larm";

const args = process.argv.slice(2);
if (!args.includes("--run")) throw new Error("explicit_--run_required");
const questionIndex = args.indexOf("--question");
const question = questionIndex >= 0 ? args[questionIndex + 1] : undefined;
if (!question) throw new Error("fixture_--question_required");
const startUrlIndex = args.indexOf("--start-url");
const startUrl = startUrlIndex >= 0 ? args[startUrlIndex + 1] : undefined;
const out = join(
	"verification-reports/service-search",
	new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(out, { recursive: true, mode: 0o700 });
const events: unknown[] = [];
function record(event: Record<string, unknown>) {
	events.push({ at: new Date().toISOString(), ...event });
	writeFileSync(join(out, "events.json"), JSON.stringify(events, null, 2), {
		mode: 0o600,
	});
	console.log(JSON.stringify(event));
}

const setting = await fetch("http://127.0.0.1:8787/api/browser/setting", {
	headers: { Authorization: `Bearer ${readApiToken(process.env)}` },
	signal: AbortSignal.timeout(3000),
});
if (!setting.ok) throw new Error("saved_browser_setting_unavailable");
const { executablePath } = (await setting.json()) as { executablePath: string };
if (!executablePath) throw new Error("saved_browser_path_missing");
const live = createLiveLarm();
// Only the fixture's delegation is scripted. Neither worker/browser decisions nor their result are replaced.
function delegate(options: LarmCallOptions | undefined): boolean {
	if (isAnalysisRound(options?.tools)) {
		const name = options!.tools!.some(
			(t) => t.function.name === "service_search",
		)
			? "service_search"
			: "find_toolchain";
		options!.onToolCalls!(
			analysisReceipt("fixture", {
				name,
				...(name === "find_toolchain" ? { args: { query: question } } : {}),
			}).toolCalls!,
		);
		return true;
	}
	if (
		options?.tools?.length === 1 &&
		options.tools[0]!.function.name === "service_search"
	) {
		options.onToolCalls!([
			{
				id: crypto.randomUUID(),
				name: "service_search",
				arguments: JSON.stringify({ request: question }),
			},
		]);
		return true;
	}
	return false;
}
function decision(raw: string, durationMs: number) {
	try {
		const value = JSON.parse(raw);
		record({
			stage: "model_decision",
			action: value.action,
			tool: value.tool,
			argumentKeys: value.arguments && Object.keys(value.arguments),
			url: value.arguments?.url,
			collectionSelection:
				value.tool === "browser.page.collect"
					? {
							blockRefs: value.arguments?.blockRefs,
							linkBlockRefs: value.arguments?.linkBlockRefs,
						}
					: undefined,
			inputSource:
				value.tool === "browser.page.type"
					? {
							valueInOriginal:
								typeof value.arguments?.value === "string" &&
								question!.includes(value.arguments.value),
							quoteInOriginal:
								typeof value.arguments?.quote === "string" &&
								question!.includes(value.arguments.quote),
							sameValueAndQuote:
								value.arguments?.value === value.arguments?.quote,
							valueCharacters: value.arguments?.value?.length,
							quoteCharacters: value.arguments?.quote?.length,
						}
					: undefined,
			durationMs: Math.round(durationMs),
			documentKind: value.documentKind,
			classificationCount: Array.isArray(value.classifications)
				? value.classifications.length
				: undefined,
			classificationKeys: Array.isArray(value.classifications)
				? value.classifications.map((item: unknown) =>
						item && typeof item === "object" ? Object.keys(item) : [],
					)
				: undefined,
			completion: value.report?.completion,
			candidateRefs: value.report?.candidateRefs,
		});
	} catch {
		record({
			stage: "model_decision",
			json: false,
			durationMs: Math.round(durationMs),
		});
	}
}
const model: LarmPort = {
	...live,
	answer: async (messages, signal, options) => {
		if (delegate(options)) return "";
		const system =
			messages.find((message) => message.role === "system")?.content ?? "";
		if (system.includes("TOOLS="))
			writeFileSync(join(out, "worker-instructions.txt"), system, {
				mode: 0o600,
			});
		for (const message of messages) {
			if (
				message.role !== "user" ||
				!message.content.startsWith("TOOL_RESULT=")
			)
				continue;
			try {
				const result = JSON.parse(message.content.slice("TOOL_RESULT=".length));
				if (!result.ok)
					record({
						stage: "browser_refusal",
						code: result.error,
						issues: result.issues,
					});
			} catch {}
		}
		const start = performance.now();
		const raw = await live.answer(messages, signal, options);
		decision(raw, performance.now() - start);
		return raw;
	},
	answerStream: async (messages, signal, delta, options) => {
		if (delegate(options)) return "";
		return live.answerStream!(messages, signal, delta, options);
	},
};
let h: Awaited<ReturnType<typeof harness>>;
const inference = new Proxy({} as TaskRunnerPorts["inference"], {
	get: (_target, key) => {
		const value = h.inference[key as keyof typeof inference];
		return typeof value === "function" ? value.bind(h.inference) : value;
	},
});
let reviewSample = 0;
const review: ReturnType<typeof createWebReview> = async (input) => {
	const sample = ++reviewSample;
	const result = await createWebReview(h.store, h.inference)(input);
	record({ stage: "review_decision", sample, decision: result.decision });
	return result;
};
const acquisition = createWebAcquisition({ review });
h = await harness({
	everyday: false,
	routeTool: "service_search",
	model,
	review,
	acquisition: {
		close: () => acquisition.close(),
		execute: async (request, signal) => {
			record({
				stage: "external_started",
				operation: request.operation,
				...(request.operation === "lookup"
					? { query: request.query }
					: { url: request.url }),
			});
			const received = await acquisition.execute(request, signal);
			record({
				stage: "external_completed",
				hits: received.result.hits.map(({ title, url }) => ({ title, url })),
				documents: received.result.documents.length,
				failures: received.result.failures.map(({ code }) => code),
			});
			return received;
		},
	},
	browser: (store, queue, capabilities) => {
		const rawDriver = createMcpBrowserDriver({
			executablePath,
			outputDir: join(out, "mcp"),
			connectTimeoutMs: 90000,
		});
		const driver = {
			...rawDriver,
			act: async (...params: Parameters<typeof rawDriver.act>) => {
				const action = params[0];
				record({
					stage: "browser_action",
					kind: action.kind,
					...(action.kind === "type"
						? { text: action.text, submit: action.submit }
						: action.kind === "navigate"
							? { url: action.url }
							: {}),
				});
				const result = await rawDriver.act(...params);
				record({ stage: "browser_action_result", ...result });
				return result;
			},
			newTab: async (url: string) => {
				record({ stage: "browser_new_tab", url });
				return rawDriver.newTab(url);
			},
		};
		const service = createBrowser({
			store,
			queue,
			driver,
			encoder: createWebpEncoder(),
			files: createCaptureFiles({ directory: join(out, "captures") }),
			webOrigins: [],
			runTaskStep: createTaskRunner({ store, inference, capabilities }),
		});
		return {
			service,
			effects: registerBrowserEffects({ queue, service }),
			requests: { userMessageInTransaction: () => null },
		};
	},
});
try {
	const settings = h.settings.get();
	const applied = await h.request("/api/settings/apply", {
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		settings: { ...settings, larm: liveLarmSettings() },
		keys: [],
	});
	if (!applied.ok) throw new Error("fixture_settings_apply_failed");
	await h.inference.connect();
	await h.toolchain.capabilities.seed();
	await h.browser!.service.setting.save(executablePath);
	record({ stage: "browser_connecting", output: out });
	await h.browser!.service.connect();
	await h.browser!.service.settled();
	const connection = h.browser!.service.connection();
	record({
		stage: "browser_connection",
		state: connection.state,
		reason: connection.endReason,
	});
	if (connection.state !== "connected")
		throw new Error("browser_connection_required");
	if (startUrl) {
		// An explicit fixture starting page; searching and candidate selection remain real model decisions.
		const prepared = await h.browser!.service.openTab(
			crypto.randomUUID(),
			null,
			startUrl,
		);
		record({
			stage: "fixture_start_page",
			url: startUrl,
			state: prepared.state,
		});
		if (prepared.state !== "observed")
			throw new Error("fixture_start_page_failed");
	}
	const response = await h.request("/api/runs", {
		requestId: crypto.randomUUID(),
		conversationId: crypto.randomUUID(),
		text: question,
	});
	if (response.status !== 202) throw new Error("submission_failed");
	const { id } = (await response.json()) as { id: string };
	record({ stage: "accepted", runId: id });
	for (let i = 0; i < 8; i++) {
		const current = await h.dialogue.waitForTerminal(id, {
			timeoutMs: 50000,
		});
		const worker = h.toolchain.agents
			.list(id)
			.find((task) => task.kind === "worker");
		record({
			stage: "progress",
			runStatus: h.dialogue.get(id)?.status,
			workerStatus: worker?.status,
			browser: worker
				? h
						.browser!.service.listTasks(worker.id)
						.map(({ state, phase, errorCode }) => ({
							state,
							phase,
							errorCode,
						}))
				: [],
		});
		if (
			!current ||
			["completed", "failed", "cancelled", "interrupted"].includes(
				current.status,
			)
		)
			break;
	}
	const tasks = h.toolchain.agents.list(id);
	const worker = tasks.find((task) => task.kind === "worker");
	const result = {
		runId: id,
		runStatus: h.dialogue.get(id)?.status,
		worker,
		browser: worker ? h.browser!.service.listTasks(worker.id) : [],
		browserDiagnostics: worker
			? h.browser!.service.listTasks(worker.id).map((task) => {
					const row = h.browser!.service.taskRow(task.taskId);
					const state = JSON.parse(row?.core_state_json ?? "null");
					return {
						taskId: task.taskId,
						refusals: state?.core?.refusals,
						results: state?.core?.messages
							?.filter(
								(m: { role: string; content: string }) =>
									m.role === "user" && m.content.startsWith("TOOL_RESULT="),
							)
							.map((m: { content: string }) => {
								const r = JSON.parse(m.content.slice("TOOL_RESULT=".length));
								return { ok: r.ok, code: r.error, issues: r.issues };
							}),
					};
				})
			: [],
		report:
			worker && ["completed", "ready_for_answer"].includes(worker.status)
				? h.toolchain.agents.report(worker.id)
				: null,
		answer: h.dialogue.answerText(id),
	};
	writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2), {
		mode: 0o600,
	});
	record({
		stage: "finished",
		status: result.runStatus,
		workerStatus: worker?.status,
		output: out,
	});
	if (result.runStatus !== "completed" || worker?.status !== "completed")
		process.exitCode = 1;
} finally {
	await h.close();
}
