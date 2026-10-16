/** Spoken language of one synthesis request; matches the LARM speech option. */
export type SpeechLanguage = "ja" | "en";
type SpeechSegment = { text: string; language: SpeechLanguage };

/** Words an English stretch needs inside a clause that also contains Japanese. */
const MIN_ENGLISH_WORDS = 2;

const JAPANESE =
	/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー々〆ヶ０-９Ａ-Ｚａ-ｚ]/u;
const LATIN = /\p{Script=Latin}/u;
/** Japanese punctuation, full-width forms and line breaks end a Latin stretch. */
const SEPARATOR = /[　-〿＀-￯\n]/;
/** Opening brackets belong to the text they open. */
const OPENERS = /[（「『【〈《〔［｛[(“‘]+$/u;
const WORD = /\p{Script=Latin}+(?:['’-]\p{Script=Latin}+)*/gu;
const speakable = /[\p{L}\p{N}]/u;

type Run = { latin: boolean; text: string };

function runs(clause: string): Run[] {
	const out: Run[] = [];
	let pending = "";
	for (const char of clause) {
		const latin = !JAPANESE.test(char) && LATIN.test(char);
		if (!latin && !JAPANESE.test(char)) {
			pending += char;
			continue;
		}
		const last = out.at(-1);
		if (!last) {
			out.push({ latin, text: pending + char });
		} else if (last.latin === latin && (!latin || !SEPARATOR.test(pending))) {
			last.text += pending + char;
		} else {
			const opener = pending.match(OPENERS)?.[0] ?? "";
			last.text += pending.slice(0, pending.length - opener.length);
			out.push({ latin, text: opener + char });
		}
		pending = "";
	}
	const last = out.at(-1);
	if (last) last.text += pending;
	else if (pending) out.push({ latin: false, text: pending });
	return out;
}

/** Strips leading and trailing non-alphanumerics in linear time. */
function trimSymbols(raw: string) {
	const chars = [...raw];
	let start = 0,
		end = chars.length;
	while (start < end && !speakable.test(chars[start]!)) start++;
	while (end > start && !speakable.test(chars[end - 1]!)) end--;
	return chars.slice(start, end).join("");
}

/** Ordinary words; acronyms, code-like tokens and inner-capital names are not counted. */
function words(text: string) {
	let count = 0;
	let titled = true;
	for (const raw of text.split(/\s+/)) {
		const token = trimSymbols(raw);
		if (!token || /[_@/]/.test(token) || /\p{L}\.\p{L}/u.test(token)) continue;
		if (/^(?=.*\p{Lu})[\p{Lu}\p{N}]{2,}s?$/u.test(token)) continue;
		for (const [word] of token.matchAll(WORD)) {
			if (/^.+\p{Lu}/u.test(word)) continue;
			count++;
			if (!/^\p{Lu}/u.test(word)) titled = false;
		}
	}
	return { count, titled };
}

function english(text: string, withJapanese: boolean) {
	const { count, titled } = words(text);
	if (!withJapanese) return count >= 1;
	// Capitalized phrases inside Japanese are names, read as Japanese.
	return !titled && count >= MIN_ENGLISH_WORDS;
}

function merge(segments: SpeechSegment[]) {
	const out: SpeechSegment[] = [];
	for (const segment of segments) {
		const last = out.at(-1);
		if (last?.language === segment.language) last.text += segment.text;
		else out.push({ ...segment });
	}
	return out;
}

/**
 * Splits one clause into spoken-language segments in source order. Each segment
 * re-evaluates to its own language, so a request can be routed from its text alone.
 */
export function speechSegments(clause: string): SpeechSegment[] {
	const parts = runs(clause);
	const withJapanese = JAPANESE.test(clause);
	const labels: SpeechLanguage[] = parts.map((run) =>
		run.latin && english(run.text, withJapanese) ? "en" : "ja",
	);
	// A Latin stretch with no Japanese neighbour would be English on its own;
	// label it so here too, keeping each segment's language stable when re-read.
	parts.forEach((run, i) => {
		if (!run.latin || labels[i] === "en") return;
		const japaneseNeighbour = [parts[i - 1], parts[i + 1]].some(
			(n) => n && !n.latin,
		);
		if (!japaneseNeighbour && english(run.text, false)) labels[i] = "en";
	});
	const segments = merge(
		parts.map((run, i) => ({ text: run.text, language: labels[i]! })),
	);
	// Runs start with a letter unless the clause has none, so no segment is bare punctuation.
	return segments
		.map((s) => ({ ...s, text: s.text.trim() }))
		.filter((s) => s.text);
}

/** Language of one request: English only when every segment is English. */
export function speechLanguage(text: string): SpeechLanguage {
	const segments = speechSegments(text);
	return segments.length > 0 && segments.every((s) => s.language === "en")
		? "en"
		: "ja";
}
