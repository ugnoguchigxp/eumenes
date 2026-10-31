import { systemContext } from "../../../infrastructure/system-context";
import type { InferencePort } from "../../inference";
import type { ConversationAgentSystem } from "../contracts";

/** The persona the system part is written for: the agent's name, the user's name and the tone. */
export type PersonaSpec = Pick<
	ReturnType<NonNullable<InferencePort["snapshotInTransaction"]>>["general"],
	"agentName" | "userName" | "persona"
>;

const PERSONAS = {
	butler: {
		role: systemContext("dialogue.contexts.system-prompt.butler-role", {}),
		style: systemContext("dialogue.contexts.system-prompt.butler-style", {}),
	},
	maid: {
		role: systemContext("dialogue.contexts.system-prompt.maid-role", {}),
		style: systemContext("dialogue.contexts.system-prompt.maid-style", {}),
	},
	strategist: {
		role: systemContext("dialogue.contexts.system-prompt.strategist-role", {}),
		style: systemContext(
			"dialogue.contexts.system-prompt.strategist-style",
			{},
		),
	},
	sage: {
		role: systemContext("dialogue.contexts.system-prompt.sage-role", {}),
		style: systemContext("dialogue.contexts.system-prompt.sage-style", {}),
	},
};

/**
 * The section headings of the system part, in the order they are written (the conversation input specification,
 * section 4.1; the local harness rebuild plan, section 4.2): the talk turn names no toolchain, tool or result. None
 * of them is one of the input's own headings (`## Memory`, `## State`, `## User`, `## Host notice`, `## Task`).
 */
export const TALK_SECTIONS = [
	"Role",
	"Speaking",
	"Emotion",
	"Input",
	"Facts",
] as const;
export type SystemSection = (typeof TALK_SECTIONS)[number];

/** The persona's tone, for words the host has the model write outside the talk turn (the choice call's `say`). */
export const personaStyle = (persona: PersonaSpec) =>
	(PERSONAS[persona.persona] ?? PERSONAS.butler).style;

/** The configured identity and voice, shared by the host's reply and background instructions. */
export function conversationPersona(persona: PersonaSpec) {
	const own = PERSONAS[persona.persona] ?? PERSONAS.butler;
	return {
		role: systemContext("dialogue.contexts.system.role", {
			role: own.role,
			agent: persona.agentName
				? systemContext("dialogue.contexts.system-prompt.agent-name", {
						name: persona.agentName,
					})
				: "",
			user: persona.userName
				? systemContext("dialogue.contexts.system-prompt.user-name", {
						name: persona.userName,
					})
				: "",
		}),
		style: own.style,
	};
}

/**
 * The system part: the agent's parts and the host's rules under their section headings. Each rule says when it
 * applies and stands in one section only, so the text is the same in every call and changes only with the settings.
 */
export function systemText(
	persona: PersonaSpec,
	agent: ConversationAgentSystem,
): string {
	const own = conversationPersona(persona);
	const sections: Record<SystemSection, Array<string | undefined>> = {
		Role: [agent.base, own.role, agent.persona],
		Speaking: [
			agent.spokenReplyStyle,
			systemContext("dialogue.contexts.system.talk-speaking", {
				style: own.style,
			}),
		],
		Emotion: [agent.emotionRules],
		Input: [systemContext("dialogue.contexts.system.input", {})],
		Facts: [systemContext("dialogue.contexts.system.talk-facts", {})],
	};
	return TALK_SECTIONS.flatMap((name) => {
		const parts = sections[name].filter((part): part is string => !!part);
		return parts.length ? [`## ${name}\n${parts.join("\n")}`] : [];
	}).join("\n\n");
}
