import { systemContext } from "../../../infrastructure/system-context";
import { buildSystemPrompt } from "./system-prompt";

/** The persona the system part is written for: the agent's name, the user's name and the tone. */
export type PersonaSpec = Parameters<typeof buildSystemPrompt>[0];

/**
 * The host's rules of the system part, in the order it writes them. Each says when it applies, so the list is the
 * same in every generation: the system part changes only with the settings (the ContextWindow specification,
 * section 12.1).
 */
const RULES = [
	"dialogue.contexts.host-rules.context-sources",
	"dialogue.contexts.host-rules.tools",
	"dialogue.contexts.host-rules.operation-action",
	"dialogue.contexts.host-rules.operation-command-question",
	"dialogue.contexts.host-rules.operation-recognition",
	"dialogue.contexts.host-rules.operation-delegation",
	"dialogue.contexts.host-rules.operation-drawing",
	"dialogue.contexts.host-rules.operation-image",
	"dialogue.contexts.host-rules.operation-music",
	"dialogue.contexts.host-rules.research-result",
	"dialogue.contexts.host-rules.research-world",
	"dialogue.contexts.host-rules.research-document",
	"dialogue.contexts.conversation-generation.correction",
	"dialogue.contexts.conversation-generation.correction-3",
	"dialogue.contexts.conversation-generation.correction-4",
] as const;

/** The system part (A1): the persona, then every host rule. */
export function systemText(persona: PersonaSpec): string {
	return (
		buildSystemPrompt(persona) +
		RULES.map((key) => "\n" + systemContext(key, {})).join("")
	);
}

/** The host's fixed newest message of a generation without a new utterance (section 5.1). */
export const FIXED_TRIGGER_TEXT =
	"新しい出来事があります。話すかどうか、何を話すかを判断してください。";
