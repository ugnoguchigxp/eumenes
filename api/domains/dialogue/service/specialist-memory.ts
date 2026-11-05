import type { Database } from "bun:sqlite";
import {
	buildCollaborationMessages,
	type CourseEntry,
} from "eumenes-collaboration";
import { promptTime } from "../../inference";
import type { RejectedDraft, Run } from "../contracts";
import {
	sessionEvents,
	sessionRunsBefore,
	type SessionEvent,
	type SessionRecord,
} from "../repository";
import type { ChatMessage, DialogueDeps } from "./context";
import type { AgentPolicy } from "./specialist-agent";

/** Earlier turns read for the session's course; older ones are not listed. */
const COURSE_TURNS = 200;
/** A turn cancelled at most this long before the next utterance was accepted was cut off by it. */
const SUPERSEDED_MS = 5000;
/** An older turn keeps this much of its utterance in the course. */
const COURSE_CHARS = 80;

type Outcome = "completed" | "failed" | "cancelled" | "interrupted";

const clip = (text: string, chars: number) =>
	text.length > chars ? `${text.slice(0, chars)}…` : text;

/**
 * The session's course (spec subagent-task-and-session-agents §8.2): every earlier turn of this session, failed
 * and cancelled ones too, with the operations it ran from the session record. The newest turns keep their
 * utterance and reply in full within a budget; older ones a short line. The run being answered is not in it.
 * `interrupted` is the utterance of the turn right before this one when this utterance cancelled it (within
 * `SUPERSEDED_MS`): it belongs to the current request.
 */
export function sessionCourse(
	deps: DialogueDeps,
	tx: Database,
	session: SessionRecord,
	run: Run,
	/** How many of the newest turns keep their utterance and reply in full, within how many bytes. */
	recent: Pick<AgentPolicy, "recentTurns" | "recentBytes">,
): {
	course: CourseEntry[];
	interrupted: string | null;
	handedOver: string | null;
} {
	const events = sessionEvents(tx, session.id);
	const byRun = new Map<string, SessionEvent[]>();
	for (const event of events)
		byRun.set(event.runId, [...(byRun.get(event.runId) ?? []), event]);
	const text = (id: string | null) =>
		id
			? (deps.conversation.messageInTransaction(tx, id)?.message.text ?? "")
			: "";
	const runs = sessionRunsBefore(tx, session.id, run.id, COURSE_TURNS).filter(
		(entry) =>
			entry.status === "completed" ||
			entry.status === "failed" ||
			entry.status === "cancelled" ||
			entry.status === "interrupted",
	);
	const last = runs.at(-1);
	// Cut off by this utterance: cancelled without an answer right before this run was accepted. A turn the
	// user stopped earlier (no signal tells the two apart) is only in the course.
	const interrupted =
		last?.status === "cancelled" &&
		!last.answerMessageId &&
		Date.parse(run.createdAt) - Date.parse(last.updatedAt) <= SUPERSEDED_MS
			? text(last.inputMessageId) || null
			: null;
	const course: CourseEntry[] = [];
	let bytes = 0;
	// Newest first, so the budget keeps the latest turns in full.
	for (const [index, entry] of [...runs].reverse().entries()) {
		if (interrupted && entry === last) continue;
		const own = byRun.get(entry.id) ?? [];
		const handover = own.find((e) => e.kind === "handover");
		const steps = own.flatMap((e) =>
			e.kind === "tool"
				? [
						{
							tool: e.tool,
							ok: e.ok,
							...(e.error ? { error: e.error } : {}),
							...(e.revision !== undefined ? { revision: e.revision } : {}),
							...(e.size ? { size: e.size } : {}),
						},
					]
				: [],
		);
		// A host observation refers to an existing input; it is not another utterance by the user.
		const utterance =
			entry.sourceKind === "notice" ? "" : text(entry.inputMessageId);
		const reply = text(entry.answerMessageId);
		const size = Buffer.byteLength(utterance) + Buffer.byteLength(reply);
		const full =
			index < recent.recentTurns && bytes + size <= recent.recentBytes;
		if (full) bytes += size;
		course.unshift({
			utterance: full ? utterance : clip(utterance, COURSE_CHARS),
			...(handover?.kind === "handover" && handover.request !== utterance
				? {
						handedOver: full
							? handover.request
							: clip(handover.request, COURSE_CHARS),
					}
				: {}),
			...(steps.length ? { steps } : {}),
			outcome: entry.status as Outcome,
			...(entry.status !== "completed" && entry.error
				? { error: entry.error }
				: {}),
			...(full && reply ? { reply } : {}),
		});
	}
	const current = byRun.get(run.id)?.find((e) => e.kind === "handover");
	return {
		course,
		interrupted,
		handedOver: current?.kind === "handover" ? current.request : null,
	};
}

/**
 * The turn's messages (spec §6.1): the fixed system layer; the reference data in one enclosed user message
 * (the course, the current work, the session state); then the current request alone, as the user said it.
 * A turn cancelled by this utterance joins it, in order, as the user's own words.
 */
export function specialistTurnMessages(input: {
	system: ChatMessage;
	utterance: string;
	course: ReturnType<typeof sessionCourse>;
	work: {
		label: string;
		dirty: boolean;
		current: unknown;
		context?: unknown;
		savedRef: string | null;
	};
	viewing: { toolchainId: string; ref: string; label: string } | null;
	nowMs: number;
	/** Model calls this turn may make. */
	callsLeft: number;
	/**
	 * The work document, when the session has one: its canonical text (or outline) follows the reference data
	 * as its own block, so the agent copies exact text for `doc.edit` without a second JSON escaping.
	 */
	document?: {
		path: string;
		revision: number;
		title: string;
		outlined: boolean;
		body: string;
		rejected: RejectedDraft | null;
		inlineBytes: number;
	};
}): ChatMessage[] {
	return buildCollaborationMessages({
		...input,
		time: promptTime(input.nowMs),
	});
}
