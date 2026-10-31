import { emotions } from "eumenes-agency";
import { conversationPersona } from "../../domains/dialogue";
import type { ConversationAgentSystem } from "../../domains/dialogue/contracts";
import type { Settings } from "../../domains/settings";
import { systemContext } from "../../infrastructure/system-context";

type Persona = Pick<Settings["general"], "agentName" | "userName" | "persona">;
const feelingNames = emotions
	.map(({ emoji, label }) => `${emoji}: ${label}`)
	.join(" / ");

/** Only Eumenes-authored instruction assets; Agency supplies the public execution contracts. */
export function agencyReplyParts(
	settings: Settings["agency"],
): ConversationAgentSystem {
	return {
		base: systemContext("dialogue.contexts.agency.reply", {}),
		...(settings.interests.length
			? {
					persona: systemContext("dialogue.contexts.agency.interests", {
						interests: JSON.stringify(settings.interests),
					}),
				}
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

/** A full purpose-specific system, resolved for this logical call, with no observation or history in it. */
export function agencyBackgroundSystem(
	purpose: "update" | "select",
	input: { readonly outputContract: { readonly description: string } },
	persona: Persona,
	emotion: boolean,
): string {
	const own = conversationPersona(persona);
	return [
		systemContext("dialogue.contexts.agency.background", own),
		purpose === "update"
			? systemContext("dialogue.contexts.agency.update", {})
			: systemContext("dialogue.contexts.agency.select", {
					utterance: systemContext("dialogue.contexts.agency.utterance", {}),
					emotion: emotion
						? systemContext("dialogue.contexts.agency.select-emotion", {
								emotions: feelingNames,
							})
						: "",
				}),
		systemContext("dialogue.contexts.agency.output-contract", {
			contract: input.outputContract.description,
		}),
	].join("\n\n");
}
