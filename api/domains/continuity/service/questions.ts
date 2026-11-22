import type { Database } from "bun:sqlite";
import {
	ATTRIBUTE_MAX,
	MAX_QUESTIONS,
	questionStates,
	type EvidenceInput,
	type QuestionEntry,
	type QuestionState,
} from "../contracts/plans";
import {
	addEvidence,
	changeQuestion,
	countQuestions,
	getQuestion,
	getQuestionByKey,
	insertQuestion,
	listQuestions,
} from "../repository/plans";
import { checkText, cut, normalizeEvidence, type Visible } from "./evidence";

/** The attribute as compared: width, case and spaces do not make a different question. */
const attributeKey = (attribute: string) =>
	attribute.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");

/** The question ledger: what was asked of the user and what became of it. */
export function createQuestions(
	clock: () => string,
	id: () => string,
	visible: Visible,
) {
	return {
		/**
		 * Writes what became of a question about an attribute: the first record makes the entry, a later one
		 * (the same attribute, however it is written) changes its state and adds evidence. `asked` stamps the
		 * time the agent asked.
		 */
		recordInTransaction(
			db: Database,
			input: {
				conversationId: string;
				attribute: string;
				state: QuestionState;
				evidence: EvidenceInput;
			},
		): QuestionEntry {
			if (!questionStates.includes(input.state))
				throw new Error("invalid_question_state");
			const attribute = checkText(input.attribute, ATTRIBUTE_MAX);
			const evidence = normalizeEvidence(input.evidence);
			const key = attributeKey(attribute);
			const now = clock();
			const existing = getQuestionByKey(db, key);
			if (existing) {
				changeQuestion(db, existing.id, undefined, {
					state: input.state,
					...(input.state === "asked" ? { askedAt: now } : {}),
					updatedAt: now,
				});
				addEvidence(
					db,
					"question",
					existing.id,
					existing.conversationId,
					evidence,
				);
				return getQuestion(db, existing.id) as QuestionEntry;
			}
			if (countQuestions(db) >= MAX_QUESTIONS)
				throw new Error("invalid_question_limit");
			const entryId = id();
			insertQuestion(
				db,
				{
					id: entryId,
					conversationId: input.conversationId,
					attribute,
					state: input.state,
					revision: 1,
					askedAt: input.state === "asked" ? now : null,
					createdAt: now,
					updatedAt: now,
					evidence: [],
					memoryItemIds: [],
				},
				key,
			);
			addEvidence(db, "question", entryId, input.conversationId, evidence);
			return getQuestion(db, entryId) as QuestionEntry;
		},
		/** Changes the state of an entry by id, with the evidence; null when unknown or at another revision. */
		updateStateInTransaction(
			db: Database,
			entryId: string,
			input: {
				state: QuestionState;
				evidence: EvidenceInput;
				expectedRevision?: number;
			},
		): QuestionEntry | null {
			if (!questionStates.includes(input.state))
				throw new Error("invalid_question_state");
			const evidence = normalizeEvidence(input.evidence);
			const existing = getQuestion(db, entryId);
			if (!existing) return null;
			const now = clock();
			if (
				!changeQuestion(db, entryId, input.expectedRevision, {
					state: input.state,
					...(input.state === "asked" ? { askedAt: now } : {}),
					updatedAt: now,
				})
			)
				return null;
			addEvidence(db, "question", entryId, existing.conversationId, evidence);
			return getQuestion(db, entryId);
		},
		/** The entry of an attribute (any wording of it); null when unknown or resting on an excluded source. */
		findInTransaction(db: Database, attribute: string): QuestionEntry | null {
			const entry = getQuestionByKey(db, attributeKey(attribute));
			return entry ? (visible(db, [entry])[0] ?? null) : null;
		},
		/** Latest change first. */
		listInTransaction(
			db: Database,
			query: {
				conversationId?: string;
				states?: readonly QuestionState[];
				limit?: number;
			} = {},
		): QuestionEntry[] {
			return cut(
				visible(
					db,
					listQuestions(db, {
						...(query.conversationId === undefined
							? {}
							: { conversationId: query.conversationId }),
						...(query.states ? { states: query.states } : {}),
					}),
				),
				query.limit,
			);
		},
	};
}
