/** Read-only replay of frozen cases with the Eumenes selection adapter. No jobs are dispatched. */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	routeWithSelection,
	type SelectionMode,
	type SelectionPorts,
} from "eumenes_router";
import { createLarmPlayground } from "../api/domains/larm";
import { createToolchainHistory } from "../api/domains/toolchain-history";
import { createRouterSelection } from "../api/domains/inference/service/router-selection";
import { read } from "../api/domains/settings/repository";
import { resolveLarmToken } from "../api/infrastructure/auth-config";
import type { SqliteStore } from "../api/infrastructure/sqlite";
import { liveLarmSettings } from "./live-larm";

const { values } = parseArgs({
	options: {
		run: { type: "boolean" },
		out: { type: "string" },
		case: { type: "string" },
		recorded: { type: "boolean" },
		"cases-file": { type: "string" },
	},
});
if (!values.run || !values.out) throw new Error("usage_requires_run_and_out");
const file = resolve(
	values["cases-file"] ??
		"spec/verification/project-issues-first-batch-2026-11-06/routing-cases.json",
);
const bytes = readFileSync(file);
const datasetHash = createHash("sha256").update(bytes).digest("hex");
const frozen = readFileSync(file.replace(/\.json$/, ".freeze.json"), "utf8");
if (!frozen.includes(datasetHash)) throw new Error("evaluation_input_changed");

type Case = {
	id: string;
	origin: string;
	input: string;
	pending: Array<{
		ref: string;
		work: string;
		state: string;
		question: string;
	}>;
};
const cases = (JSON.parse(bytes.toString()).cases as Case[]).filter(
	(item) =>
		(!values.case || item.id === values.case) &&
		(!values.recorded || item.origin === "recorded_fixture_conversation"),
);
const db = new Database(process.env.EUMENES_DB || "./data/eumenes.sqlite3", {
	readonly: true,
});
try {
	const snapshot = read(db);
	const decision = createRouterSelection({
		get: () => snapshot,
		credential: () => null,
	});
	if (!decision.routerSelectionAvailable())
		throw new Error("router_selection_unavailable");
	const saved = liveLarmSettings();
	const token = resolveLarmToken(process.env);
	if (!saved.baseUrl || !token) throw new Error("router_embedding_unavailable");
	const embedder = createLarmPlayground({
		...saved,
		baseUrl: saved.baseUrl,
		token,
	});
	const history = createToolchainHistory({
		read: (fn) => fn(db),
	} as SqliteStore);
	const rows: unknown[] = [];
	const cached = new Map<
		string,
		Awaited<ReturnType<SelectionPorts["embed"]>>
	>();
	await Promise.all(
		cases.map(async (item) => {
			const pending = item.pending
				.filter((q) => q.state === "asking")
				.map((q) => ({
					ref: q.ref,
					title: q.work,
					question: q.question,
				}));
			for (const mode of [
				"conversation",
				"tools-only",
			] as const satisfies SelectionMode[]) {
				const started = performance.now();
				const signal = AbortSignal.timeout(snapshot.router.structureTimeoutMs);
				try {
					const result = await routeWithSelection(
						{
							embed: async (texts) => {
								const key = JSON.stringify(texts);
								const previous = cached.get(key);
								if (previous) return previous;
								const embedded = await embedder.embed(
									[...texts],
									"passage",
									signal,
								);
								cached.set(key, embedded);
								return embedded;
							},
							read: {
								cards: (query) => {
									const cards = history.routerCardsInTransaction(db, {
										...query,
										available: () => true,
									});
									if (mode === "conversation") return cards;
									return cards.filter(
										(card) => card.kind !== "pipeline" && card.kind !== "read",
									);
								},
								lexical: (text) => history.routerLexicalInTransaction(db, text),
								nearFeedback: (query) =>
									history.nearRouterFeedbackInTransaction(db, {
										...query,
										vector: [...query.vector],
									}),
							},
							select: (prompt) => decision.selectRouter(prompt, signal),
							settings: snapshot.router,
						},
						{
							state: {
								text: item.input,
								previousAgent: pending.at(-1)?.question ?? null,
								previousUser: null,
							},
							pending,
							dynamic: pending.map((q) => ({
								id: q.ref,
								kind: "pending",
								operation: "answer",
								title: q.title,
								passage: q.question,
								todo: q.ref.split(".")[0]!,
							})),
							available: () => true,
						},
						{ mode, signal },
					);
					rows.push({
						id: item.id,
						mode,
						ms: Math.round(performance.now() - started),
						to: result.decision.to,
						candidate:
							"candidate" in result.decision
								? result.decision.candidate.id
								: null,
						parts: result.parts.map((part) => ({
							selection:
								part.selection.kind === "candidate"
									? part.selection.id
									: part.selection.kind,
							top: part.candidates.map(
								({ candidate, searchRank, matchScore }) => ({
									id: candidate.id,
									searchRank,
									matchScore,
								}),
							),
						})),
					});
				} catch (error) {
					const code =
						error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
							? error.message
							: "evaluation_failed";
					rows.push({
						id: item.id,
						mode,
						ms: Math.round(performance.now() - started),
						code,
					});
				}
			}
		}),
	);
	writeFileSync(
		values.out,
		JSON.stringify({ datasetHash, reasoning: "none", rows }, null, 2) + "\n",
		{ mode: 0o600 },
	);
} finally {
	db.close();
}
