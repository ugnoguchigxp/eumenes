import { SpeechSentences } from "./sentences";
import { spokenText } from "./spoken-text";

/** The sentences an on-demand replay speaks, split as a live answer is. */
export const replaySentences = (text: string) =>
	new SpeechSentences().append(spokenText(text), true);
