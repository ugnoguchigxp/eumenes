import type { AsrLanguage } from "../../settings/contracts";

type Script =
	| "han"
	| "kana"
	| "hangul"
	| "latin"
	| "cyrillic"
	| "arabic"
	| "thai"
	| "devanagari"
	| "greek";
const SCRIPT_PATTERNS: Record<Script, RegExp> = {
	han: /\p{Script=Han}/u,
	kana: /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u,
	hangul: /\p{Script=Hangul}/u,
	latin: /\p{Script=Latin}/u,
	cyrillic: /\p{Script=Cyrillic}/u,
	arabic: /\p{Script=Arabic}/u,
	thai: /\p{Script=Thai}/u,
	devanagari: /\p{Script=Devanagari}/u,
	greek: /\p{Script=Greek}/u,
};
const LANGUAGE_SCRIPTS: Record<AsrLanguage, Script[]> = {
	ja: ["han", "kana"],
	zh: ["han"],
	yue: ["han"],
	ko: ["hangul", "han"],
	ru: ["cyrillic"],
	mk: ["cyrillic"],
	ar: ["arabic"],
	fa: ["arabic"],
	th: ["thai"],
	hi: ["devanagari"],
	el: ["greek"],
	en: ["latin"],
	de: ["latin"],
	fr: ["latin"],
	es: ["latin"],
	pt: ["latin"],
	id: ["latin"],
	it: ["latin"],
	vi: ["latin"],
	tr: ["latin"],
	ms: ["latin"],
	nl: ["latin"],
	sv: ["latin"],
	da: ["latin"],
	fi: ["latin"],
	pl: ["latin"],
	cs: ["latin"],
	fil: ["latin"],
	ro: ["latin"],
	hu: ["latin"],
};
/** Characters (fillers, simplified forms) that Japanese text does not use. */
const CHINESE_ONLY =
	/[你您嗯呃哦噢唔哎嘿呀吗呢么这们个说话还对谢请问吧哪给让过时]/u;

/**
 * The ASR service returns plain text with no detected language, so the
 * allowlist is applied to the transcript's scripts: letters of any script not
 * used by an allowed language reject the text. Han-only text is also rejected
 * when Chinese is not allowed and it contains Chinese-only characters.
 */
export function transcriptAllowed(
	text: string,
	allowed: readonly AsrLanguage[],
): boolean {
	const scripts = new Set(allowed.flatMap((code) => LANGUAGE_SCRIPTS[code]));
	let hasKana = false;
	let hasHan = false;
	let hasOther = false;
	for (const ch of text) {
		if (!/\p{L}/u.test(ch)) continue;
		const script = (Object.keys(SCRIPT_PATTERNS) as Script[]).find((s) =>
			SCRIPT_PATTERNS[s].test(ch),
		);
		if (!script || !scripts.has(script)) return false;
		if (script === "kana") hasKana = true;
		else if (script === "han") hasHan = true;
		else hasOther = true;
	}
	if (
		hasHan &&
		!hasKana &&
		!hasOther &&
		!allowed.some((c) => c === "zh" || c === "yue") &&
		CHINESE_ONLY.test(text)
	)
		return false;
	return true;
}
