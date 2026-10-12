/** Stable execution errors: a whole-source failure must not retry every clause. */
export class SpeechLanguageError extends Error {
	constructor(
		code:
			| "speech_language_unavailable"
			| "speech_language_invalid"
			| "speech_language_timeout"
			| "speech_language_failed"
			| "speech_language_capacity"
			| "speech_tts_target_unavailable",
	) {
		super(code);
	}
}
