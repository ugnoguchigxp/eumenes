import type { Database } from "bun:sqlite";
import { imageReferenceText } from "../../conversation";
import type { z } from "zod";
import {
	hash,
	isReadToolName,
	READ_TOOLS,
	readToolParameters,
	type readToolInputs,
	type ReadTool,
	type ReadToolName,
} from "../../capabilities";
import { jstDisplay } from "../../../infrastructure/jst-time";
import {
	LOG_SEVERITY,
	readLogEntries,
	type LogEntry,
} from "../../../infrastructure/log-reader";
import { systemContext } from "../../../infrastructure/system-context";
import type { Run } from "../contracts";
import { hiddenMessages, recentRuns } from "../repository";
import { sessionEventsOfRun } from "../repository/specialist";
import { recentWorkForRead, type WorkRow } from "../repository/work";
import type { DialogueDeps, GenerateInput } from "./context";
import type {
	ExecutorContext,
	ReadSources,
	ToolOutcome,
} from "./executor-context";
import type { ParsedCall } from "./generation-tools";
import { memoryItemLine } from "./result-text";
import { messageDigests, readDiagnostic } from "./diagnostic-evidence";
import { withheldIn } from "./memory-refs";

/*
 * The conversation's read tools (spec conversation-read-tools-design 2026-10-31): the host reads its own records for
 * the conversation agent — memory, the conversation log, the recent runs, the sub-agents' work and World — and hands
 * them back as records, never instructions. Nothing is changed by a read, and nothing forgotten is read: a message in
 * memory's block ledger is left out wherever it would show.
 */

/** How many items one `read_memory` call returns; the agency host reads the same number to record what a reply saw. */
export const READ_MEMORY_LIMIT = 16;

/** The bounds of one read (section 2.1). */
const LIMITS = {
	resultChars: 3000,
	/** One line of a result, whatever it holds. */
	lineChars: 600,
	memory: READ_MEMORY_LIMIT,
	history: 12,
	/** What one history search may return (its schema's most), before the forgotten messages are left out. */
	historySearch: 20,
	/** One record's words: a saved message, a request, a report. */
	textChars: 200,
	/** Stored work request text shown by `read_agents`. */
	workRequestChars: 300,
	/** The head of a run's utterance; a page's name. */
	headChars: 40,
	sourceChars: 80,
	/** Warnings told of one run. */
	warnings: 3,
	/** Runs and work items looked back over for `read_runs` / `read_agents`. */
	scannedRuns: 100,
	/** Per piece of work: pages, tools and specialist steps told. */
	sources: 3,
	tools: 6,
	sessionSteps: 3,
	/** How long the history search's session may live (it is released after the read). */
	historyMs: 60_000,
	/** How long the operational log is read for a read of runs. */
	logMs: 3_000,
} as const;

const TURN_LABELS: Readonly<Record<string, string>> = {
	talk: "会話",
	request: "依頼",
	pending: "保留の答え",
};

type Found = {
	lines: string[];
	more: number;
	partial?: true;
	partialMatch?: true;
	sources?: ReadSources;
};

const toolOf = (name: ReadToolName): ReadTool =>
	READ_TOOLS.find((tool) => tool.name === name)!;
const clip = (text: string, chars: number) => {
	const flat = [...text.replace(/\s+/g, " ").trim()];
	return flat.length > chars
		? `${flat.slice(0, chars).join("")}…`
		: flat.join("");
};
/** `MM-DD HH:MM` in Japan time. */
const when = (iso: string) => jstDisplay(Date.parse(iso)).slice(5, 16);
const codeText = (code: string | null | undefined) =>
	code ? `（${code}）` : "";

/**
 * The conversation's forgotten messages (memory's block ledger, its journal included), those an immediate forget hides
 * and those the memory holds back until the closure delete (asked one by one, as a read looks at them); empty without
 * memory (nothing can have been forgotten), null when the ledger cannot be read (the read then shows nothing).
 */
function blockedOf(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
): { has(messageId: string): boolean } | null {
	try {
		const known = new Set([
			...(deps.memory?.blockedMessageIdsOfConversationInTransaction(
				db,
				conversationId,
			) ?? []),
			...hiddenMessages(db, conversationId),
		]);
		const held = new Map<string, boolean>();
		return {
			has(messageId) {
				if (known.has(messageId)) return true;
				let hidden = held.get(messageId);
				if (hidden === undefined) {
					hidden = withheldIn(deps, db, [messageId]).has(messageId);
					held.set(messageId, hidden);
				}
				return hidden;
			},
		};
	} catch {
		return null;
	}
}

/** The read tools the conversation may use now: memory while it is usable, World with its reader, the rest always. */
export function availableReadTools(
	deps: DialogueDeps,
	db: Database,
): ReadToolName[] {
	return READ_TOOLS.filter(({ name }) =>
		name === "read_memory"
			? !!deps.memory?.readyInTransaction(db)
			: name === "read_agents"
				? !!deps.agents
				: name === "read_world"
					? !!deps.worldContext?.recordsInTransaction
					: true,
	).map(({ name }) => name);
}

/** The talk turn's native tools for these read tools. */
export function readToolDefinitions(names: readonly ReadToolName[]) {
	return names.map((name) => ({
		name,
		description: toolOf(name).description,
		parameters: readToolParameters(name),
	}));
}

/** The heading, the lines within the bound (the first ones kept, each bounded), and what was left out. */
function resultText(tool: ReadTool, found: Found): string {
	const subject = { subject: tool.subject };
	const partial = found.partial
		? [systemContext("dialogue.contexts.local.read-partial", {})]
		: [];
	if (!found.lines.length)
		return [
			systemContext("dialogue.contexts.local.read-none", subject),
			...partial,
		].join("\n");
	const head = systemContext("dialogue.contexts.local.read-found", subject);
	const kept: string[] = [];
	let size = head.length;
	for (const whole of found.lines) {
		const line = clip(whole, LIMITS.lineChars);
		if (size + 1 + line.length > LIMITS.resultChars) break;
		kept.push(line);
		size += 1 + line.length;
	}
	const left = found.lines.length - kept.length + found.more;
	return [
		head,
		...(found.partialMatch ? ["（一部語句一致）"] : []),
		...kept,
		...(left > 0
			? [
					systemContext("dialogue.contexts.local.read-more", {
						count: String(left),
					}),
				]
			: []),
		...partial,
	].join("\n");
}

/**
 * Memory's items by how strongly they relate to the query (all of them, newest first, without one), the ones `## Memory`
 * shows already left out: where each came from, and since when. Each State item carries the short reference of the
 * window the prompt's `## Memory` belongs to (the next number, as it is not shown there); a tendency reads as an
 * estimate and has none; a suppressed item says it is not to be brought up and has none (a reference is for what the
 * user may correct or forget). The references are handed out only while the run is still the current one: a call of a
 * run taken back writes nothing.
 */
async function memoryFound(
	x: ExecutorContext,
	query?: string,
): Promise<Found | null> {
	const { deps, input } = x;
	const memory = deps.memory;
	const recalled = memory?.recall({
		text: query ?? "",
		limit: LIMITS.memory,
		shown: new Set(input.memoryItemIds),
		omitShown: true,
		withPrevious: false,
		minScore: 0,
		audience: "tool",
	});
	if (!memory || !recalled) return null;
	const itemIds = recalled.items.map((item) => item.id);
	const items = await deps.store.write((tx) => {
		x.current(tx);
		const referable = recalled.items.flatMap((item) =>
			!item.id.startsWith("tendency:") && item.suppressed !== true
				? [{ itemId: item.id, revision: item.revision }]
				: [],
		);
		const refs = new Map(
			input.memory && referable.length
				? memory.shortRefs
						.assignInTransaction(tx, {
							conversationId: input.conversationId,
							windowKey: input.memory.refsKey,
							items: referable,
						})
						.map((ref) => [ref.itemId, ref.ref])
				: [],
		);
		return recalled.items.map((item) => ({
			...item,
			...(refs.has(item.id) ? { ref: refs.get(item.id) } : {}),
		}));
	});
	return {
		lines: items.map(memoryItemLine),
		more: recalled.matched - recalled.items.length,
		...(itemIds.length ? { sources: { itemIds } } : {}),
	};
}

function toolSummaryTag(
	calls: ReadonlyArray<{ name: string; arguments: string; result: string }>,
): string {
	if (!calls.length) return "";
	const labels = calls.slice(0, 3).map((call) => {
		let target = "";
		if (call.name === "delegate") {
			try {
				const args = JSON.parse(call.arguments) as Record<string, unknown>;
				const tc =
					typeof args.toolchainId === "string"
						? args.toolchainId
						: typeof args.toolchain === "string"
							? args.toolchain
							: "";
				if (tc) target = `(${tc})`;
			} catch {
				// ignore malformed args
			}
		}
		let extra = "";
		try {
			const res = JSON.parse(call.result) as Record<string, unknown>;
			if (typeof res.todo === "string") extra = `→${res.todo}`;
			else if (typeof res.confirmation === "string")
				extra = `→${res.confirmation}`;
		} catch {
			// plain text result
		}
		return `${call.name}${target}${extra}`;
	});
	return `[道具: ${labels.join("、")}]`;
}

function historyFound(
	deps: DialogueDeps,
	db: Database,
	input: GenerateInput,
	args: z.infer<(typeof readToolInputs)["read_history"]>,
): Found | null {
	const blocked = blockedOf(deps, db, input.conversationId);
	if (!blocked) return null;
	// The pending utterances are the current turn's: the log is read from before them.
	const current =
		input.final.kind === "utterances" ? input.final.messageIds[0] : undefined;
	const key = `read:${input.runId}`;
	try {
		const { candidates, cursor, scope, partialMatch } =
			deps.conversation.historySearchInTransaction(
				db,
				{
					key,
					conversationId: input.conversationId,
					deadline: Date.now() + LIMITS.historyMs,
					...(current ? { excludeMessageId: current } : {}),
				},
				{ ...args, query: args.query ?? "", limit: LIMITS.historySearch },
			);
		const kept = candidates.filter((view) => !blocked.has(view.messageId));
		const shown = kept.slice(0, LIMITS.history);
		const agentIds = shown
			.filter((view) => view.speaker !== "user")
			.map((view) => view.messageId);
		const toolByMessage = new Map<
			string,
			ReadonlyArray<{ name: string; arguments: string; result: string }>
		>();
		if (agentIds.length) {
			const utterances =
				deps.conversation.input.utterancesByMessageIdsInTransaction?.(
					db,
					input.conversationId,
					agentIds,
				) ?? [];
			for (const u of utterances)
				if (u.messageId && u.speaker === "agent" && u.toolCalls.length)
					toolByMessage.set(u.messageId, u.toolCalls);
		}
		const lines = shown.map((view) => {
			const tag = toolSummaryTag(toolByMessage.get(view.messageId) ?? []);
			return `- ${when(view.createdAt)} ${view.speaker === "user" ? "利用者" : "Eumenes"}: ${clip(view.text, LIMITS.textChars)} ${imageReferenceText((view.imageReferences ?? []).filter((ref) => !blocked.has(ref.messageId)))} ${tag}`.trimEnd();
		});
		const messageIds = shown.map((view) => view.messageId);
		return {
			lines,
			more: Math.max(0, kept.length - shown.length),
			...(partialMatch && lines.length ? { partialMatch: true as const } : {}),
			...(messageIds.length ? { sources: { messageIds } } : {}),
			// The search stops at its scan bound: what lies before it was not looked at.
			...(cursor !== null || !scope.scanComplete
				? { partial: true as const }
				: {}),
		};
	} finally {
		deps.conversation.releaseHistory(key);
	}
}

/** Each run's turn kind (the routed turn's log line) and its warnings, from the operational log. */
function logsByRun(entries: LogEntry[], run: Run) {
	const mine = entries.filter(
		(entry) =>
			entry.runId === run.id || (run.jobId && entry.jobId === run.jobId),
	);
	const routed = mine.find((entry) => entry.event === "dialogue.turn_routed");
	const warnings = mine
		.filter(
			(entry) =>
				(LOG_SEVERITY[String(entry.level)] ?? 0) >= LOG_SEVERITY.warn! &&
				entry.event !== "inference.cloud_selected",
		)
		.slice(0, LIMITS.warnings)
		.map(
			(entry) =>
				`${String(entry.event)}${typeof entry.reason === "string" ? `(${entry.reason})` : ""}`,
		);
	return {
		turn:
			typeof routed?.kind === "string" ? TURN_LABELS[routed.kind] : undefined,
		warnings,
	};
}

/** The operational log's lines for these ids, read for a bounded time (none after it). */
async function logEntries(
	file: string | undefined,
	ids: string[],
): Promise<LogEntry[]> {
	if (!file || !ids.length) return [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			readLogEntries(file, ids),
			new Promise<LogEntry[]>((resolve) => {
				timer = setTimeout(() => resolve([]), LIMITS.logMs);
			}),
		]);
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

async function runsFound(
	deps: DialogueDeps,
	input: GenerateInput,
	count: number,
): Promise<Found | null> {
	const rows = deps.store.read((db) => {
		const blocked = blockedOf(deps, db, input.conversationId);
		if (!blocked) return null;
		return recentRuns(db, input.conversationId, input.runId, LIMITS.scannedRuns)
			.filter((run) => !blocked.has(run.inputMessageId))
			.slice(0, count)
			.map((run) => ({
				run,
				said:
					deps.conversation.messageInTransaction(db, run.inputMessageId)
						?.message.text ?? "",
				usage: deps.toolchains?.usageOfRunInTransaction?.(db, run.id),
			}));
	});
	if (!rows) return null;
	const entries = await logEntries(
		deps.logFile?.(),
		rows.flatMap(({ run }) => [run.id, ...(run.jobId ? [run.jobId] : [])]),
	);
	const messageIds = rows.map(({ run }) => run.inputMessageId).filter(Boolean);
	return {
		lines: rows.map(({ run, said, usage }) => {
			const logs = logsByRun(entries, run);
			return [
				`- ${when(run.createdAt)} 発言「${clip(said, LIMITS.headChars)}」`,
				...(logs.turn ? [`回: ${logs.turn}`] : []),
				`担当: ${usage?.toolchainId ?? "なし"}`,
				`結果: ${run.status}${codeText(usage?.code ?? run.error)}`,
				...(logs.warnings.length ? [`警告: ${logs.warnings.join("、")}`] : []),
			].join(" ");
		}),
		more: 0,
		...(messageIds.length ? { sources: { messageIds } } : {}),
	};
}

/** A tool revision's tool id (`tool:web.lookup@2` → `web.lookup`). */
const toolName = (revisionId: string) =>
	/^tool:([^@]+)@/.exec(revisionId)?.[1] ?? revisionId;

function workResultSummary(result: WorkRow["result"]): string | null {
	if (!result || typeof result !== "object") return null;
	const rec = result as Record<string, unknown>;
	for (const key of ["summary", "text", "title", "message"]) {
		const val = rec[key];
		if (typeof val === "string" && val.trim())
			return clip(val, LIMITS.textChars);
	}
	return null;
}

function matchesAgentsFilter(
	text: string,
	toolchainId: string | null | undefined,
	args: z.infer<(typeof readToolInputs)["read_agents"]>,
): boolean {
	if (args.toolchain?.trim()) {
		const wanted = args.toolchain.normalize("NFKC").toLowerCase().trim();
		if (!(toolchainId ?? "").normalize("NFKC").toLowerCase().includes(wanted))
			return false;
	}
	if (args.query?.trim()) {
		const tokens = args.query
			.normalize("NFKC")
			.toLowerCase()
			.trim()
			.split(/[\s\u3000]+/)
			.filter(Boolean);
		const hay = text.normalize("NFKC").toLowerCase();
		if (!tokens.every((t) => hay.includes(t))) return false;
	}
	return true;
}

function agentsFound(
	deps: DialogueDeps,
	input: GenerateInput,
	args: z.infer<(typeof readToolInputs)["read_agents"]>,
): Found | null {
	const agents = deps.agents;
	if (!agents) return null;
	const count = args.count ?? 1;
	const loaded = deps.store.read((db) => {
		const blocked = blockedOf(deps, db, input.conversationId);
		if (!blocked) return null;
		const runs = recentRuns(
			db,
			input.conversationId,
			input.runId,
			LIMITS.scannedRuns,
		)
			.filter((run) => !blocked.has(run.inputMessageId))
			.map((run) => {
				const usage = deps.toolchains?.usageOfRunInTransaction?.(db, run.id);
				return {
					run,
					// A read the search offered is the conversation's own, not work handed over.
					usage:
						usage?.toolchainId && isReadToolName(usage.toolchainId)
							? undefined
							: usage,
					session: sessionEventsOfRun(db, run.id),
				};
			});
		const works = recentWorkForRead(
			db,
			input.conversationId,
			LIMITS.scannedRuns,
		).filter(
			(row) =>
				(row.request.trim() || row.title.trim()) &&
				!row.messageIds.some((id) => blocked.has(id)),
		);
		return { runs, works };
	});
	if (!loaded) return null;
	const workByRun = new Map<string, WorkRow>();
	for (const w of loaded.works)
		if (!workByRun.has(w.runId)) workByRun.set(w.runId, w);
	const seenRuns = new Set<string>();
	type Entry = {
		at: string;
		toolchainId: string | null | undefined;
		line: string;
		messageIds: string[];
	};
	const entries: Entry[] = [];
	for (const { run, usage, session } of loaded.runs) {
		seenRuns.add(run.id);
		const w = workByRun.get(run.id);
		const tasks = agents.list(run.id);
		if (!usage && !tasks.length && !session.length && !w) continue;
		const tools = new Map<string, number>();
		for (const task of tasks)
			for (const outcome of task.toolOutcomes) {
				const label = `${toolName(outcome.toolRevisionId)}(${outcome.state}${codeText(outcome.errorCode)})`;
				tools.set(label, (tools.get(label) ?? 0) + 1);
			}
		const root = tasks.find((task) => !task.parentTaskId) ?? tasks[0];
		let report: ReturnType<typeof agents.report> | null = null;
		if (root)
			try {
				report = agents.report(root.id);
			} catch {
				report = null;
			}
		const sources = (report?.sources ?? [])
			.slice(0, LIMITS.sources)
			.map((source) =>
				clip(source.title || source.url || "", LIMITS.sourceChars),
			)
			.filter(Boolean);
		const toolchainId = w?.toolchainId ?? usage?.toolchainId;
		const requestText =
			w?.request?.trim() || usage?.request || w?.title?.trim();
		const summaryText = report?.summary ?? workResultSummary(w?.result ?? null);
		const line = [
			`- ${when(w?.createdAt ?? run.createdAt)}${w ? ` t${w.ref}` : ""} 担当: ${toolchainId ?? "なし"}`,
			...(requestText
				? [`依頼: ${clip(requestText, LIMITS.workRequestChars)}`]
				: []),
			`状態: ${w?.outcome ?? w?.status ?? usage?.outcome ?? root?.status ?? run.status}${codeText(usage?.code ?? root?.errorCode)}`,
			...(tools.size
				? [
						`道具: ${[...tools]
							.slice(0, LIMITS.tools)
							.map(([label, n]) => (n > 1 ? `${label}×${n}` : label))
							.join("、")}`,
					]
				: []),
			...session
				.slice(0, LIMITS.sessionSteps)
				.map((event) =>
					event.kind === "handover"
						? `専門担当への引き渡し: ${clip(event.request, LIMITS.textChars)}`
						: `専門担当の操作: ${event.tool}(${event.ok ? "成功" : `失敗${codeText(event.error)}`})`,
				),
			...(sources.length ? [`見た所: ${sources.join("、")}`] : []),
			...(summaryText ? [`報告: ${clip(summaryText, LIMITS.textChars)}`] : []),
		].join(" ");
		const msgIds = [
			...(run.inputMessageId ? [run.inputMessageId] : []),
			...(w?.messageIds ?? []),
		];
		entries.push({
			at: w?.createdAt ?? run.createdAt,
			toolchainId,
			line,
			messageIds: msgIds,
		});
	}
	for (const w of loaded.works) {
		if (seenRuns.has(w.runId)) continue;
		const summaryText = workResultSummary(w.result);
		const requestText = w.request.trim() || w.title.trim();
		const line = [
			`- ${when(w.createdAt)} t${w.ref} 担当: ${w.toolchainId}`,
			...(requestText
				? [`依頼: ${clip(requestText, LIMITS.workRequestChars)}`]
				: []),
			`状態: ${w.outcome ?? w.status}`,
			...(summaryText ? [`報告: ${summaryText}`] : []),
		].join(" ");
		entries.push({
			at: w.createdAt,
			toolchainId: w.toolchainId,
			line,
			messageIds: [...w.messageIds],
		});
	}
	entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
	const filtered = entries.filter((entry) =>
		matchesAgentsFilter(entry.line, entry.toolchainId, args),
	);
	const selected = filtered.slice(0, count);
	const messageIds = [
		...new Set(selected.flatMap((entry) => entry.messageIds)),
	];
	return {
		lines: selected.map((entry) => entry.line),
		more: Math.max(0, filtered.length - selected.length),
		...(messageIds.length ? { sources: { messageIds } } : {}),
	};
}

function worldFound(
	deps: DialogueDeps,
	db: Database,
	names: readonly string[],
): Found | null {
	const records = deps.worldContext?.recordsInTransaction?.(db, names);
	if (!records) return null;
	const worldRefs = [
		...records.entities.map((entity) => `world:entity:${entity.name}`),
		...records.documents.map((document) => `world:document:${document.title}`),
	];
	return {
		lines: [
			...records.entities.map(
				(entity) =>
					`- ${entity.name}: ${entity.claims.length ? entity.claims.join(" / ") : "主張の記録なし"}`,
			),
			...records.documents.map(
				(document) =>
					`- 資料「${document.title}」: ${clip(document.opening, LIMITS.textChars)}`,
			),
		],
		more: 0,
		...(worldRefs.length ? { sources: { sources: worldRefs } } : {}),
	};
}

async function found(
	x: ExecutorContext,
	call: Extract<ParsedCall, { name: ReadToolName }>,
): Promise<Found | null> {
	const { deps, input } = x;
	const args = call.args;
	switch (call.name) {
		case "read_memory":
			return memoryFound(
				x,
				(args as z.infer<(typeof readToolInputs)["read_memory"]>).query,
			);
		case "read_history":
			return deps.store.read((db) =>
				historyFound(
					deps,
					db,
					input,
					args as z.infer<(typeof readToolInputs)["read_history"]>,
				),
			);
		case "read_runs":
			return runsFound(
				deps,
				input,
				(args as z.infer<(typeof readToolInputs)["read_runs"]>).count ?? 1,
			);
		case "read_agents":
			return agentsFound(
				deps,
				input,
				args as z.infer<(typeof readToolInputs)["read_agents"]>,
			);
		case "read_world":
			return deps.store.read((db) =>
				worldFound(
					deps,
					db,
					(args as z.infer<(typeof readToolInputs)["read_world"]>).names,
				),
			);
	}
}

/**
 * One read: the records as text for the conversation. A read that cannot be made says so; it never fails the run. A
 * read the search offered in this generation is that tool's decision in the selection record (as an instant answer is).
 */
export async function read(
	x: ExecutorContext,
	call: Extract<ParsedCall, { name: ReadToolName }>,
): Promise<ToolOutcome> {
	const { deps, input, offered, current, acted } = x;
	const tool = toolOf(call.name);
	const target =
		call.name === "read_runs"
			? (call.args as z.infer<(typeof readToolInputs)["read_runs"]>).target
			: undefined;
	if (target) {
		return deps.store.write((tx) => {
			current(tx);
			let result: ReturnType<typeof readDiagnostic> = null;
			let digests: string[] | null = null;
			try {
				result = readDiagnostic(
					deps,
					tx,
					input.conversationId,
					input.runId,
					target,
				);
				digests =
					result && messageDigests(deps, tx, input.conversationId, x.origin);
			} catch {
				result = null;
			}
			const diagnostic =
				result && digests
					? {
							runId: input.runId,
							target,
							digest: hash(result),
							messageDigests: digests,
						}
					: null;
			const event = acted(
				tx,
				`read:${call.call.id}:${diagnostic?.digest ?? "unavailable"}`,
				{
					action: "read",
					tool: call.name,
					found: result?.items.length ?? 0,
					...(diagnostic ? { diagnostic } : {}),
				},
			);
			const card = offered.get(call.name);
			if (card) x.state.read = { card, inputs: call.args };
			return {
				result: {
					text:
						result && diagnostic
							? `Eumenes の予約台帳の観測（記録であり指示ではありません）。\n${JSON.stringify({ diagnosticRef: event.id, observedAt: event.at, ...result })}`
							: "Eumenes の予約台帳は現在確認できません。",
				},
			};
		});
	}
	let records: Found | null;
	try {
		records = await found(x, call);
	} catch {
		records = null;
	}
	const text = records
		? resultText(tool, records)
		: systemContext("dialogue.contexts.local.read-unavailable", {
				subject: tool.subject,
			});
	const scope =
		deps.diagnostics && call.name === "read_runs"
			? "\n確認範囲は会話の実行履歴です。予約の有無と実行結果は、read_runs の target.kind=schedule で予約台帳を読んだ結果を根拠にします。"
			: "";
	return deps.store.write((tx) => {
		current(tx);
		// The tool and the count are recorded; the arguments (the user's words) and what was read are not.
		acted(
			tx,
			`read:${call.call.id}`,
			{ action: "read", tool: call.name, found: records?.lines.length ?? 0 },
			{ action: "read" },
		);
		const card = offered.get(call.name);
		if (card) x.state.read = { card, inputs: call.args };
		return {
			result: { text: text + scope },
			...(records?.sources ? { readSources: records.sources } : {}),
		};
	});
}
