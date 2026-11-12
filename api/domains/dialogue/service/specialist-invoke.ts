import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import type { Receipt } from "../../inference";
import { insertSessionEvent } from "../repository";
import type { DialogueDeps } from "./context";
import { isDocTool, runDocTool } from "./specialist-agent";
import { safeCode } from "./specialist-core";
import type { SpecialistAction } from "./specialist-prompt";
import type { TurnInput } from "./specialist-turn";

const log = getLogger("dialogue");
/** The longest repair hint of a refused operation that reaches the specialist. */
const DETAIL_CHARS = 1000;
const DROPPED_PART = /^drop_(part|parts|form|model)(:|$)/;

/** The session changed under the turn (cancelled, returned, re-addressed, expired): nothing more is done. */
export class StaleTurn extends Error {
	constructor(code: string) {
		super(code);
	}
}

/** What the next call reads of an operation, and what the turn decides by. */
type InvokeResult =
	| {
			ok: true;
			result: unknown;
			dropped?: boolean;
			handoff?: import("../../tool-runtime").SpecialistHandoff;
	  }
	| {
			ok: false;
			error: string;
			detail?: string | string[];
			/** A whole-document write failed its check and was kept as the rejected draft. */
			kept?: boolean;
			[key: string]: unknown;
	  };

/** One operation of the set, run in its own writer transaction; a refusal is data for the next call. */
export async function invokeSpecialistTool(
	deps: DialogueDeps,
	input: TurnInput,
	action: Extract<SpecialistAction, { kind: "invoke" }>,
	stillMine: (tx: Database) => void,
	receipts: Receipt[],
	signal: AbortSignal,
): Promise<InvokeResult> {
	const port = deps.specialist!;
	const record = (
		tx: Database,
		outcome: { ok: boolean; error?: string; revision?: number },
	) =>
		insertSessionEvent(
			tx,
			input.sessionId,
			{
				kind: "tool",
				runId: input.runId,
				tool: action.tool,
				...outcome,
				...sizeOf(action.arguments),
			},
			deps.clock(),
		);
	/**
	 * A refusal is recorded on its own (the operation's transaction rolled back), only while the session still
	 * addresses this turn: a cancelled or ended turn leaves no late record.
	 */
	const refused = (error: string) =>
		deps.store.write((tx) => {
			try {
				stillMine(tx);
			} catch {
				return;
			}
			record(tx, { ok: false, error });
		});
	/** Check the authority of every result used to choose this operation before any mutation. */
	const authorized = (tx: Database) => {
		stillMine(tx);
		signal.throwIfAborted();
		for (const receipt of receipts)
			if (!deps.larm.validateReceiptInTransaction?.(tx, receipt))
				throw new StaleTurn("permission_revoked");
	};
	if (action.tool === input.guidanceToolId && port.guidance) {
		try {
			const document = port.documentOf(input.adapterRef);
			const revision = deps.store.read((tx) => {
				authorized(tx);
				return document?.readInTransaction(tx, input.workRef)?.revision;
			});
			if (revision === undefined) throw Error("workspace_unavailable");
			const assertCurrent = (tx: Database) => {
				authorized(tx);
				if (
					document?.readInTransaction(tx, input.workRef)?.revision !== revision
				)
					throw Error("guidance_revision_changed");
			};
			const result = await port.guidance.select(action.arguments, {
				sessionId: input.sessionId,
				sessionEpoch: input.epoch,
				runId: input.runId,
				bindingRevisionId: input.set.bindingRevisionId,
				revision,
				language: input.guidanceLanguage,
				report: input.guidanceReport,
				deadline: input.deadline,
				signal,
				assertCurrent,
			});
			await deps.store.write((tx) => {
				assertCurrent(tx);
				record(tx, { ok: true });
			});
			return { ok: true, result };
		} catch (error) {
			if (error instanceof StaleTurn || signal.aborted) throw error;
			const code = safeCode(error, "guidance_unavailable");
			await refused(code);
			return { ok: false, error: code };
		}
	}
	if (isDocTool(action.tool) && input.set.agent.document) {
		const document = port.documentOf(input.adapterRef);
		if (!document) {
			await refused("workspace_unavailable");
			return { ok: false, error: "workspace_unavailable" };
		}
		const tool = action.tool;
		const outcome = await deps.store.write((tx) => {
			authorized(tx);
			const done = runDocTool(tx, document, tool, action.arguments, input);
			record(tx, {
				ok: done.ok,
				...(!done.ok ? { error: done.error } : {}),
				...(done.revision !== undefined ? { revision: done.revision } : {}),
			});
			return done;
		});
		port.afterCommit(input.adapterRef);
		if (!outcome.ok) {
			const issue = outcome.issues?.[0];
			log.warn("dialogue.operation_rejected", {
				reason: "specialist_operation_refused",
				validationCode: outcome.error,
				// A position and a rule name only, as for an operation's repair hint; for an edit not found, the
				// edit's position and the kind of mismatch (never the text).
				...(issue
					? { repairHint: `${issue.path}: ${issue.rule}`.slice(0, 200) }
					: outcome.mismatch
						? { repairHint: `edits/${outcome.index}: ${outcome.mismatch}` }
						: {}),
			});
			return outcome;
		}
		const dropped = outcome.fixes?.some((fix) => DROPPED_PART.test(fix));
		return { ok: true, result: outcome, ...(dropped ? { dropped } : {}) };
	}
	const checked = port.parseInvocation(
		input.set,
		action.tool,
		action.arguments,
	);
	if (!checked.ok) {
		log.warn("dialogue.operation_rejected", {
			reason: "specialist_arguments_invalid",
			validationCode: checked.code,
		});
		await refused(checked.code);
		return {
			ok: false,
			error: checked.code,
			...(checked.detail?.length ? { detail: checked.detail } : {}),
		};
	}
	try {
		deps.store.read(authorized);
		const prepared = await port.prepareRead?.(
			input.set,
			{
				operationName: checked.operationName,
				input: checked.input,
				origin: {
					kind: "specialist",
					sessionId: input.sessionId,
					runId: input.runId,
					conversationId: input.conversationId,
					workRef: input.workRef,
				},
			},
			signal,
		);
		const result = await deps.store.write((tx) => {
			authorized(tx);
			const done = port.invokeInTransaction(tx, input.set, {
				operationName: checked.operationName,
				input: checked.input,
				requestId: crypto.randomUUID(),
				sessionId: input.sessionId,
				runId: input.runId,
				conversationId: input.conversationId,
				workRef: input.workRef,
				prepared,
			});
			const revision = (done.answerContext as { revision?: unknown } | null)
				?.revision;
			record(tx, {
				ok: true,
				...(typeof revision === "number" ? { revision } : {}),
			});
			return done;
		});
		port.afterCommit(input.adapterRef);
		return {
			ok: true,
			result: result.answerContext,
			handoff: result.specialistHandoff,
		};
	} catch (error) {
		if (error instanceof StaleTurn || signal.aborted) throw error;
		const code = safeCode(error, "operation_failed");
		// A short repair hint the operation attached (never a definition): data for the next call.
		const detail = (error as { detail?: unknown }).detail;
		await refused(code);
		log.warn("dialogue.operation_rejected", {
			reason: "specialist_operation_refused",
			validationCode: code,
			// The hint names a position and a rule only, so it is safe to keep for finding why drafts fail.
			...(typeof detail === "string" && detail
				? { repairHint: detail.slice(0, 200) }
				: {}),
		});
		return {
			ok: false,
			error: code,
			...(typeof detail === "string" && detail
				? { detail: detail.slice(0, DETAIL_CHARS) }
				: {}),
		};
	}
}

/** What an operation carried, as counts only (spec §8.1): edits, or the characters of a whole text. */
function sizeOf(args: Record<string, unknown>): {
	size?: Record<string, number>;
} {
	const size: Record<string, number> = {};
	if (Array.isArray(args.edits)) size.edits = args.edits.length;
	if (typeof args.text === "string") size.chars = args.text.length;
	if (args.definition !== undefined)
		size.chars = JSON.stringify(args.definition).length;
	return Object.keys(size).length ? { size } : {};
}
