import type { LlmPort } from "eumenes-agency";
import { createAgencyStatePort } from "../../domains/dialogue";
import { createAgencyHost } from "./host";
import { choice, updated, wireOp } from "./host.fixture";
import { settle, waitFor } from "../../infrastructure/wait-for";
import type { harness } from "../toolchain/toolchain.fixture";

/** Scripted decisions over the real host, writer, registry, queue, owners and resource ledger. */
export function actionHost(
	h: Awaited<ReturnType<typeof harness>>,
	action: { id: string; question: string; arguments?: Record<string, unknown> },
	options: {
		discover?: boolean;
		speakFirst?: boolean;
		inputTokens?: number;
		afterRecall?: boolean;
	} = {},
) {
	let now = Date.now(),
		phase = 0,
		timerId = 0;
	const timers = new Map<number, { at: number; fn: () => void }>();
	const inference = { busy: false };
	const stats = { timerCallbacks: 0 };
	const steps = [
		...(options.speakFirst ? ["speak"] : []),
		...(options.discover ? ["find_toolchain"] : []),
		"delegate",
	];
	const port = createAgencyStatePort({
		agents: h.toolchain.agents,
		toolchains: h.routing,
		execution: () => h.executionPort,
		store: h.store,
		settings: h.settings,
		resources: h.resources,
		producesInTransaction: h.toolchain.capabilities.producesInTransaction,
		memory: h.memory,
		now: () => now,
	});
	const target = h.store.read((db) =>
		port
			.catalogInTransaction(db)
			.find((c) => c.revisionId.startsWith(`toolchain:${action.id}@`)),
	)!;
	if (!target) throw new Error("fixture_capability_missing");
	const requests: Array<{ purpose: string; data: any }> = [];
	const llm: LlmPort = {
		async complete(request) {
			const d = JSON.parse(request.prompt);
			requests.push({ purpose: request.purpose, data: d });
			const intent = d.state?.intents[0];
			const candidate = (
				request.purpose === "update" ? d.state.candidates : d.candidates
			).find((c: any) => c.state !== "closed");
			const recalled = d.observations?.some(
				(o: { kind: string }) => o.kind === "recall.offered",
			);
			const step =
				options.afterRecall && phase > 0 && !recalled
					? undefined
					: steps[phase];
			const value =
				request.purpose === "update"
					? updated({
							interestOps:
								options.afterRecall && !d.state.interests?.length
									? [
											{
												op: "interest.add",
												id: null,
												localId: "interest",
												expectedRevision: null,
												status: null,
												topic: "散歩を楽しむ",
												origin: "user_relation",
												reason: "継続して楽しむ関心",
												derivedFrom: null,
												evidenceRefs: ["interest-user"],
											},
										]
									: [],
							ops:
								candidate || !step
									? []
									: [
											...(!intent
												? [
														wireOp("intent.add", {
															localId: "goal",
															state: "adopted",
															text: "関心に合う成果を届ける",
															reason: "会話からの関心",
															completionCondition: "確定した成果が開ける",
															resumeCondition: "静かな機会",
															withdrawCondition: "関心の撤回",
															hours: 1,
															evidenceRefs: ["interest-user"],
														}),
													]
												: []),
											wireOp("candidate.add", {
												localId: `action${phase}`,
												intentRef: intent?.id ?? "goal",
												kind: step === "speak" ? "question" : "tool",
												text: action.question,
												toolName: step === "speak" ? null : step,
												toolInput:
													step === "speak"
														? null
														: JSON.stringify(
																step === "find_toolchain"
																	? { query: action.question }
																	: {
																			revisionId: target.revisionId,
																			question: action.question,
																			...(action.arguments
																				? { arguments: action.arguments }
																				: {}),
																		},
															),
												applyWhen: "静かな機会",
												hours: 1,
												evidenceRefs: ["interest-user"],
											}),
										],
						})
					: candidate && step
						? {
								...choice(step === "speak" ? "speak" : "wait"),
								action: step === "speak" ? "speak" : "tool",
								candidateRef: {
									id: candidate.id,
									revision: candidate.revision,
								},
								evidenceRefs: ["interest-user"],
								emotion: null,
							}
						: { ...choice("wait"), emotion: null };
			if (request.purpose === "select" && candidate && step) phase++;
			return {
				value: request.schema.parse(value),
				model: "fixture",
				inputTokens: options.inputTokens ?? 1,
				outputTokens: 1,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	const makeHost = () =>
		createAgencyHost({
			store: h.store,
			conversation: h.conversation,
			settings: h.settings,
			state: port,
			inference: { foregroundBusy: () => inference.busy },
			memory: h.memory ?? {
				status: () => ({ enabled: true, healthy: true }),
				list: () => [],
			},
			createLlm: () => llm,
			conversationBusy: () => false,
			recordSpokeInTransaction: () => {},
			nowMs: () => now,
			setTimer: (fn, ms) => {
				timers.set(++timerId, {
					at: now + ms,
					fn: () => {
						stats.timerCallbacks++;
						fn();
					},
				});
				return timerId;
			},
			clearTimer: (id) => {
				timers.delete(id as number);
			},
		});
	let host = makeHost();
	h.memory?.registerForgetPurge(
		(db, input) => host.forgetInTransaction(db, input),
		(db, input) => host.planForgetInTransaction(db, input),
	);
	const rows = () =>
		h.store.read((db) =>
			db
				.query(
					"SELECT root_id,execution_id,returned,revoked,authority_json FROM dialogue_agency_work WHERE conversation_id='agency-action'",
				)
				.all(),
		) as Array<{
			root_id: string;
			execution_id: string;
			returned: number;
			revoked: number;
			authority_json: string | null;
		}>;
	return {
		port,
		target,
		requests,
		inference,
		stats,
		rows,
		get host() {
			return host;
		},
		async start() {
			host.start();
			await h.store.write((db) => {
				h.conversation.appendInTransaction(db, {
					id: "interest-user",
					conversationId: "agency-action",
					role: "user",
					text: "雲を眺めながらの散歩が好きです",
					runId: null,
					createdAt: new Date(now).toISOString(),
				});
				h.conversation.appendInTransaction(db, {
					id: "interest-reply",
					conversationId: "agency-action",
					role: "assistant",
					text: "雲の表情も楽しめそうですね。",
					runId: "fixture-reply",
					createdAt: new Date(now).toISOString(),
				});
				if (h.memory)
					h.memory.referenceInputs.recordRunInTransaction(
						db,
						"fixture-reply",
						h.memory.referenceInputs.captureInTransaction(db, {
							messageIds: ["interest-user"],
						}),
					);
			});
		},
		async advance(ms: number) {
			const end = now + ms;
			for (;;) {
				const due = [...timers.entries()]
					.filter(([, t]) => t.at <= end)
					.sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				now = Math.max(now, due[1].at);
				due[1].fn();
				await settle();
			}
			now = end;
			await settle();
		},
		returned: () =>
			waitFor(() => rows().some((w) => w.returned === 1), { timeout: 10000 }),
		async restart() {
			await host.close();
			host = makeHost();
			host.start();
			await settle();
		},
		close: () => host.close(),
	};
}
