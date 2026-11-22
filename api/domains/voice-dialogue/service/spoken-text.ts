import { dropRepeatedSentences } from "eumenes-agency/agenda";
import { spokenText } from "../../delivery";

export { spokenText, spokenPrefix } from "../../delivery";

/** Adoption can normalize display links and remove sentences already sent to speech. */
export function reconcileSpeechBody(
	body: string,
	streamed: string,
	final: boolean,
): string {
	if (body.startsWith(streamed)) return body;
	if (final) {
		const answer = spokenText(body);
		if (
			answer === spokenText(streamed) ||
			answer === spokenText(dropRepeatedSentences(streamed))
		)
			return streamed;
	}
	throw new Error("speech_stream_diverged");
}
