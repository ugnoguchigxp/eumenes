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
 * The section headings of the system part (the conversation input specification, section 4.1): the role, then the
 * rules on handing work over and on the tools (placed lower, a creation request was answered without a call), then
 * the rest. None of them is one of the input's own headings (`## Memory`, `## State`, `## User`, `## Host notice`,
 * `## Task`).
 */
export const SYSTEM_SECTIONS = [
	"Role",
	"Toolchains",
	"Tools",
	"Speaking",
	"Emotion",
	"Input",
	"Facts",
	"Results",
] as const;
export type SystemSection = (typeof SYSTEM_SECTIONS)[number];
/** The talk turn's sections (the local harness rebuild plan, section 4.2): nothing of toolchains, tools or results. */
export const TALK_SECTIONS = [
	"Role",
	"Speaking",
	"Emotion",
	"Input",
	"Facts",
] as const satisfies readonly SystemSection[];
/** `full`: a reply that calls the tools itself; `talk`: the local talk turn, which names no toolchain or tool. */
export type SystemTexts = "full" | "talk";

/** The persona's tone, for words the host has the model write outside the talk turn (the choice call's `say`). */
export const personaStyle = (persona: PersonaSpec) =>
	(PERSONAS[persona.persona] ?? PERSONAS.butler).style;

/** The toolchain titles as the system part lists them. */
export const toolchainListing = (titles: readonly string[]) =>
	titles.join("、");

/**
 * The system part: the agent's parts and the host's rules under their section headings. Each rule says when it
 * applies and stands in one section only, so the text is the same in every call and changes only with the
 * settings and the toolchains it can hand work to. The harness names the sections and their order.
 */
export function systemText(
	persona: PersonaSpec,
	agent: ConversationAgentSystem,
	toolchainTitles: readonly string[] = [],
	order: readonly SystemSection[] = SYSTEM_SECTIONS,
	texts: SystemTexts = "full",
): string {
	const talk = texts === "talk";
	const own = PERSONAS[persona.persona] ?? PERSONAS.butler;
	const sections: Record<SystemSection, Array<string | undefined>> = {
		Role: [
			agent.base,
			systemContext("dialogue.contexts.system.role", {
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
			agent.persona,
		],
		Speaking: [
			agent.spokenReplyStyle,
			talk
				? systemContext("dialogue.contexts.system.talk-speaking", {
						style: own.style,
					})
				: systemContext("dialogue.contexts.system.speaking", {
						style: own.style,
					}),
		],
		Emotion: [agent.emotionRules],
		Input: [systemContext("dialogue.contexts.system.input", {})],
		Facts: [
			systemContext(
				talk
					? "dialogue.contexts.system.talk-facts"
					: "dialogue.contexts.system.facts",
				{},
			),
		],
		Tools: [
			agent.toolRules,
			systemContext("dialogue.contexts.system.tools", {}),
		],
		Toolchains: [
			systemContext("dialogue.contexts.system.toolchains", {
				titles: toolchainTitles.length
					? toolchainListing(toolchainTitles)
					: "なし",
			}),
		],
		Results: [systemContext("dialogue.contexts.system.results", {})],
	};
	return order
		.flatMap((name) => {
			const parts = sections[name].filter((part): part is string => !!part);
			return parts.length ? [`## ${name}\n${parts.join("\n")}`] : [];
		})
		.join("\n\n");
}
