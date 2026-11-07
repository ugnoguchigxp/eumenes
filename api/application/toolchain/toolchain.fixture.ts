import { offeredKinds } from "./toolchain-command.fixture";
import { fixtureResources } from "./toolchain-resources.fixture";
import { collaborationInstructions } from "eumenes-collaboration";
import { createContinuityService } from "../../domains/continuity";
import { createAnalysisFactory } from "../media/analysis";
import { reportShellRuns } from "../shell/shell-reports";
import { createDotsHarness } from "../work/dots-harness.fixture";

import { createMemoryService } from "../../domains/memory";
import { dormantBundleFile } from "../../domains/capabilities";
import { bundleHostOf } from "./toolchain-adapters";
import { computeAnnouncements } from "../compute/compute-composition";
import { createCompute } from "../../domains/compute";
import { fixtureDiscovery } from "./discovery.fixture";
import { createOcr } from "../../domains/ocr";
import {
	createExcalidraw,
	registerDrawingOperations,
} from "../../domains/excalidraw";
import { createObjectRecognition } from "../../domains/object-recognition";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import { createImage } from "../../domains/image";
import { createMarkdown } from "../../domains/markdown";
import { createUiCompositions } from "../../domains/ui-compositions";
import { createMusic } from "../../domains/music";
import {
	fixtureResearchOutput,
	fixtureVerification,
} from "../../domains/agent-runtime/test/research-fixture";
import { createKanban } from "../../domains/kanban";
import { connectKanbanRuns } from "../work/kanban-runs";
import { migrations as terminalsMigrations } from "../../domains/terminals";
import { reportFinishedTasks } from "../work/claude-code-reports";
import { createChanges } from "../events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../infrastructure/sqlite";
import { systemContext } from "../../infrastructure/system-context";
import { migrations } from "../migrations";
import { createConversationService } from "../../domains/conversation";
import { createSettings } from "../../domains/settings";
import { createInference } from "../../domains/inference";
import { createTtsDictionary } from "../../domains/tts-dictionary";
import { createQueue } from "../../domains/queue";
import { createScheduler } from "../../domains/scheduler";
import { createWebResearch } from "../../domains/web-research";
import { createDialogueService } from "../../domains/dialogue";
import { testConversationAgent } from "../../domains/dialogue/test/conversation-agent.fixture";
import { createVoiceDialogue } from "../../domains/voice-dialogue";
import type { HarnessOptions } from "./toolchain-harness-options.fixture";
import { createToolchain } from "./toolchain";
import { createToolchainHostLinks } from "./toolchain-host";
import { createTimers } from "../../domains/timers";
import { createSpecialistPort } from "./specialist-port";
import { createToolchainRouting } from "./toolchain-routing";
import { configureTaskExecution } from "./task-execution-port";
import { taskMediaPorts } from "./task-media-execution";
import { taskLegacyPorts } from "./task-legacy-execution";
import { createTimerAnnouncements } from "../timers/timer-announcements";
import { createApp } from "../app";
import { appModules } from "../app-modules";
import type { LarmPort } from "../../domains/larm";
import { askModel, attachFixtureRouter } from "./router.fixture";
import { TURN_STRUCTURE_PROMPT } from "eumenes_router";
import { researchAcquisition } from "./research-acquisition.fixture";
export { forbidden } from "./research-acquisition.fixture";
import {
	answerByScript,
	askedOf,
	callsOf,
	candidatesOf,
	choiceByScript,
	choiceRound,
	delegate,
	findToolchain,
	handedStep,
	instantExecute,
	isNoticeRound,
	isUtteranceRound,
	utteranceOf,
	type Step,
	UNAVAILABLE_TEXT,
} from "./conversation-script.fixture";
/** The conversation agent's fixed tools, as a script reads what it may call. */
/** The system of the router's fill of a structured answer (spec router-package-integration 2026-11-04). */
const ANSWER_FILL = systemContext(
	"dialogue.contexts.local.router-answer-fill",
	{},
);
const CONVERSATION_TOOLS = ["memory", "find_toolchain", "delegate", "work"].map(
	(name) => ({
		function: { name },
	}),
);
/** Trusted packet merged with the separate UNTRUSTED_MATERIALS message. */
export function workerPacket(
	messages: import("../../domains/inference/contracts").Messages,
): any {
	const data = JSON.parse(
		messages.filter((m) => m.role === "user").at(-1)!.content,
	);
	const untrusted = messages.find((m) =>
		m.content.startsWith("UNTRUSTED_MATERIALS"),
	);
	if (untrusted)
		Object.assign(
			data,
			JSON.parse(untrusted.content.slice(untrusted.content.indexOf("=") + 1)),
		);
	return data;
}
export async function harness(options: HarnessOptions = {}) {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-toolchain-"));
	// The terminals request table is registered by the host; added here until it is.
	const store = openStore(join(dir, "db"), [
		...migrations,
		...terminalsMigrations.filter(
			(entry) => !migrations.some((known) => known.id === entry.id),
		),
	]);
	const shell = options.shell?.(store);
	await shell?.recover();
	let terminals = options.terminals?.(store);
	let kanban =
		options.kanban && terminals ? createKanban({ store }) : undefined;
	let kanbanRuns:
		| ReturnType<typeof connectKanbanRuns>
		| ReturnType<
				typeof import("../work/kanban-sdk-host").createKanbanSdkHost
		  >["runs"]
		| undefined =
		kanban && terminals ? connectKanbanRuns(kanban, terminals) : undefined;
	await terminals?.recover();
	await kanbanRuns?.recover();
	const changes = createChanges();
	const unsubscribeChanges = store.onCommit(() => changes.publish());
	const conversation = createConversationService(store, {
			requireOutbox: true,
		}),
		settings = await createSettings(store, {
			dbPath: join(dir, "db"),
			env: options.settingsEnv,
		});
	const kanbanSdk = options.kanbanComposition?.(
		store,
		settings,
		() => toolchain.capabilities,
	);
	if (kanbanSdk) {
		terminals = kanbanSdk.terminals;
		kanban = kanbanSdk.kanban;
		kanbanRuns = kanbanSdk.runs;
		await terminals.recover();
		await kanbanRuns.recover();
	}
	const parentContexts: string[] = [],
		workerContexts: string[] = [],
		routeContexts: string[] = [],
		completionContexts: string[] = [],
		completionToolChoices: Array<string | undefined> = [],
		completionOutputLimits: Array<number | undefined> = [],
		commandContexts: string[] = [];
	const spoken: string[] = [];
	let calls = 0,
		acquisitions = 0;
	let quoteRejected = false;
	/** The conversation's answer to a message: the parent agent's reply, a finished action's, or the fixed sentence. */
	const reply = async (
		messages: import("../../domains/inference/contracts").Messages,
	): Promise<string> => {
		parentContexts.push(JSON.stringify(messages));
		if (options.parentAnswer !== undefined) return options.parentAnswer;
		// The analysis asked for a clarification: the answer round carries the question.
		if (options.clarify) return "どの地域の天気を調べますか？";
		if (options.parent) return options.parent(messages);
		const action = messages.find((m) =>
			m.content.startsWith('{"actionResult":'),
		);
		if (action) {
			const result = JSON.parse(action.content).actionResult;
			if (result.kind === "task_result") return result.summary;
			if (result.items[0]?.state === "cancelled")
				return "タイマーを取り消しました";
			if (result.action === "started")
				return `${result.items[0].durationSeconds}秒のタイマーを開始しました`;
			if (result.action === "cancelled") return "タイマーを取り消しました";
			return (
				result.items
					.map(
						(item: any) =>
							`${item.label}: 残り${item.remainingSeconds}秒 (${item.state})`,
					)
					.join("、") || "動いているタイマーはありません"
			);
		}
		if (options.parentAnswer !== undefined) return options.parentAnswer;
		const result = messages.find((m) => m.content.includes('"sources":'));
		const projection = result ? JSON.parse(result.content).report : null;
		const source = projection?.sources?.[0];
		const citation = source?.url
			? `\n\nソース：[${new URL(source.url).hostname}](${source.url})`
			: "";
		return messages.some((m) => m.content.includes("250.12"))
			? "調べました。AAPLは250.12米ドル、2026年10月8日の終値でございます。" +
					citation
			: messages.some((m) => m.content.includes("26度"))
				? "調べました。東京は晴れ、最高26度、最低17度、降水確率0％の予報でございます。" +
					citation
				: "かしこまりました。";
	};
	/**
	 * The model's step for a user's utterance (sections 6.1 to 6.5): a search, a hand-over, an instant answer, or the
	 * conversation's own answer. A scripted step (`firstRound`) goes first; the default follows the question.
	 */
	const utteranceStep = async (
		messages: import("../../domains/inference/contracts").Messages,
		question: string,
		tools: ReadonlyArray<{ function: { name: string } }>,
		/** A routed turn's choice: an answer in words is the talk turn's, not this call's. */
		choosing = false,
	): Promise<Step> => {
		const scripted = options.firstRound?.(tools, question, messages);
		if (scripted) return scripted;
		// The conversation only hands the request to a toolchain; its sub-agent decides the rest.
		const delegates =
			!!options.routeTool ||
			!!options.history ||
			(!!options.timers && /タイマー/.test(question)) ||
			/天気|株価|weather|stock|調べ|検索|https?:|確認/.test(question);
		if (options.clarify || !delegates)
			return choosing ? {} : { text: await reply(messages) };
		const handed = handedStep(messages);
		if (handed) return handed;
		const named = options.history
			? "conversation_history"
			: options.routeTool
				? options.routeTool
				: options.timers && /タイマー/.test(question)
					? "timer"
					: "web_search";
		const wanted = store.read(
			(db) =>
				toolchain.capabilities
					.toolchainsInTransaction(db)
					.find((chain) => chain.functionName === named)?.id,
		);
		const handOver = (toolchain: string): Step => ({
			calls: [
				delegate(toolchain, question, {
					announcement: "お調べします。",
					impact:
						options.timers && /タイマー/.test(question) ? "create" : "none",
				}),
			],
		});
		const candidates = candidatesOf(messages);
		if (!candidates) return { calls: [findToolchain(question)] };
		const chosen =
			candidates.find((card) => card.id === wanted) ?? candidates[0];
		if (!chosen) return { text: UNAVAILABLE_TEXT };
		if (chosen.execution === "instant")
			return { calls: [instantExecute(chosen.id, question, {})] };
		return handOver(chosen.id);
	};
	const model: LarmPort = {
		status: () => ({ state: "ready", capabilities: ["llm", "asr", "tts"] }),
		connect: async () => {},
		close: async () => {},
		transcribe: async () => options.voiceText ?? "fixture speech",
		speak: async (text) => {
			if (options.speechFailure) throw new Error("fixture_tts_failed");
			spoken.push(text);
			const wav = new Uint8Array(48);
			wav.set(new TextEncoder().encode("RIFF"));
			wav.set(new TextEncoder().encode("WAVE"), 8);
			return wav;
		},
		answer: async (messages, _signal, callOptions) => {
			calls++;
			if (options.pursuit) {
				const system = messages[0]?.content ?? "";
				const marker = system.lastIndexOf("OUTPUT_SCHEMA=");
				const question = messages
					.filter((m) => m.role === "user")
					.at(-1)?.content;
				let packet: { delegatedRequest?: unknown; state?: unknown } = {};
				try {
					packet = JSON.parse(question ?? "{}");
				} catch {
					/* Not a structured control call. */
				}
				if (
					marker >= 0 &&
					typeof packet.delegatedRequest === "string" &&
					typeof packet.state === "string"
				)
					return JSON.stringify(
						options.pursuit(
							JSON.parse(system.slice(marker + "OUTPUT_SCHEMA=".length)),
							messages,
						),
					);
			}
			if (messages[0]!.content.includes("転記された発話の主要な言語"))
				return JSON.stringify({
					status: "identified",
					languages: ["ja"],
					confidence: 0.99,
				});
			const system = messages[0]!.content;
			if (
				options.specialist &&
				system.includes(collaborationInstructions.rules)
			) {
				const value = await options.specialist(messages, _signal, callOptions);
				return typeof value === "string" ? value : JSON.stringify(value);
			}
			// The default fixture declines operations on the prose-only route review.
			const question = messages
				.filter((m) => m.role === "user")
				.at(-1)!.content;
			if (
				callOptions?.tools?.some((t) => t.function.name === "report_partial")
			) {
				const step = options.taskStep?.(callOptions.tools, messages);
				if (!step) throw new Error("fixture_task_step_missing");
				callOptions.onToolCalls!([
					{
						id: crypto.randomUUID(),
						name: step.name,
						arguments: JSON.stringify(step.arguments),
					},
				]);
				return "";
			}
			// The router's fill of a structured answer to a work's question, from the same script.
			if (callOptions?.jsonSchema && system === ANSWER_FILL)
				return answerByScript(messages, (loop) =>
					utteranceStep(
						loop as never,
						utteranceOf(messages),
						CONVERSATION_TOOLS,
						true,
					),
				);
			// The local harness's routed turn: a silent choice held to a schema, from the same script.
			const round = callOptions?.jsonSchema ? choiceRound(messages) : null;
			if (round)
				return choiceByScript(messages, round, (loop) =>
					utteranceStep(
						loop as never,
						utteranceOf(messages),
						CONVERSATION_TOOLS,
						true,
					),
				);
			if (isUtteranceRound(callOptions) && !isNoticeRound(messages)) {
				const step = await utteranceStep(
					messages,
					utteranceOf(messages),
					callOptions!.tools!,
				);
				if (step.calls?.length)
					callOptions!.onToolCalls!(
						callsOf(step, () => crypto.randomUUID()) as never,
					);
				return step.text ?? "";
			}
			if (
				callOptions?.tools?.some((t) => t.function.name === "check_request")
			) {
				completionContexts.push(JSON.stringify(messages));
				completionToolChoices.push(callOptions.toolChoice);
				completionOutputLimits.push(callOptions.maxOutputTokens);
				const step = offeredKinds(
					callOptions.tools,
					options.completion?.(callOptions.tools, messages) ?? {
						name: "check_request",
						arguments: {
							conditions: [{ condition: question, step: 1 }],
							achieved: "",
							need: "",
						},
					},
				);
				callOptions.onToolCalls!([
					{
						id: crypto.randomUUID(),
						name: step.name,
						arguments: JSON.stringify(step.arguments),
					},
				]);
				return "";
			}
			if (options.structure && system === TURN_STRUCTURE_PROMPT.system)
				return JSON.stringify({ decision: options.structure(messages) });
			if (options.compose && !callOptions?.tools?.length) {
				const packet = JSON.parse(question);
				if (Array.isArray(packet.cards) && "providedMaterials" in packet)
					return JSON.stringify(options.compose(messages));
			}
			if (system.includes("あなたはこのツールチェーンの操作担当です")) {
				commandContexts.push(JSON.stringify(messages));
				if (
					options.commandGate &&
					(!options.commandGateQuestion ||
						question.includes(options.commandGateQuestion))
				)
					await options.commandGate;
				if (options.command) return options.command(messages);
				const data = JSON.parse(question) as {
					request: string;
					snapshot?: {
						items?: Array<{ id: string; state: string; revision: number }>;
					} | null;
				};
				const invoke = (tool: string, args: unknown) =>
					JSON.stringify({ action: "invoke", tool, arguments: args });
				// The user's words are the request's first line; the earlier utterance after it is only context.
				const asked = askedOf(data.request);
				if (/確認|残り/.test(asked)) return invoke("timer.list", {});
				if (/取消|止め/.test(asked)) {
					const targets =
						data.snapshot?.items?.filter((item) => item.state === "active") ??
						[];
					if (targets.length !== 1)
						return JSON.stringify({
							action: "clarify",
							question: "どのタイマーを止めますか？",
						});
					return invoke("timer.cancel", {
						timerId: targets[0]!.id,
						expectedRevision: targets[0]!.revision,
					});
				}
				const seconds = /^(\d+)秒/.exec(asked);
				const durationSeconds = seconds
					? Number(seconds[1])
					: /1時間/.test(asked)
						? 3600
						: /3分30秒/.test(asked)
							? 210
							: 180;
				return invoke("timer.start", {
					durationSeconds,
					...(options.timerExtra ? { scope: "other" } : {}),
				});
			}
			if (system.includes("TOOLS=")) {
				const data = workerPacket(messages);
				if (data.draftReport)
					return JSON.stringify(fixtureVerification(data.draftReport));
				workerContexts.push(JSON.stringify(messages));
				const output = (value: unknown) =>
					fixtureResearchOutput(data, JSON.stringify(value));
				if (options.control) {
					const result = await options.control(messages);
					if (result !== undefined) return fixtureResearchOutput(data, result);
				}
				if (options.workerOutput !== undefined) return options.workerOutput;
				if (options.badJson) return "```json\n{}\n```";

				const available = JSON.parse(
					system.split("TOOLS=")[1]!.split("\n")[0]!,
				);
				const page = data.observations.find(
					(o: any) =>
						o.basis === "page" &&
						(!options.incompleteWeatherFirstRead ||
							o.excerpts.some((e: any) => e.quote.includes("最高"))),
				);
				if (page) {
					if (options.workerReportOutput !== undefined)
						return fixtureResearchOutput(data, options.workerReportOutput);
					const excerpt = page.excerpts[0];
					const forged =
						options.badQuote || (options.badQuoteOnce && !quoteRejected);
					quoteRejected = true;
					return output({
						action: "finish",
						report: {
							outcome: "answered",
							summary: excerpt.quote.split("\n")[0],
							claims: [
								{
									text: excerpt.quote.split("\n")[0],
									evidence: [forged ? "e999" : excerpt.reference],
								},
							],
							limitations: [],
						},
					});
				}
				const seen = new Set(
					data.observations
						.filter((o: any) => o.basis === "page")
						.map((o: any) => o.url),
				);
				const hit =
					data.observations.find(
						(o: any) => o.basis === "snippet" && !seen.has(o.url),
					) ??
					data.candidates?.find(
						(candidate: { url: string }) => !seen.has(candidate.url),
					);
				const tool = available.find(
					(t: any) => t.id === (hit ? "web.read" : "web.lookup"),
				);
				if (!tool)
					return output({
						action: "finish",
						report: {
							outcome: "failed",
							summary: "確認できませんでした。",
							claims: [],
							limitations: ["取得予算がありません。"],
						},
					});
				const first =
					data.operations.length === 0 &&
					!messages.some((m) => m.content.includes("拒否コード="));
				return output({
					action: "invoke",
					tool: options.badExecutionRefOnce && first ? "unknown" : tool.id,
					arguments:
						options.badToolArgs && first
							? { unexpected: "bad" }
							: hit
								? { url: hit.url }
								: { query: data.task.question.slice(0, 400) },
				});
			}
			return reply(messages);
		},
	};
	const inference = createInference(store, settings, {
		...options.inferenceOptions,
		larmFactory: () => options.model ?? model,
	});
	const queue = createQueue(store, {
		resources: { "inference.llm": 1, "inference.aux": 2, "web.fetch": 6 },
		pollMs: 5,
		limits: options.queueLimits,
	});
	const acquisition = researchAcquisition(options, () => {
		acquisitions++;
	});
	const web = createWebResearch({
		store,
		queue,
		acquisition: options.acquisition ?? acquisition,
		acquisitionTimeoutMs: options.acquisitionTimeoutMs,
		review: options.review,
	});
	const scheduler = createScheduler(store, queue, { now: options.timerNow });
	const timers = options.timers
		? createTimers(
				store,
				{ scheduler, queue },
				{
					now: options.timerNow,
					publish: () => changes.publish(),
					onElapsedInTransaction: createTimerAnnouncements(conversation),
				},
			)
		: undefined;
	const compute = options.computePort
		? createCompute({
				store,
				queue,
				port: () => options.computePort!,
				pollMs: 5,
				onFinished: computeAnnouncements(conversation),
				validInTransaction: (db, r) =>
					!r.authorization_json ||
					toolchain.agents.executions.authorizeChildInTransaction(
						db,
						JSON.parse(r.authorization_json),
					),
			})
		: undefined;
	await compute?.refresh();
	// The data-driven settings and records screens, as the server composes them.
	const toolchainLinks = createToolchainHostLinks({
		settings,
		inference,
		conversation,
		ttsDictionary: createTtsDictionary(store),
	});
	const markdown = options.markdown
		? createMarkdown({ store, queue, archive: options.markdown })
		: undefined;
	const uiCompositions = options.uiCompositions
		? createUiCompositions()
		: undefined;
	const ocr = options.ocrFetcher
		? createOcr({
				store,
				queue,
				connection: () => settings.ocrCredentials(),
				fetcher: options.ocrFetcher,
				analyses: options.visual
					? createAnalysisFactory(store, queue, options.visual)
					: undefined,
				inference,
				capabilities: () => activeCapabilities,
			})
		: undefined;
	let activeCapabilities: import("../../domains/capabilities").Capabilities;
	const dotsWork = options.dots
		? createDotsHarness(store, conversation, () => activeCapabilities)
		: undefined;
	const browser = options.browser?.(store, queue, () => activeCapabilities);
	if (browser)
		browser.requests = {
			userMessageInTransaction: (db, id) => {
				const message = conversation.messageInTransaction(db, id)?.message;
				return message?.role === "user" ? message.text : null;
			},
		};
	const toolchain = await createToolchain(store, queue, inference, web, {
		webResearch: options.webResearch,
		docling: options.docling,
		compute,
		browser,
		...toolchainLinks.options,
		dots: !!dotsWork,
		dotsWork: dotsWork?.work,
		dotsConfiguration: dotsWork?.dots.config,
		embed: options.embed,
		timers,
		conversation: options.history ? conversation : undefined,
		reconcileThrottleMs: 0,
		music: !!options.musicGateway,
		image: !!options.imageGateway,
		uiCompositions,
		markdown,
		excalidraw: !!options.drawingConnection,
		objectRecognition: !!options.recognitionFetcher,
		ocr,
		shell,
		terminals,
		kanban,
		kanbanSdk,
		weather: options.weather,
		stock: options.stock,
	});
	activeCapabilities = toolchain.capabilities;
	await dotsWork?.setup();
	const music = options.musicGateway
		? createMusic({
				validateExecutionInTransaction:
					toolchain.agents.executions.authorizeChildInTransaction,
				store,
				queue,
				inference,
				capabilities: toolchain.capabilities,
				gateway: options.musicGateway,
				onJob: (db, runId, jobId) =>
					dialogue.linkOperationJobInTransaction(db, runId, jobId),
				onFinished: (db, runId) =>
					dialogue.finishOperationInTransaction(db, runId),
				onWaiting: (db, runId, untilMs) =>
					dialogue.extendOperationDeadlineInTransaction(db, runId, untilMs),
			})
		: undefined;
	const image = options.imageGateway
		? createImage({
				validateExecutionInTransaction:
					toolchain.agents.executions.authorizeChildInTransaction,
				store,
				queue,
				inference,
				capabilities: toolchain.capabilities,
				gateway: options.imageGateway,
				onJob: (db, runId, jobId) =>
					dialogue.linkOperationJobInTransaction(db, runId, jobId),
				onFinished: (db, runId) =>
					dialogue.finishOperationInTransaction(db, runId),
				onWaiting: (db, runId, untilMs) =>
					dialogue.extendOperationDeadlineInTransaction(db, runId, untilMs),
			})
		: undefined;
	const excalidraw = options.drawingConnection
		? createExcalidraw({
				store,
				connection: options.drawingConnection,
				webOrigin: process.env.EUMENES_ORIGIN ?? "http://127.0.0.1:5173",
				fetch: options.drawingFetch,
				pollMs: 5,
				idleMs: options.drawingIdleMs,
			})
		: undefined;
	const drawingOperations = excalidraw
		? registerDrawingOperations({
				validateExecutionInTransaction:
					toolchain.agents.executions.authorizeChildInTransaction,
				store,
				queue,
				inference,
				capabilities: toolchain.capabilities,
				service: excalidraw,
				onJob: (db, runId, jobId) =>
					dialogue.linkOperationJobInTransaction(db, runId, jobId),
				onFinished: (db, runId) =>
					dialogue.finishOperationInTransaction(db, runId),
				onWaiting: (db, runId, untilMs) =>
					dialogue.extendOperationDeadlineInTransaction(db, runId, untilMs),
			})
		: undefined;
	const objectRecognition = options.recognitionFetcher
		? createObjectRecognition({
				store,
				queue,
				connection: () => settings.objectRecognitionCredentials(),
				fetcher: options.recognitionFetcher,
				analyses: options.visual
					? createAnalysisFactory(store, queue, options.visual)
					: undefined,
			})
		: undefined;
	// The function a search for `query` finds first: the test's fixed embedding stands in for the model's.
	const discovery = (query: string) =>
		options.discoveryTarget?.(query) ??
		(options.history
			? "conversation_history"
			: (options.routeTool ??
				(options.uiCompositions
					? "ui_create"
					: options.weather && /天気/.test(query)
						? "weather_forecast"
						: options.stock && /株価/.test(query)
							? "stock_quote"
							: options.timers && /タイマー/.test(query)
								? "timer"
								: "web_search")));
	const routing = createToolchainRouting(
		toolchain.capabilities,
		toolchain.history,
		options.embed
			? toolchain.embedQuery
			: fixtureDiscovery(store, toolchain.capabilities, discovery),
		toolchain.registry,
		toolchain.schemas,
	);
	// The router decides every utterance turn: its context judgment is the conversation's script (the test's own model
	// when it has one), asked as the old choice call asked it.
	await attachFixtureRouter({
		store,
		inference,
		routing,
		settings,
		capabilities: toolchain.capabilities,
		...(options.embed ? {} : { discovery }),
		ask: options.model
			? askModel(options.model)
			: (messages, round) =>
					choiceByScript(messages as never, round, (loop) =>
						utteranceStep(
							loop as never,
							utteranceOf(messages as never),
							CONVERSATION_TOOLS,
							true,
						),
					),
	});
	const continuity = createContinuityService();
	const memory = options.memory
		? createMemoryService(store, conversation, continuity, {
				journalPath: join(dir, "journal.jsonl"),
			})
		: undefined;
	await memory?.recover();
	const resources = fixtureResources(
		store,
		toolchain.capabilities,
		options,
		image,
		music,
	);
	const dialogue = createDialogueService({
		conversationAgent: testConversationAgent,
		excalidraw: drawingOperations,
		objectRecognition: objectRecognition?.port(CONVERSATION_DEFAULT_PRINCIPAL),
		image,
		music,
		store,
		conversation,
		continuity,
		...(memory ? { memory } : {}),
		...(resources
			? {
					resources: {
						registry: resources.registry,
						producesInTransaction: (db, toolchainId) =>
							toolchain.capabilities.producesInTransaction(db, toolchainId),
					},
				}
			: {}),
		larm: inference,
		queue,
		agents: toolchain.agents,
		toolchains: routing,
		specialist: createSpecialistPort({
			routing,
			registry: toolchain.registry,
			schemas: toolchain.schemas,
			clock: () => new Date().toISOString(),
		}),
	});
	toolchainLinks.attachDialogue(dialogue);
	let executionPort: ReturnType<typeof configureTaskExecution> | undefined;
	if (options.everyday || options.pipelines || options.pursuit) {
		// The everyday task agent is suspended: its bundle is never seeded, so the fixtures of that
		// implementation register it explicitly. Pipelines need only the parent execution's port.
		const registered = options.everyday
			? await store.write((db) =>
					toolchain.capabilities.importBundleInTransaction(
						db,
						dormantBundleFile("task-execution"),
						bundleHostOf(toolchain.registry),
					),
				)
			: { issues: [] };
		if (registered.issues.length) throw new Error("dormant_bundle_rejected");
		executionPort = configureTaskExecution({
			settings,
			pursuit: toolchain.pursuit,
			collaboration: toolchain.collaboration,
			interact: browser?.interact,
			memory,
			queue,
			childOperations: toolchain.childOperations,
			store,
			capabilities: toolchain.capabilities,
			agents: toolchain.agents,
			routing,
			registry: toolchain.registry,
			dialogue,
			conversation,
			inference,
			browser: browser?.service,
			media: taskMediaPorts({ image, music, excalidraw: drawingOperations }),
			...(resources ? { resources: resources.registry } : {}),
			legacy: taskLegacyPorts(dialogue),
		});
	}
	const voice = createVoiceDialogue(store, dialogue, inference);
	if (terminals) reportFinishedTasks(terminals, dialogue);
	if (shell) reportShellRuns(shell, dialogue);
	const app = createApp({
		token: "fixture-token-for-toolchain-browser",
		origin: process.env.EUMENES_ORIGIN ?? "http://localhost",
		modules: appModules({
			markdown,
			docling: options.docling,
			changes,
			excalidraw,
			drawingOperations,
			image,
			objectRecognition,
			ocr,
			compute,
			music,
			settings,
			conversation,
			dialogue,
			voice,
			larm: inference,
			queue,
			scheduler,
			inference,
			timers,
			shell,
			terminals,
			kanban,
			toolchainHistory: toolchain.history,
			toolchainActions: toolchain.actionRequests,
			...toolchain,
			...(resources ? { resources: { access: resources } } : {}),
		}),
	});
	toolchain.agents.start();
	if (options.pursuit) toolchain.pursuit?.start();
	queue.start();
	const request = async (path: string, body?: unknown) =>
		app.request(path, {
			method: body ? "POST" : "GET",
			headers: {
				authorization: "Bearer fixture-token-for-toolchain-browser",
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});
	return {
		executionPort,
		resources: resources?.registry,
		dir,
		memory,
		dotsWork,
		browser,
		shell,
		terminals,
		kanban,
		excalidraw,
		drawingOperations,
		image,
		uiCompositions,
		markdown,
		objectRecognition,
		ocr,
		compute,
		music,
		app,
		store,
		dialogue,
		conversation,
		toolchain,
		routing,
		timers,
		scheduler,
		queue,
		request,
		parentContexts,
		/** The conversation's open TODOs (the ledger the agency asks from). */
		todos: (conversationId = "main") =>
			store.read((db) => dialogue.todosInTransaction(db, conversationId)),
		/**
		 * The result of the conversation's newest finished TODO as text. Finished work is archived as it finishes and
		 * told by its notice, not by a conversation reply of the run, so the work's own result is what a test reads.
		 */
		reported: (conversationId = "main") => {
			const done = store
				.read((db) =>
					dialogue.todoPageInTransaction(db, conversationId, {
						state: "archived",
						pageIndex: 0,
						pageSize: 10,
					}),
				)
				.rows.find((row) => row.outcome !== "cancelled");
			return done ? JSON.stringify(done.result ?? null) : "";
		},
		voice,
		settings,
		inference,
		spoken,
		workerContexts,
		routeContexts,
		completionContexts,
		completionToolChoices,
		completionOutputLimits,
		commandContexts,
		get acquisitions() {
			return acquisitions;
		},
		get calls() {
			return calls;
		},
		async close() {
			await toolchain.pursuit?.close();
			await browser?.service.disconnect();
			await kanbanRuns?.disconnect();
			terminals?.closeAll();
			shell?.closeAll();
			unsubscribeChanges();
			changes.close();
			await toolchain.agents.close();
			await scheduler.close();
			await queue.close(100);
			await web.close();
			await dialogue.close();
			await voice.close();
			await inference.close();
			await excalidraw?.close();
			await store.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
