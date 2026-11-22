import type { Database } from "bun:sqlite";
import {
	listSuppressions,
	releaseStateSuppression,
	suppressState,
} from "eumenes-memory/sqlite";
import type {
	ImmediateRejection,
	SuppressInput,
	SuppressOutcome,
} from "../contracts/immediate";
import {
	deleteTopicSuppression,
	insertTopicSuppression,
	listTopicSuppressions,
	windowConversations,
	windowsShowing,
} from "../repository/immediate";
import { factKey } from "./candidate-closure";
import {
	everyItem,
	guarded,
	itemOf,
	rejected,
	resolveTarget,
	type ImmediateDeps,
} from "./immediate-shared";

const MAX_TERM_CHARS = 100;

const hasText = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "";

/** A topic word as stored and compared: NFKC, lower case, one space between words. */
export function normalizeTerm(term: string): string | null {
	const normalized = term
		.normalize("NFKC")
		.toLowerCase()
		.replace(/\s+/gu, " ")
		.trim();
	return normalized === "" || [...normalized].length > MAX_TERM_CHARS
		? null
		: normalized;
}

/**
 * Whether a text touches a suppressed topic word. Plain containment of the normalized word (spaces of the text
 * ignored): the agency's choice of topics asks this; a finer match is a later design (section 5.2).
 */
export function touchesSuppressedTerm(
	terms: readonly string[],
	text: string,
): boolean {
	const squeezed = text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
	return terms.some(
		(term) =>
			squeezed.includes(term) || squeezed.includes(term.replace(/\s+/gu, "")),
	);
}

/**
 * "Do not bring that up" (sections 4.3 and 5.2): the record stays, and is not brought up. A record is marked as a
 * whole fact (later versions too, through the library's suppression); a topic with no record is a word in a small
 * table of this domain (the library has none). Suppression is not a forget: no journal line, and it is lifted by
 * `release`. `## Memory` drops a marked item at its next re-construction, which an immediate change brings about
 * when a stored window shows it.
 */
export function createSuppression(deps: ImmediateDeps) {
	const { windows, clock } = deps;

	function apply(
		db: Database,
		input: SuppressInput,
		op: "suppress" | "release",
	): SuppressOutcome {
		if (!deps.ready()) return rejected("memory_unavailable");
		if (!hasText(input.conversationId) || !hasText(input.sourceRunId))
			return rejected("invalid_input");
		return guarded(db, (): SuppressOutcome => {
			if ("term" in input.target) {
				const term = hasText(input.target.term)
					? normalizeTerm(input.target.term)
					: null;
				if (term === null) return rejected("invalid_input");
				const changed =
					op === "suppress"
						? insertTopicSuppression(
								db,
								term,
								input.conversationId,
								input.sourceRunId,
								clock(),
							)
						: deleteTopicSuppression(db, term);
				return {
					status: changed ? "applied" : "unchanged",
					scope: "term",
					itemId: null,
					term,
				};
			}
			const resolved = resolveTarget(
				db,
				deps,
				input.conversationId,
				input.target,
			);
			if (!resolved.ok) return rejected(resolved.reason);
			const found = itemOf(db, deps, resolved.itemId);
			if (!found) return rejected("target_missing");
			if (found.excluded === true) return rejected("target_excluded");
			if (resolved.revision !== null && found.revision !== resolved.revision)
				return rejected("target_changed");
			const request = {
				...deps.scoped(db, "memory.write"),
				clock: { atMs: deps.atMs() },
				target: {
					type: "state_fact" as const,
					subject: found.subject,
					kind: found.kind,
					semanticKey: found.semanticKey,
				},
				sourceRunId: input.sourceRunId,
			};
			const result =
				op === "suppress"
					? suppressState(db, request)
					: releaseStateSuppression(db, request);
			if (result.status !== "applied" && result.status !== "unchanged") {
				const reason: ImmediateRejection =
					result.status === "missing" || result.status === "forgotten"
						? "target_missing"
						: "conflict";
				return rejected(reason);
			}
			// A marked item leaves what `## Memory` shows at the next re-construction. Lifting a mark only adds.
			if (
				op === "suppress" &&
				result.status === "applied" &&
				windowsShowing(
					db,
					new Set(
						everyItem(db, deps)
							.filter((item) => factKey(item) === factKey(found))
							.map((item) => item.itemId),
					),
				)
			)
				windows.recordImmediateInTransaction(
					db,
					"state_suppress",
					input.sourceRunId,
				);
			// A lifted mark only adds: the item waits beside the published profile until the next re-construction.
			if (op === "release" && result.status === "applied")
				for (const conversationId of windowConversations(db))
					windows.publishInTransaction(db, conversationId, {});
			return {
				status: result.status,
				scope: "fact",
				itemId: found.itemId,
				term: null,
			};
		});
	}

	return {
		suppress: (db: Database, input: SuppressInput) =>
			apply(db, input, "suppress"),
		release: (db: Database, input: SuppressInput) =>
			apply(db, input, "release"),
		/**
		 * What is suppressed now: the topic words, and the facts marked in the library (a record's whole fact; the caller
		 * keeps its topic choice away from them). Read-only.
		 */
		list(db: Database): {
			terms: string[];
			facts: Array<{ subject: string; kind: string; semanticKey: string }>;
		} {
			const listed = listSuppressions(db, deps.scoped(db, "memory.read"));
			if (listed.status !== "ok") throw new Error("memory_blocked");
			return {
				terms: listTopicSuppressions(db),
				facts: listed.targets.flatMap((target) =>
					target.type === "state_fact"
						? [
								{
									subject: target.subject,
									kind: target.kind,
									semanticKey: target.semanticKey,
								},
							]
						: [],
				),
			};
		},
	};
}
