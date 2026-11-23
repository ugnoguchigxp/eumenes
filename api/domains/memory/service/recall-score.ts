import type { StateItem } from "eumenes-memory/sqlite";

/**
 * How a query matches a record (spec/memory-recall-implementation-2026-11-23.md section 2.1). Natural Japanese has no
 * word breaks, so a word is rated by how many of its character pairs the record's words hold. Pure functions of the
 * two texts: the same inputs give the same score.
 */

const SEPARATORS =
	/[\s　、。，．,.!?！？「」『』（）()［］[\]｛｝{}【】〈〉《》"'“”‘’…・:：;；/\\|<>＜＞~〜～]+/u;
const HIRAGANA_PAIR = /^[ぁ-ゟ]{2}$/u;

/** NFKC and lower case: width forms and case do not matter. */
export const normalizeText = (text: string) =>
	text.normalize("NFKC").toLowerCase();

/** Only this much of a query is read: a long speech does not widen the work or the matches. */
const MAX_QUERY_CHARS = 200;
/**
 * A one-character word counts only in kanji, katakana, letters or digits. A lone hiragana ("あ", "え" of a speech
 * recognition's filler) is in every record.
 */
const SINGLE_CHAR = /^[\p{Script=Han}\p{Script=Katakana}a-z0-9]$/u;

/** One word of a query, its character pairs made once. */
export type QueryTerm = {
	text: string;
	/** The one character of a one-character word. */
	single: string | null;
	/** The pairs that count (the hiragana-only ones are left out when the word has any other pair). */
	pairs: readonly string[];
};

/** The words of a query: cut at spaces, punctuation, brackets, question and exclamation marks. */
export function queryTerms(text: string): QueryTerm[] {
	const terms: QueryTerm[] = [];
	for (const word of normalizeText([...text].slice(0, MAX_QUERY_CHARS).join(""))
		.split(SEPARATORS)
		.filter((term) => term !== "")) {
		const chars = [...word];
		if (chars.length === 1) {
			if (SINGLE_CHAR.test(word))
				terms.push({ text: word, single: word, pairs: [] });
			continue;
		}
		const pairs = new Set<string>();
		for (let i = 0; i + 1 < chars.length; i++)
			pairs.add(chars[i]! + chars[i + 1]!);
		const strong = [...pairs].filter((pair) => !HIRAGANA_PAIR.test(pair));
		terms.push({
			text: word,
			single: null,
			pairs: strong.length > 0 ? strong : [...pairs],
		});
	}
	return terms;
}

/** What a record is searched by: its words, its key and its attributes (the material of `memory_state_search_doc`). */
export function searchDocOf(item: StateItem): string {
	const attributes = Object.entries(item.value.attributes ?? {})
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => `${key} ${value}`);
	return normalizeText(
		[item.value.text, item.semanticKey, ...attributes].join("\n"),
	);
}

/**
 * The share of one word the record holds. A one-character word counts when the record has the character. A longer
 * word is rated by its character pairs; the pairs written in hiragana alone are left out when the word has any other
 * pair (the particles and endings of a sentence are in every record).
 */
function termShare(term: QueryTerm, doc: string): number {
	if (term.single !== null) return doc.includes(term.single) ? 1 : 0;
	let hit = 0;
	for (const pair of term.pairs) if (doc.includes(pair)) hit++;
	return hit / term.pairs.length;
}

/** The sum of the words' shares. */
export function scoreOf(terms: readonly QueryTerm[], doc: string): number {
	let score = 0;
	for (const term of terms) score += termShare(term, doc);
	return score;
}

/** One of the words (two characters or more) stands as it is in the record's words. */
export function isDirect(terms: readonly QueryTerm[], text: string): boolean {
	const normalized = normalizeText(text);
	return terms.some(
		(term) => term.single === null && normalized.includes(term.text),
	);
}

/** The words of a record without spaces and punctuation, for telling two records of the same words apart from alike ones. */
export function flattenText(text: string): string {
	return normalizeText(text).replace(SEPARATORS, "");
}
