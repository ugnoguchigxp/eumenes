import type { RunSpeechDeps } from "./run-speech";
import { toErrorCode } from "../../../infrastructure/error-code";
import { getLogger } from "../../../infrastructure/logger";
const log = getLogger("voice-dialogue");

/** Retain only acknowledged words when an unadopted generation ends; visible typed answers retain their delivery. */
export async function recordRunSpeech(
	{ store, dialogue }: RunSpeechDeps,
	runId: string,
	heard: string,
	full: boolean,
) {
	try {
		if (["queued", "running"].includes(dialogue.get(runId)?.status ?? ""))
			await dialogue.waitForTerminal(runId, { timeoutMs: 180_000 });
		await store.write((db) => {
			dialogue.recordUnadoptedSpeechInTransaction(db, runId, heard);
			dialogue.recordHeardInTransaction(
				db,
				runId,
				full ? "full" : heard ? "partial" : "none",
				heard,
			);
		});
	} catch (error) {
		log.warn("voice.speech_record_failed", {
			runId,
			reason: toErrorCode(error, "speech_record_failed"),
		});
	}
}
