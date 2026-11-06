/** Backend-only, read-only comparison on the frozen EUM001–006 cases. No jobs are dispatched. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	route,
	routeStructured,
	TURN_STRUCTURE_PROMPT,
	type RoutePorts,
	type RouteTurn,
} from "eumenes_router";
import { createClient } from "../client";
import {
	readApiToken,
	resolveLarmToken,
} from "../api/infrastructure/auth-config";
import type { SqliteStore } from "../api/infrastructure/sqlite";
import { createLarm, createLarmPlayground } from "../api/domains/larm";
import { createToolchainHistory } from "../api/domains/toolchain-history";
import { dynamicCandidates } from "../api/domains/dialogue/service/routed-route";
import { systemContext } from "../api/infrastructure/system-context";
import { routerIssueInference } from "./router-issue-inference";
import { liveLarmSettings } from "./live-larm";

const { values } = parseArgs({
	options: {
		run: { type: "boolean" },
		out: { type: "string" },
		case: { type: "string" },
		structured: { type: "boolean" },
		"structure-timeout-ms": { type: "string" },
	},
});
if (!values.run || !values.out) throw new Error("usage_requires_run_and_out");
const file = resolve(
	"spec/verification/project-issues-first-batch-2026-11-06/routing-cases.json",
);
const bytes = readFileSync(file);
const digest = (value: unknown) =>
	createHash("sha256")
		.update(typeof value === "string" ? value : JSON.stringify(value))
		.digest("hex");
const frozen = JSON.parse(
	readFileSync(
		file.replace("routing-cases.json", "routing-cases.freeze.json"),
		"utf8",
	),
);
const datasetHash = createHash("sha256").update(bytes).digest("hex");
if (!JSON.stringify(frozen).includes(datasetHash))
	throw new Error("evaluation_input_changed");
type Case = {
	id: string;
	split: string;
	input: string;
	pending: Array<{
		ref: string;
		work: string;
		state: string;
		question: string;
	}>;
};
const cases: Case[] = JSON.parse(bytes.toString()).cases;
const dbPath = process.env.EUMENES_DB || "./data/eumenes.sqlite3";
const client = createClient(
	process.env.EUMENES_URL || "http://127.0.0.1:8787",
	readApiToken(process.env, dbPath),
);
const settings = await client.routerSettings();
const structureTimeoutMs = Number(
	values["structure-timeout-ms"] ?? settings.structureTimeoutMs,
);
if (
	!Number.isInteger(structureTimeoutMs) ||
	structureTimeoutMs < 1000 ||
	structureTimeoutMs > 30000
)
	throw new Error("invalid_structure_timeout");
const saved = liveLarmSettings();
const token = resolveLarmToken(process.env);
if (!settings.profile || !saved.baseUrl || !token)
	throw new Error("saved_router_unconfigured");
const scorer = createLarm({
	...saved,
	baseUrl: saved.baseUrl,
	token,
	profile: settings.profile,
	decisionOnly: true,
	decisionCapability: "decision.context",
});
const embedder = createLarmPlayground({
	...saved,
	baseUrl: saved.baseUrl,
	token,
});
const db = new Database(dbPath, { readonly: true });
// Existing public domain reads borrow this readonly connection; no writer, migration or DB copy.
const store = { read: <T>(fn: (tx: Database) => T) => fn(db) } as SqliteStore;
const history = createToolchainHistory(store);
const rows: unknown[] = [];
const inference = values.structured ? await routerIssueInference(dbPath) : null;
const configuration = {
	datasetHash,
	entry: values.structured ? "routeStructured" : "route",
	structurePrompt: values.structured ? TURN_STRUCTURE_PROMPT.version : null,
	structureTimeoutMs,
	settingsHash: digest(settings),
	source: "adopted-package",
	variants: values.structured ? ["B"] : ["baseline", "A"],
	callsPerCaseAndVariant: 1,
	dispatch: false,
};
const output = () =>
	writeFileSync(
		values.out!,
		JSON.stringify({ configuration, rows }, null, 2) + "\n",
	);
output();
try {
	await scorer.connect();
	const cached = new Map<string, Awaited<ReturnType<typeof embedder.embed>>>();
	const embed: RoutePorts["embed"] = async (texts) => {
		if (texts.length !== 1)
			throw new Error("evaluation_embedding_batch_unexpected");
		const text = texts[0]!;
		let result = cached.get(text);
		if (!result) {
			result = await embedder.embed(
				[text],
				"passage",
				AbortSignal.timeout(2500),
			);
			cached.set(text, result);
		}
		return result;
	};
	const first = await embed([cases[0]!.input]);
	const model = history.routerModelInTransaction(db, first.space);
	if (!model) throw new Error("router_memory_missing");
	const cards = history.routerCardsInTransaction(db, {
		space: first.space,
		available: () => true,
	});
	const catalogHash = digest(cards);
	const memoryHash = digest(model);
	// Only description input changes. Search vectors, lexical index, learned parameters and thresholds stay fixed.
	const revised = cards.map((card) =>
		card.kind === "pipeline"
			? {
					...card,
					summary:
						"複数の仕事を一つの依頼全体として計画し、全ての結果を届ける。前段の結果を次へ使う仕事、互いに独立した仕事、同じ担当を複数回使う仕事も扱う。",
					useWhen: [
						"複数の実作業を依存順または並列に実行する",
						"一つの担当では依頼全体を完了できない",
						"同じ種類の操作を別々の対象や引数で複数回実行する",
					],
					examples: [],
				}
			: card,
	);
	for (const item of cases.filter(
		(item) => !values.case || item.id === values.case,
	)) {
		const active = item.pending.filter((q) => q.state === "asking");
		const questions = active.map((q) => ({
			ref: Number(q.ref.slice(1).split(".")[0]),
			title: q.work,
			question: q.question,
		}));
		const routed = {
			memory: null,
			earlier: [],
			state: "",
			previousReply: questions.at(-1)?.question ?? null,
			asked: null,
			pending: { confirmations: [], questions },
			todos: questions.map((q) => ({ ref: q.ref, title: q.title, open: true })),
			resources: [],
			switching: null,
		};
		const dynamic = dynamicCandidates({
			routed,
			redirect: null,
			switching: null,
			titles: () => new Map(),
		});
		for (const variant of values.structured
			? (["B"] as const)
			: (["baseline", "A"] as const)) {
			const turn: RouteTurn = {
				state: {
					text: item.input,
					previousAgent: routed.previousReply,
					previousUser: null,
				},
				pending: active.map((q) => ({
					ref: q.ref,
					title: q.work,
					question: q.question,
				})),
				dynamic:
					variant !== "A"
						? dynamic
						: dynamic.map((c) =>
								c.kind === "pending" && c.operation === "answer"
									? {
											...c,
											passage: `現在、既存の仕事「${c.title}」が利用者の回答を待っている。質問「${questions.find((q) => c.id === `t${q.ref}.answer`)!.question}」への今回の回答を、この仕事へ戻して続ける。新しい独立した仕事を始める操作ではない。`,
										}
									: c,
							),
				retained: [],
				available: () => true,
				instructions: systemContext(
					"dialogue.contexts.local.router-instructions",
					{},
				),
			};
			const started = performance.now();
			try {
				const ports: RoutePorts = {
					embed,
					rerank: (input) =>
						scorer.route!(input, AbortSignal.timeout(settings.timeoutMs)),
					read: {
						cards: () => (variant === "A" ? revised : cards),
						lexical: (text) => history.routerLexicalInTransaction(db, text),
						nearFeedback: (query) =>
							history.nearRouterFeedbackInTransaction(db, {
								...query,
								vector: [...query.vector],
							}),
					},
					model,
					settings: {
						accept: settings.accept,
						low: settings.low,
						margin: settings.margin,
						approve: settings.approve,
						multi: settings.multi,
						feedbackNear: settings.feedbackNear,
						feedbackWeight: settings.feedbackWeight,
					},
				};
				const result = inference
					? await routeStructured(
							{
								...ports,
								analyze: (prompt) =>
									inference.analyze(
										prompt,
										structureTimeoutMs,
										settings.structureResourceId,
									),
							},
							turn,
						)
					: await route(ports, turn);
				const decision = result.decision;
				rows.push({
					id: item.id,
					split: item.split,
					variant,
					elapsedMs: Math.round(performance.now() - started),
					to: decision.to,
					row: decision.row,
					candidate: "candidate" in decision ? decision.candidate.id : null,
					structure: "structure" in result ? result.structure : null,
					steps:
						decision.to === "pipeline"
							? decision.steps.map((step) => ({
									candidate: step.candidate.id,
									after: step.after,
									decision: step.decision.to,
								}))
							: null,
					top: ("corrected" in result ? result.corrected : [])
						.slice(0, 3)
						.map((r) => ({ id: r.candidate.id, p: r.p })),
					catalogHash,
					memoryHash,
				});
			} catch (error) {
				if (values.structured && rows.length === 0 && error instanceof Error)
					console.error(
						JSON.stringify({
							failureKind: error.name,
							frames: error.stack
								?.split("\n")
								.filter((line) => line.trimStart().startsWith("at "))
								.slice(0, 6),
						}),
					);
				rows.push({
					id: item.id,
					split: item.split,
					variant,
					elapsedMs: Math.round(performance.now() - started),
					error:
						error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
							? error.message
							: "evaluation_failed",
				});
			}
			output();
			console.log(
				JSON.stringify({ id: item.id, variant, completed: rows.length }),
			);
		}
	}
} finally {
	await inference?.close();
	await scorer.close();
	db.close();
}
