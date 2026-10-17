import { spokenText } from "./spoken-text";

export const SPOKEN_REPLY_MAX_CHARS = 160;
const sentences = new Intl.Segmenter("ja", { granularity: "sentence" });

/** Presentation contract only: no intent classification or truncation. */
export function isBriefSpokenReply(text: string) {
	const prose = spokenText(text);
	return (
		prose.length <= SPOKEN_REPLY_MAX_CHARS &&
		[...sentences.segment(prose)].filter((part) => part.segment.trim())
			.length <= 2
	);
}
