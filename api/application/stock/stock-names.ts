/**
 * Name matching for the stock toolchain. A name is compared after it is made plain: full-width letters
 * and kana variants are unified, the legal form of a company (株式会社, Co., Ltd., ...) and every space
 * or mark are dropped, so "ソフトバンク" and "株式会社 ソフトバンク" and "そふとばんく" are the same name.
 */

const JAPANESE_FORMS = /株式会社|有限会社|合同会社|\((?:株|有|同)\)/g;
/** The legal forms in the Yomi column (the reading of 株式会社 is カブシキガイシャ or カブシキカイシャ). */
const READING_FORMS =
	/カブシキガイシャ|カブシキカイシャ|ユウゲンガイシャ|ゴウドウガイシャ/g;
const ENGLISH_FORMS =
	/\b(?:co|ltd|inc|corp|corporation|company|limited|incorporated|plc|llc|kabushiki|kaisha|k\.k)\b\.?/g;

/** Hiragana to katakana, so a reading typed in either script matches. */
function katakana(text: string) {
	return text.replace(/[ぁ-ゖ]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) + 0x60),
	);
}

/** The comparable form of a name; empty when nothing but a legal form and marks were there. */
export function normalizeName(text: string) {
	const plain = katakana(text.normalize("NFKC").toLowerCase());
	const stripped = plain
		.replace(JAPANESE_FORMS, "")
		.replace(READING_FORMS, "")
		.replace(ENGLISH_FORMS, "");
	const squeeze = (s: string) => s.replace(/[^\p{L}\p{N}\p{M}]/gu, "");
	// A name that is only a legal form ("Company") keeps it rather than becoming nothing.
	return squeeze(stripped) || squeeze(plain);
}

/** How closely a name fits the query: exact, starts with it, or contains it (a short query is exact only). */
export type MatchRank = 0 | 1 | 2;

/** Rank of `name` against `query` (both normalized), or undefined when it does not fit. */
export function rankName(
	query: string,
	name: string,
): { rank: MatchRank; extra: number } | undefined {
	if (!query || !name) return undefined;
	if (name === query) return { rank: 0, extra: 0 };
	// One or two letters of a name are too little to say a company starts with, or holds, them.
	const minimum = /^[\x20-\x7e]*$/.test(query) ? 3 : 2;
	if (query.length < minimum) return undefined;
	const extra = name.length - query.length;
	if (name.startsWith(query)) return { rank: 1, extra };
	if (name.includes(query)) return { rank: 2, extra };
	return undefined;
}

/** The best fit among the several names a company has (漢字・英字・ヨミ). */
export function bestRank(query: string, names: readonly string[]) {
	let best: { rank: MatchRank; extra: number } | undefined;
	for (const name of names) {
		const found = rankName(query, name);
		if (
			found &&
			(!best ||
				found.rank < best.rank ||
				(found.rank === best.rank && found.extra < best.extra))
		)
			best = found;
	}
	return best;
}
