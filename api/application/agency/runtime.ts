import {
	createAgencyRuntime,
	defaultBudget,
	type LlmPort,
	type HostTodo,
	type HostTopic,
	type AgencyRestore,
	type ToolCapability,
} from "eumenes-agency";
import type { Settings } from "../../domains/settings";
import { agencyBackgroundSystem } from "./system-context";

/** Composition of the adopted F model on Eumenes-owned instructions and host data. */
export function createHostRuntime(input: {
	agency: Settings["agency"];
	persona: Pick<Settings["general"], "agentName" | "userName" | "persona">;
	llm: LlmPort;
	topics(): readonly HostTopic[];
	todos(): readonly HostTodo[];
	restore?: AgencyRestore;
	tools?: readonly ToolCapability[];
}) {
	const { agency, persona } = input;
	return createAgencyRuntime({
		condition: "F",
		planOnOpportunity: true,
		repairUpdates: true,
		constrainToolNames: true,
		findings: true,
		...(input.restore ? { restore: input.restore } : {}),
		interestFormation: true,
		hostTopics: true,
		hostTodos: true,
		...(agency.emotion ? { utteranceEmotion: true } : {}),
		systemContext: {
			update: (data) =>
				agencyBackgroundSystem("update", data, persona, agency.emotion),
			select: (data) =>
				agencyBackgroundSystem("select", data, persona, agency.emotion),
		},
		standingInterests: agency.interests.map((text, index) => ({
			id: `persona-${index + 1}`,
			text,
		})),
		todos: input.todos,
		topics: input.topics,
		budget: {
			...defaultBudget,
			updateMaxOutputTokens: 2400,
			selectMaxOutputTokens: 1000,
		},
		tools: input.tools ?? [],
		llm: input.llm,
	});
}
