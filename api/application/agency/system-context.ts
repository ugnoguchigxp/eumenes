import { emotions } from "eumenes-agency";
import type { ConversationAgentSystem } from "../../domains/dialogue/contracts";
import type { Settings } from "../../domains/settings";
import { systemContext } from "../../infrastructure/system-context";
import { agendaReplyRules } from "./always-on-system";

const feelingNames = emotions
	.map(({ emoji, label }) => `${emoji}: ${label}`)
	.join(" / ");

/** Only Eumenes-authored instruction assets; Agency supplies the public execution contracts. */
export function agencyReplyParts(
	settings: Settings["agency"],
	/** The agenda serves the reply now (its memory ready): only then are its rules in the system. */
	agenda = true,
): ConversationAgentSystem {
	return {
		base: [
			systemContext("dialogue.contexts.agency.reply", {}),
			...(agenda
				? [
						systemContext("dialogue.contexts.agency.always-on-reply", {}),
						agendaReplyRules(),
					]
				: []),
		].join("\n\n"),
		...(settings.interests.length
			? {
					persona: systemContext("dialogue.contexts.agency.interests", {
						interests: JSON.stringify(settings.interests),
					}),
				}
			: {}),
		...(agenda
			? { facts: systemContext("dialogue.contexts.agency.talk-facts", {}) }
			: {}),
		spokenReplyStyle: systemContext("dialogue.contexts.agency.spoken", {}),
		...(settings.emotion
			? {
					emotionRules: systemContext("dialogue.contexts.agency.emotion", {
						emotions: feelingNames,
					}),
				}
			: {}),
	};
}
