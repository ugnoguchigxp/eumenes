import { systemContext } from "../../../infrastructure/system-context";
import type { InferencePort } from "../../inference";
type AgentGeneral = Pick<
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
function personaParts(general: AgentGeneral) {
	const persona = PERSONAS[general.persona] ?? PERSONAS.butler;
	return {
		...persona,
		agent: general.agentName
			? systemContext("dialogue.contexts.system-prompt.agent-name", {
					name: general.agentName,
				})
			: "",
		user: general.userName
			? systemContext("dialogue.contexts.system-prompt.user-name", {
					name: general.userName,
				})
			: "",
	};
}
export function buildSystemPrompt(general: AgentGeneral) {
	return systemContext(
		"dialogue.contexts.system-prompt.conversation",
		personaParts(general),
	);
}
