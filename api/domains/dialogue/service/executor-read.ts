import type { Database } from "bun:sqlite";
import type { z } from "zod";
import {
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
import { recentRuns } from "../repository";
import { intentJudgmentsOfMessage } from "../repository/intent";
import { sessionEventsOfRun } from "../repository/specialist";
import type { DialogueDeps, GenerateInput } from "./context";
import type { ExecutorContext, ToolOutcome } from "./executor-context";
import type { ParsedCall } from "./generation-tools";
import { memoryItemLine } from "./result-text";

/*
 * The conversation's read tools (spec conversation-read-tools-design 2026-10-31): the host reads its own records for
 * the conversation agent — memory, the conversation log, the recent runs, the sub-agents' work and World — and hands
 * them back as records, never instructions. Nothing is changed by a read, and nothing forgotten is read: a message in
 * memory's block ledger is left out wherever it would show.
 */

/** The bounds of one read (section 2.1). */
const LIMITS = {
	resultChars: 3000,
	/** One line of a result, whatever it holds. */
	lineChars: 600,
	memory: 16,
	history: 12,
	/** What one history search may return (its schema's most), before the forgotten messages are left out. */
	historySearch: 20,
	/** One record's words: a saved message, a request, a report. */
	textChars: 200,
	/** The head of a run's utterance; a page's name. */
	headChars: 40,
	sourceChars: 80,
	/** Warnings told of one run. */
	warnings: 3,
	/** Runs looked back over for the newest ones (forgotten ones and those without work are passed over). */
	scannedRuns: 20,
	/** Per piece of work: pages, tools and specialist steps told. */
	sources: 3,
	tools: 6,
	sessionSteps: 3,
	/** How long the history search's session may live (it is released after the read). */
	historyMs: 60_000,
	/** How long the operational log is read for a read of runs. */
	logMs: 3_000,
} as const;

const ROUTE_LABELS: Readonly<Record<string, string>> = {
	search: "依頼",
	answer: "会話",
	free: "判定で決めず",
};
const TURN_LABELS: Readonly<Record<string, string>> = {
	talk: "会話",
	request: "依頼",
	pending: "保留の答え",
};

type Found = { lines: string[]; more: number; partial?: true };

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
 * The conversation's forgotten messages (memory's block ledger, its journal included); empty without memory (nothing
 * can have been forgotten), null when the ledger cannot be read (the read then shows nothing).
 */
function blockedOf(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
): ReadonlySet<string> | null {
	try {
		return new Set(
			deps.memory?.blockedMessageIdsOfConversationInTransaction(
				db,
				conversationId,
			) ?? [],
		);
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

/** Memory's items as the profile shows them: where each came from, and whether `## Memory` shows it already. */
function memoryFound(
	deps: DialogueDeps,
	input: GenerateInput,
	query?: string,
): Found | null {
	const checked = deps.memory?.check({
		...(query ? { query } : {}),
		shown: new Set(input.memoryItemIds),
		limit: LIMITS.memory,
	});
	if (!checked) return null;
	return {
		lines: checked.items.map(memoryItemLine),
		more: checked.matched - checked.items.length,
	};
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
		const { candidates, cursor, scope } =
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
		const lines = candidates
			.filter((view) => !blocked.has(view.messageId))
			.map(
				(view) =>
					`- ${when(view.createdAt)} ${view.speaker === "user" ? "利用者" : "Eumenes"}: ${clip(view.text, LIMITS.textChars)}`,
			);
		return {
			lines: lines.slice(0, LIMITS.history),
			more: Math.max(0, lines.length - LIMITS.history),
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
				judged: intentJudgmentsOfMessage(db, run.inputMessageId).at(-1),
				usage: deps.toolchains?.usageOfRunInTransaction?.(db, run.id),
			}));
	});
	if (!rows) return null;
	const entries = await logEntries(
		deps.logFile?.(),
		rows.flatMap(({ run }) => [run.id, ...(run.jobId ? [run.jobId] : [])]),
	);
	return {
		lines: rows.map(({ run, said, judged, usage }) => {
			const logs = logsByRun(entries, run);
			return [
				`- ${when(run.createdAt)} 発言「${clip(said, LIMITS.headChars)}」`,
				...(judged
					? [
							`判定: ${judged.choice ?? "なし"}→${ROUTE_LABELS[judged.finalRoute] ?? judged.finalRoute}`,
						]
					: []),
				...(logs.turn ? [`回: ${logs.turn}`] : []),
				`担当: ${usage?.toolchainId ?? "なし"}`,
				`結果: ${run.status}${codeText(usage?.code ?? run.error)}`,
				...(logs.warnings.length ? [`警告: ${logs.warnings.join("、")}`] : []),
			].join(" ");
		}),
		more: 0,
	};
}

/** A tool revision's tool id (`tool:web.lookup@2` → `web.lookup`). */
const toolName = (revisionId: string) =>
	/^tool:([^@]+)@/.exec(revisionId)?.[1] ?? revisionId;

function agentsFound(
	deps: DialogueDeps,
	input: GenerateInput,
	count: number,
): Found | null {
	const agents = deps.agents;
	if (!agents) return null;
	const runs = deps.store.read((db) => {
		const blocked = blockedOf(deps, db, input.conversationId);
		if (!blocked) return null;
		return recentRuns(db, input.conversationId, input.runId, LIMITS.scannedRuns)
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
	});
	if (!runs) return null;
	const lines: string[] = [];
	for (const { run, usage, session } of runs) {
		if (lines.length >= count) break;
		const tasks = agents.list(run.id);
		if (!usage && !tasks.length && !session.length) continue;
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
		lines.push(
			[
				`- ${when(run.createdAt)} 担当: ${usage?.toolchainId ?? "なし"}`,
				...(usage?.request
					? [`依頼: ${clip(usage.request, LIMITS.textChars)}`]
					: []),
				`状態: ${usage?.outcome ?? root?.status ?? run.status}${codeText(usage?.code ?? root?.errorCode)}`,
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
				...(report?.summary
					? [`報告: ${clip(report.summary, LIMITS.textChars)}`]
					: []),
			].join(" "),
		);
	}
	return { lines, more: 0 };
}

function worldFound(
	deps: DialogueDeps,
	db: Database,
	names: readonly string[],
): Found | null {
	const records = deps.worldContext?.recordsInTransaction?.(db, names);
	if (!records) return null;
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
	};
}

async function found(
	deps: DialogueDeps,
	input: GenerateInput,
	call: Extract<ParsedCall, { name: ReadToolName }>,
): Promise<Found | null> {
	const args = call.args;
	switch (call.name) {
		case "read_memory":
			return memoryFound(
				deps,
				input,
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
				(args as z.infer<(typeof readToolInputs)["read_agents"]>).count ?? 1,
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
	let records: Found | null;
	try {
		records = await found(deps, input, call);
	} catch {
		records = null;
	}
	const text = records
		? resultText(tool, records)
		: systemContext("dialogue.contexts.local.read-unavailable", {
				subject: tool.subject,
			});
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
		return { result: { text } };
	});
}
