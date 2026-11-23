import type { Database } from "bun:sqlite";
import {
	extractRecords,
	type ExtractedRecords,
	type ExtractRelated,
	type ExtractSaid,
} from "eumenes-agency/agenda";
import { getLogger } from "../../infrastructure/logger";
import { toErrorCode } from "../../infrastructure/error-code";
import { wordsOf } from "./always-on-feed";
import { overlap, unitsOf } from "./always-on-recall";
import { agendaClock, agendaReady, type AgendaScope } from "./always-on-scope";
import { think } from "./always-on-thoughts";
import type { AgencyHostDeps } from "./host-types";

const log = getLogger("agency");

/** What one pass reads: at most this many words of the conversation, and at most this many bytes of them. */
export const RECORDS_PASS_EVENTS = 8;
export const RECORDS_PASS_BYTES = 16 * 1024;
/** A scope with no known position starts this many messages before the end of the conversation. */
export const RECORDS_BACKFILL = 16;
/** How many records of each kind the host shows the writer as already there (short references). */
const RELATED_LIMIT = 8;
const QUESTIONS_SHOWN = 20;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
/** The text cut to `max` bytes at a character boundary (one line may not take the whole pass). */
function cutBytes(text: string, max: number) {
	let out = "";
	let used = 0;
	for (const char of text) {
		used += bytes(char);
		if (used > max) break;
		out += char;
	}
	return out;
}

/**
 * The messages the user's requests to the memory (remember, forget, correct, do not bring up, take back) stand on: the
 * conversation log's `memory.request` acts name them. A taken-back request names the same words.
 */
export function requestMessageIds(
	deps: AgencyHostDeps,
	db: Database,
	conversationId: string,
): Set<string> {
	const ids = new Set<string>();
	for (const event of deps.continuity.events.logInTransaction(
		db,
		conversationId,
	)) {
		if (event.type !== "acted" || event.text === null) continue;
		try {
			const fields = JSON.parse(event.text) as { action?: unknown };
			if (fields.action === "memory.request")
				for (const id of event.messageIds) ids.add(id);
		} catch {
			// A text that is not JSON is no act of ours.
		}
	}
	return ids;
}

/** Where a conversation with no known position is read from: the seq before its last `RECORDS_BACKFILL` messages. */
export function backfillStart(
	deps: AgencyHostDeps,
	db: Database,
	conversationId: string,
): number {
	const seqs: number[] = [];
	for (let cursor = 0; ;) {
		const page = deps.conversation.changesInTransaction(db, cursor, 200);
		for (const event of page) {
			cursor = event.seq;
			if (
				event.conversationId === conversationId &&
				event.namespace === "conversation" &&
				event.sourceKind === "message" &&
				event.kind === "added"
			)
				seqs.push(event.seq);
		}
		if (page.length < 200) break;
	}
	return seqs.length > RECORDS_BACKFILL
		? seqs[seqs.length - RECORDS_BACKFILL - 1]!
		: 0;
}

type Read = {
	said: ExtractSaid[];
	/** The outbox seq the pass has read up to (the position it leaves when it is kept). */
	to: number;
	/** The pass stopped at its limit: more words wait after `to`. */
	more: boolean;
};

/**
 * The words of the conversation after `after` (outbox order), as the writer reads them: the user's and the agent's,
 * without what the memory blocked or the user took back. One message a correction touched is read once, as it reads
 * now. The pass stops before the word that would exceed its limit (the first word is always read).
 */
export function readAfter(
	deps: AgencyHostDeps,
	db: Database,
	conversationId: string,
	after: number,
): Read {
	const said = new Map<string, ExtractSaid>();
	// What the user asked of the memory is not a fact to record: the words of such a request are not read.
	const requests = requestMessageIds(deps, db, conversationId);
	let cursor = after;
	let to = after;
	let used = 0;
	for (;;) {
		const page = deps.conversation.changesInTransaction(db, cursor, 200);
		for (const event of page) {
			cursor = event.seq;
			if (
				event.conversationId !== conversationId ||
				event.namespace !== "conversation" ||
				event.sourceKind !== "message"
			) {
				to = event.seq;
				continue;
			}
			const words = requests.has(event.sourceId)
				? null
				: wordsOf(deps, db, event.sourceId);
			if (!words) {
				to = event.seq;
				continue;
			}
			const known = said.has(words.message.id);
			const text = cutBytes(words.text, RECORDS_PASS_BYTES);
			if (
				!known &&
				said.size > 0 &&
				(said.size >= RECORDS_PASS_EVENTS ||
					used + bytes(text) > RECORDS_PASS_BYTES)
			)
				return { said: [...said.values()], to, more: true };
			if (!known) used += bytes(text);
			said.set(words.message.id, {
				id: words.message.id,
				who: words.message.role === "user" ? "user" : "agent",
				text,
				at: agendaClock(Date.parse(words.message.createdAt) || 0),
			});
			to = event.seq;
		}
		if (page.length < 200) break;
	}
	return { said: [...said.values()], to, more: false };
}

type Refs = { plans: Map<string, string> };

/** The records that bear on these words, as the writer sees them (short references, no ids). */
function relatedTo(
	deps: AgencyHostDeps,
	db: Database,
	said: readonly ExtractSaid[],
): { related: ExtractRelated; refs: Refs } {
	const wanted = unitsOf(
		said
			.filter((s) => s.who === "user")
			.map((s) => s.text)
			.join("\n"),
	);
	const best = <T>(items: readonly T[], text: (item: T) => string) =>
		items
			.map((item, i) => ({ item, i, score: overlap(wanted, text(item)) }))
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score || a.i - b.i)
			.slice(0, RELATED_LIMIT)
			.map((x) => x.item);
	const refs: Refs = { plans: new Map() };
	const plans = best(
		deps.continuity.plans.listInTransaction(db),
		(p) => p.text,
	).map((plan, i) => {
		const ref = `p${i + 1}`;
		refs.plans.set(ref, plan.id);
		return { ref, text: plan.text, dueAt: plan.dueAt };
	});
	const questions = deps.continuity.questions
		.listInTransaction(db, { limit: QUESTIONS_SHOWN })
		.map((q) => ({ attribute: q.attribute, state: q.state }));
	// No memory records: the writer writes no facts (the steward curates the memory), so it needs none to compare with.
	return { related: { plans, questions }, refs };
}

let savepoints = 0;
/** One write as a unit: a refusal or an error leaves no trace of it, and the transaction goes on. */
function attempt<T>(db: Database, run: () => T): T | { error: string } {
	const name = `agency_records_${++savepoints}`;
	db.exec(`SAVEPOINT ${name}`);
	try {
		const out = run();
		db.exec(`RELEASE ${name}`);
		return out;
	} catch (error) {
		db.exec(`ROLLBACK TO ${name}`);
		db.exec(`RELEASE ${name}`);
		return { error: error instanceof Error ? error.message : "write_failed" };
	}
}

/**
 * What a kept pass writes, in one transaction of the caller: `plans` and `questions` to the continuity domain (L3
 * and the ledger). The writer returns nothing else: the steward curates the memory. Each write is its own unit; what
 * the domains refuse is returned with its reason.
 */
export function writeRecords(input: {
	deps: AgencyHostDeps;
	db: Database;
	conversationId: string;
	records: ExtractedRecords;
	refs: Refs;
}): { applied: string[]; rejected: string[] } {
	const { deps, db, conversationId, records, refs } = input;
	const applied: string[] = [];
	const rejected: string[] = [];
	const evidenceOf = (ids: readonly string[]) => ({
		messages: ids.map((messageId) => ({ messageId, conversationId })),
	});
	for (const p of records.plans) {
		const evidence = evidenceOf(p.evidence);
		const planId = p.ref === null ? null : (refs.plans.get(p.ref) ?? null);
		if (p.op !== "add" && planId === null) {
			rejected.push(`plan:${p.op}:unknown_ref`);
			continue;
		}
		const out = attempt(db, () => {
			if (p.op === "add")
				return deps.continuity.plans.addInTransaction(db, {
					conversationId,
					kind: "plan",
					text: p.text ?? "",
					dueAt: p.dueAt,
					evidence,
				});
			if (p.op === "close")
				return deps.continuity.plans.closeInTransaction(db, planId!, {
					evidence,
				});
			return deps.continuity.plans.updateInTransaction(db, planId!, {
				...(p.text === null ? {} : { text: p.text }),
				...(p.dueAt === null ? {} : { dueAt: p.dueAt }),
				evidence,
			});
		});
		if (out === null) rejected.push(`plan:${p.op}:not_open`);
		else if ("error" in out) rejected.push(`plan:${p.op}:${out.error}`);
		else applied.push(`plan ${p.op}: ${p.text ?? p.ref ?? ""}`);
	}
	for (const q of records.questions) {
		const out = attempt(db, () =>
			deps.continuity.questions.recordInTransaction(db, {
				conversationId,
				attribute: q.attribute,
				state: q.op,
				evidence: evidenceOf(q.evidence),
			}),
		);
		if ("error" in out) rejected.push(`question:${q.op}:${out.error}`);
		else applied.push(`question ${q.op}: ${q.attribute}`);
	}
	return { applied, rejected };
}

type Outcome = "idle" | "kept" | "more" | "stale" | "aborted" | "failed";

/**
 * One pass: the words after the position are read, the writer's output is checked by the package, and what passed is
 * written in one transaction that first checks the words are still as they were read (not forgotten or corrected) and
 * that nothing moved the position. A pass that is called off, fails or finds the words changed leaves the position, and
 * the next pass reads the same words again.
 */
async function pass(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	now(): number;
	/** Saves the scope's checkpoint in the transaction that keeps a pass (its position goes with what it wrote). */
	save(db: Database, c: AgendaScope): void;
}): Promise<Outcome> {
	const { deps, c, now } = input;
	if (!agendaReady(deps) || c.closed.signal.aborted) return "idle";
	// No known position: the conversation is read from a little before its end, not skipped.
	if (c.recordsSeq === null)
		c.recordsSeq = deps.store.read((db) => backfillStart(deps, db, c.id));
	const after = c.recordsSeq;
	const forgetSeq = c.forgetSeq;
	const at = now();
	const prepared = deps.store.read((db) => {
		const read = readAfter(deps, db, c.id, after);
		return {
			read,
			...(read.said.some((s) => s.who === "user")
				? relatedTo(deps, db, read.said)
				: {}),
		};
	});
	const { read } = prepared;
	if (read.to === after) return "idle";
	if (!prepared.related || !prepared.refs) {
		// Nothing of the user's in these words: nothing is written; the position moves on and is saved with the
		// next checkpoint (a restart reads these words again and finds nothing to call a model for).
		c.recordsSeq = read.to;
		return read.more ? "more" : "kept";
	}
	let out: Awaited<ReturnType<typeof extractRecords>>;
	try {
		out = await extractRecords({
			llm: c.background,
			said: read.said,
			related: prepared.related,
			clock: agendaClock(at),
			at,
			signal: c.closed.signal,
		});
	} catch (error) {
		log.warn("agency.records_failed", {
			subjectId: c.id,
			reason: toErrorCode(error, "agency_records_failed"),
		});
		return "failed";
	}
	if (!out.ok) return out.reason === "aborted" ? "aborted" : "failed";
	const refs = prepared.refs;
	const extracted = out;
	let written: { applied: string[]; rejected: string[] } | null;
	let moved = false;
	try {
		written = await deps.store.write((db) => {
			if (
				c.closed.signal.aborted ||
				c.forgetSeq !== forgetSeq ||
				c.recordsSeq !== after
			)
				return null;
			// The words as they are now: a forgotten, corrected or since requested line is not written from.
			const requests = requestMessageIds(deps, db, c.id);
			for (const line of read.said) {
				const words = wordsOf(deps, db, line.id);
				if (
					!words ||
					requests.has(line.id) ||
					cutBytes(words.text, RECORDS_PASS_BYTES) !== line.text
				)
					return null;
			}
			const result = writeRecords({
				deps,
				db,
				conversationId: c.id,
				records: extracted.records,
				refs,
			});
			// The position is saved in this transaction: what was written and where reading goes on move together.
			c.recordsSeq = read.to;
			c.revision++;
			moved = true;
			input.save(db, c);
			return result;
		});
	} catch (error) {
		if (moved) {
			c.recordsSeq = after;
			c.revision++;
		}
		log.warn("agency.records_failed", {
			subjectId: c.id,
			reason: toErrorCode(error, "agency_records_failed"),
		});
		return "failed";
	}
	if (!written || c.closed.signal.aborted || c.forgetSeq !== forgetSeq)
		return "stale";
	const now2 = now();
	if (written.applied.length)
		think(c, now2, "profile", written.applied.join(" / "));
	const dropped = [...out.rejected, ...written.rejected];
	if (dropped.length)
		think(c, now2, "profile", `見送り: ${dropped.join(" / ")}`);
	return read.more ? "more" : "kept";
}

/**
 * A reply is in the conversation: the records writer's pass starts at once when none is running. While one runs, the
 * reply only marks `c.recordsRun`; when the pass ends, one more pass reads at once what came in meanwhile (nothing
 * marked, no pass). A pass that was called off by the main conversation waits for it to be free; one that failed
 * leaves the position, and the next reply that is heard reads the same words again (no timer: no wait that means
 * nothing). Once the scope is closed, no further pass starts.
 */
export function scheduleRecords(input: {
	deps: AgencyHostDeps;
	c: AgendaScope;
	now(): number;
	changed(): void;
	track<T>(p: Promise<T>): Promise<T>;
	save(db: Database, c: AgendaScope): void;
}) {
	const { c } = input;
	if (c.closed.signal.aborted) return;
	if (c.recordsRun) {
		c.recordsRun.again = true;
		return;
	}
	const run = { again: false };
	c.recordsRun = run;
	void input.track(
		(async () => {
			try {
				do {
					run.again = false;
					const outcome = await pass(input);
					c.recordsOwed = outcome === "aborted";
					if (outcome === "failed" || outcome === "aborted") break;
					if (outcome === "more" || outcome === "stale") run.again = true;
					if (outcome === "kept" || outcome === "more") input.changed();
				} while (run.again && !c.closed.signal.aborted);
			} finally {
				c.recordsRun = null;
			}
		})(),
	);
}
