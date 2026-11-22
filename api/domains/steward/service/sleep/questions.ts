import type { Database } from "bun:sqlite";
import type {
	GoalInput,
	GoalInstruction,
	RecordId,
	UnresolvedConflict,
} from "eumenes-consolidation";
import { getLogger } from "../../../../infrastructure/logger";
import type { PlanItem } from "../../../continuity";
import type { StewardDeps } from "../types";

const log = getLogger("steward");

/** A record's wording in a question: long text is cut, quotes inside are not needed. */
const ASKED_CHARS = 120;
const clip = (text: string) =>
	[...text.trim().replace(/\s+/gu, " ")].slice(0, ASKED_CHARS).join("");
/** Messages one question stands on, at most. */
const EVIDENCE_MESSAGES = 6;

type Grounds = {
	conversationId: string | null;
	messages: Array<{ messageId: string; conversationId: string }>;
	memoryItemIds: string[];
};

/**
 * What a record stands on: for a long-term record (L2), its own id and the user's messages its evidence names (the
 * conversation that holds each). A candidate or a tendency has no item id the plan store could hold, so it adds
 * nothing but the messages the library gave.
 */
function groundsOf(
	db: Database,
	deps: StewardDeps,
	records: readonly RecordId[],
	sources: ReadonlyArray<{ conversationId: string; messageId: string }>,
): Grounds {
	const messages = new Map<
		string,
		{ messageId: string; conversationId: string }
	>();
	for (const source of sources)
		messages.set(source.messageId, {
			messageId: source.messageId,
			conversationId: source.conversationId,
		});
	const memoryItemIds = new Set<string>();
	const items = new Map(
		deps.memory
			.stateItemsInTransaction(db, true)
			.map((item) => [item.itemId, item]),
	);
	for (const record of records) {
		if (record.layer !== "L2") continue;
		const item = items.get(record.id);
		if (!item) continue;
		memoryItemIds.add(item.itemId);
		for (const ref of item.evidence) {
			if (ref.namespace !== "conversation" || messages.has(ref.id)) continue;
			const found = deps.conversation.messageInTransaction(db, ref.id);
			if (found)
				messages.set(ref.id, {
					messageId: ref.id,
					conversationId: found.message.conversationId,
				});
		}
	}
	const kept = [...messages.values()].slice(0, EVIDENCE_MESSAGES);
	return {
		conversationId: kept[0]?.conversationId ?? null,
		messages: kept,
		memoryItemIds: [...memoryItemIds],
	};
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((id) => b.includes(id));

/**
 * Whether a question about the same thing is already waiting: the same wording, or (for a contradiction between
 * two long-term records) the same pair of records. A question the user answered (closed) may be asked anew.
 */
function alreadyAsked(
	waiting: readonly PlanItem[],
	text: string,
	memoryItemIds: readonly string[],
): boolean {
	return waiting.some(
		(plan) =>
			plan.text === text ||
			(memoryItemIds.length >= 2 && sameSet(plan.memoryItemIds, memoryItemIds)),
	);
}

/**
 * Saves a question to ask the user as an open question of `continuity` (L3). The agent reads it as a plan and
 * may bring it up. The savepoint keeps a refusal (a limit, a bad text) from touching the unit's other work.
 */
function ask(
	db: Database,
	deps: StewardDeps,
	waiting: PlanItem[],
	question: { text: string; grounds: Grounds },
): "saved" | "kept" | "refused" {
	const { text, grounds } = question;
	if (
		grounds.conversationId === null ||
		(grounds.messages.length === 0 && grounds.memoryItemIds.length === 0)
	)
		return "refused";
	if (alreadyAsked(waiting, text, grounds.memoryItemIds)) return "kept";
	db.exec("SAVEPOINT steward_ask");
	try {
		const plan = deps.continuity.plans.addInTransaction(db, {
			conversationId: grounds.conversationId,
			kind: "open_question",
			text,
			evidence: {
				messages: grounds.messages.map((m) => ({
					messageId: m.messageId,
					conversationId: m.conversationId,
				})),
				memoryItemIds: grounds.memoryItemIds,
			},
		});
		db.exec("RELEASE steward_ask");
		waiting.push(plan);
		return "saved";
	} catch (error) {
		db.exec("ROLLBACK TO steward_ask");
		db.exec("RELEASE steward_ask");
		log.warn("steward.sleep_question_refused", {
			reason: error instanceof Error ? error.message : "question_refused",
		});
		return "refused";
	}
}

const waitingQuestions = (db: Database, deps: StewardDeps) =>
	deps.continuity.plans.listInTransaction(db, {
		kinds: ["open_question"],
		states: ["open", "awaiting_confirmation"],
	});

function report(kind: string, results: Record<string, number>) {
	log.info("steward.sleep_questions", { kind, ...results });
}

/** An unresolved contradiction becomes a question of which record the user means (neither record is changed). */
export function saveUnresolved(
	db: Database,
	deps: StewardDeps,
	items: readonly UnresolvedConflict[],
) {
	const waiting = waitingQuestions(db, deps);
	const counts = { saved: 0, kept: 0, refused: 0 };
	for (const conflict of items) {
		const text = `「${clip(conflict.a.text)}」と「${clip(conflict.b.text)}」で食い違いがあります。今はどちらが当てはまるか、利用者に確かめる。`;
		const sources = conflict.sources
			.flat()
			.flatMap((evidence) => ("messageId" in evidence ? [evidence] : []));
		counts[
			ask(db, deps, waiting, {
				text,
				grounds: groundsOf(db, deps, [conflict.a, conflict.b], sources),
			})
		]++;
	}
	report("unresolved", counts);
}

const askAboutGoal = (finding: GoalInstruction["finding"], goal: string) =>
	finding === "may-be-completed"
		? `目標「${goal}」はもう達成できたか、利用者に確かめる。`
		: `目標「${goal}」は最近の話と食い違っているようです。今も続けるか、利用者に確かめる。`;

/** A goal the records suggest is done or contradicted becomes a question to the user (the goal is not changed). */
export function saveGoalFindings(
	db: Database,
	deps: StewardDeps,
	items: readonly GoalInstruction[],
	goals: readonly GoalInput[],
) {
	const waiting = waitingQuestions(db, deps);
	const texts = new Map(goals.map((goal) => [goal.id, goal.text]));
	const counts = { saved: 0, kept: 0, refused: 0 };
	for (const finding of items) {
		const goal = texts.get(finding.goalId);
		if (goal === undefined) {
			counts.refused++;
			continue;
		}
		counts[
			ask(db, deps, waiting, {
				text: askAboutGoal(finding.finding, clip(goal)),
				grounds: groundsOf(db, deps, finding.basedOn, []),
			})
		]++;
	}
	report("goals", counts);
}
