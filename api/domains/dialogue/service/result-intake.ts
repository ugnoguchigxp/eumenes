import type { Database } from "bun:sqlite";
import type { AnswerTicket } from "../../agent-runtime";
import {
	executionNoticeResult,
	type ExecutionStatus,
} from "../../tool-runtime";
import type { SelectionOutcome } from "../../toolchain-history";
import type { Run } from "../contracts";
import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { eventLine } from "./context-document";
import { eventFields } from "./event-fields";
import { researchCitations } from "./research-citations";
import type { DialogueDeps, GenerateInput, GeneratePayload } from "./context";
import type { WorkOutcome, WorkRow } from "../repository/work";

type Report =
	| { status: "waiting"; questionId: string; question: string }
	| { status: "done"; outcome: WorkOutcome; result: unknown };

const executionOutcome: Partial<Record<ExecutionStatus, WorkOutcome>> = {
	completed: "succeeded",
	partial: "partial",
	failed: "failed",
	cancelled: "cancelled",
	interrupted: "interrupted",
};

const reportOutcome: Record<string, WorkOutcome> = {
	answered: "succeeded",
	partial: "partial",
	not_found: "partial",
	failed: "failed",
};

/** The outcome a toolchain's own record says it ended with (a media job's state or error). */
function recordOutcome(result: unknown): WorkOutcome {
	const record = (result ?? {}) as { state?: unknown; errorCode?: unknown };
	if (record.errorCode) return "failed";
	return record.state === "failed"
		? "failed"
		: record.state === "cancelled"
			? "cancelled"
			: "succeeded";
}

/** A research or action sub-agent's answer as one result (section 9.2); its ticket is consumed by the adoption. */
function agentReport(ticket: AnswerTicket): Report {
	if (ticket.failureCode)
		return {
			status: "done",
			outcome: "failed",
			result: { code: ticket.failureCode },
		};
	if (ticket.actionPayload)
		return {
			status: "done",
			outcome: ticket.actionFailure ? "failed" : "succeeded",
			result: JSON.parse(ticket.actionPayload) as unknown,
		};
	const projection = ticket.projection
		? (JSON.parse(ticket.projection) as { outcome?: string })
		: null;
	return {
		status: "done",
		outcome: reportOutcome[projection?.outcome ?? ""] ?? "succeeded",
		result: projection,
	};
}

const selectionOutcome: Record<WorkOutcome, SelectionOutcome> = {
	succeeded: "completed",
	partial: "partial",
	failed: "failed",
	cancelled: "cancelled",
	interrupted: "failed",
};

/**
 * What the work this run waited for brought back (the ContextWindow specification, sections 9.1 and 9.3): each
 * owner's record is reported into its TODO, whose result slot (`active`) the conversation then reads. Returns the
 * TODOs that changed (none: nothing new to speak about), or null when the run reports no work at all.
 */
export function intakeInTransaction(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	payload: GeneratePayload,
): WorkRow[] | null {
	const ledger = deps.work;
	if (!ledger) return null;
	const changed: WorkRow[] = [];
	const report = (row: WorkRow, next: Report) => {
		const saved = ledger.reportInTransaction(tx, row.id, next);
		if (!saved) return;
		changed.push(saved);
		if (next.status === "done")
			deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
				outcome: selectionOutcome[next.outcome],
			});
	};
	if (run.sourceKind === "notice") {
		const notice = taskNotice(deps, tx, run);
		if (!notice) return null;
		const row = ledger.workOfSourceInTransaction(tx, notice.workRef);
		if (row && notice.report) report(row, notice.report);
		return changed;
	}
	const waiting = ledger.waitingOfRunInTransaction(tx, run.id);
	if (waiting.length === 0) return null;
	for (const row of waiting) {
		const next = runReport(deps, tx, run, row, payload);
		if (next) report(row, next);
	}
	return changed;
}

/** The report of one piece of run-centric work, or null while its owner has nothing new. */
function runReport(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	row: WorkRow,
	payload: GeneratePayload,
): Report | null {
	const media =
		row.execution === "excalidraw"
			? deps.excalidraw
			: row.execution === "image"
				? deps.image
				: row.execution === "music-create" || row.execution === "music-playback"
					? deps.music
					: undefined;
	if (media) {
		const result =
			("referenceInTransaction" in media
				? media.referenceInTransaction?.(tx, run.id)
				: null) ?? media.resultInTransaction(tx, run.id);
		return result === null || result === undefined
			? null
			: { status: "done", outcome: recordOutcome(result), result };
	}
	if (row.execution === "command" && payload.commandNote) {
		const asked = deps.interactions?.questionOfRunInTransaction(tx, run.id);
		return asked
			? {
					status: "waiting",
					questionId: asked.questionId,
					question: asked.prompt,
				}
			: {
					status: "done",
					outcome: "partial",
					result: { question: payload.commandNote },
				};
	}
	const recognized = deps.objectRecognition?.resultInTransaction(tx, run.id);
	if (recognized)
		return {
			status: "done",
			outcome: recordOutcome(recognized),
			result: recognized,
		};
	const receipt = deps.delegation?.prepareInTransaction(tx, run).receipt;
	if (receipt)
		return { status: "done", outcome: recordOutcome(receipt), result: receipt };
	const ticket = answerTicketInTransaction(deps, tx, run);
	return ticket ? agentReport(ticket) : null;
}

/** The run's sub-agent answer waiting to be spoken about, or null (none, or its evidence no longer holds). */
export function answerTicketInTransaction(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
): AnswerTicket | null {
	if (!run.agentTaskId || !deps.agents) return null;
	try {
		return deps.agents.prepareAnswerInTransaction(tx, run.id);
	} catch {
		return null;
	}
}

/** A task execution's notice (a host notice run): its question or its result, by the execution's id. */
function taskNotice(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
): { workRef: string; report: Report | null } | null {
	const text = deps.conversation.messageInTransaction(tx, run.inputMessageId)
		?.message.text;
	let raw: { kind?: unknown; workRef?: unknown };
	try {
		raw = JSON.parse(text ?? "") as { kind?: unknown; workRef?: unknown };
	} catch {
		return null;
	}
	if (
		(raw.kind !== "task_question" && raw.kind !== "task_result") ||
		typeof raw.workRef !== "string"
	)
		return null;
	const view = deps.agents?.executions.viewInTransaction(tx, raw.workRef);
	if (!view || view.conversationId !== run.conversationId)
		return { workRef: raw.workRef, report: null };
	if (view.status === "waiting_user" && view.question)
		return {
			workRef: view.id,
			report: {
				status: "waiting",
				questionId: view.question.id,
				question: view.question.prompt,
			},
		};
	const outcome = executionOutcome[view.status];
	return {
		workRef: view.id,
		report: outcome
			? { status: "done", outcome, result: executionNoticeResult(view.result) }
			: null,
	};
}

/**
 * Right before the model speaks of a result, an operation's result is read again (a cancel after the report shows
 * at once): a changed result overwrites its TODO, joins the log as a new result event, and its line is added at the
 * end of the document's `<log>`. The rest of the prepared prompt stays as it was.
 */
export async function refreshActionResults(
	deps: DialogueDeps,
	input: GenerateInput,
): Promise<void> {
	const ledger = deps.work;
	const agents = deps.agents;
	// The answer is consumed as it is when the agent phrases it: a change since the prepare (a write queued before
	// this one) is read here too. One whose evidence no longer holds keeps the old ticket, which the adoption refuses.
	if (input.agent && agents)
		input.agent = await deps.store.write((tx) => {
			try {
				return agents.prepareAnswerInTransaction(tx, input.runId);
			} catch {
				return input.agent!;
			}
		});
	const todoIds = input.trigger.flatMap((trigger) =>
		trigger.kind === "todo_changed" && Array.isArray(trigger.todos)
			? (trigger.todos as Array<{ id?: unknown }>).flatMap((todo) =>
					typeof todo.id === "string" ? [todo.id] : [],
				)
			: [],
	);
	if (!ledger || !agents || todoIds.length === 0) return;
	const lines = await deps.store.write((tx) => {
		const reported = new Set<string>();
		for (const id of todoIds) {
			const row = ledger.workInTransaction(tx, id);
			if (!row || row.status !== "done" || row.archivedAt) continue;
			// Reading again is an aid: when the operation cannot be read now, the reported result stands.
			let payload: string | null;
			try {
				payload = agents.actionPayloadInTransaction(tx, row.runId);
			} catch {
				continue;
			}
			if (!payload || payload === JSON.stringify(row.result)) continue;
			ledger.reportInTransaction(tx, row.id, {
				status: "done",
				outcome: row.outcome ?? "succeeded",
				result: JSON.parse(payload) as unknown,
			});
			reported.add(row.id);
		}
		if (reported.size === 0) return [];
		const refs = ledger.refsInTransaction(tx, input.conversationId);
		return deps.continuity.events
			.logInTransaction(tx, input.conversationId)
			.filter((event) => {
				if (event.seq <= input.lastSeq || event.type !== "acted") return false;
				const fields = eventFields(event);
				return (
					fields.action === "work.result" && reported.has(String(fields.todo))
				);
			})
			.flatMap((event) => eventLine(event, refs) ?? []);
	});
	if (lines.length === 0) return;
	const before = input.document.sections.log.text;
	const after = before.replace(
		/\n<\/log>$/,
		() => `\n${lines.join("\n")}\n</log>`,
	);
	const document = input.messages[1]!;
	// A replacer function: the result text is external, and `$` patterns in a replacement string would be expanded.
	document.content = document.content.replace(before, () => after);
	input.document.sections.log = {
		text: after,
		tokens: estimateTextTokens(after),
	};
}

/**
 * The links of a reply that may report TODO results (those this generation was triggered by and those whose result
 * the window shows) are kept to what the results grant: a research report's own sources, written in the canonical
 * form; none for a result that has no sources. A reply with no result in view is left as it is.
 */
export function reportedLinks(
	deps: DialogueDeps,
	input: GenerateInput,
	text: string,
): string {
	const ledger = deps.work;
	if (!ledger || !text) return text;
	const triggered = input.trigger.flatMap((trigger) =>
		trigger.kind === "todo_changed" && Array.isArray(trigger.todos)
			? (trigger.todos as Array<{ id?: unknown }>).flatMap((todo) =>
					typeof todo.id === "string" ? [todo.id] : [],
				)
			: [],
	);
	const ids = [...new Set([...triggered, ...input.shown.todos])];
	if (ids.length === 0) return text;
	const results = deps.store.read((db) =>
		ids.flatMap((id) => {
			const row = ledger.workInTransaction(db, id);
			return row?.status === "done" ? [row.result] : [];
		}),
	);
	if (results.length === 0) return text;
	const reports = results.filter(
		(result): result is { sources: unknown[]; claims?: unknown[] } =>
			!!result &&
			typeof result === "object" &&
			Array.isArray((result as { sources?: unknown }).sources),
	);
	if (reports.length === 0)
		return researchCitations(text, null, { preserveLinkLabels: false });
	const projection = JSON.stringify({
		sources: reports.flatMap((report) => report.sources),
		claims: reports.flatMap((report) => report.claims ?? []),
	});
	return researchCitations(text, projection, { requireSources: true });
}

/** Consumes the sub-agent's answer an adopted generation spoke of; one no longer valid drops its result. */
export function consumeAnswer(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	ticket: AnswerTicket,
): boolean {
	const agents = deps.agents;
	if (!agents) return true;
	try {
		// Completing checks the ticket against the answer as it is now.
		agents.completeAnswerInTransaction(tx, ticket);
		return true;
	} catch {
		deps.work?.dropRunResultsInTransaction(tx, run.id);
		return false;
	}
}
