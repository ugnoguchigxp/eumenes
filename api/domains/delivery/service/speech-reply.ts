import { spokenText } from "./spoken-text";

export const SPOKEN_REPLY_MAX_CHARS = 160;
export const SPOKEN_REPLY_MAX_SENTENCES = 2;
const sentences = new Intl.Segmenter("ja", { granularity: "sentence" });

/** The spoken length of a reply, measured on the text TTS will read. */
export function spokenReplyMeasure(text: string) {
	const prose = spokenText(text);
	return {
		chars: prose.length,
		sentences: [...sentences.segment(prose)].filter((part) =>
			part.segment.trim(),
		).length,
	};
}

/** Presentation contract only: no intent classification or truncation. */
export function isBriefSpokenReply(text: string) {
	const measured = spokenReplyMeasure(text);
	return (
		measured.chars <= SPOKEN_REPLY_MAX_CHARS &&
		measured.sentences <= SPOKEN_REPLY_MAX_SENTENCES
	);
}
