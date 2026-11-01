import {
	createAgencyRuntime,
	defaultBudget,
	type LlmPort,
	type HostTodo,
	type HostTopic,
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
}) {
	const { agency, persona } = input;
	return createAgencyRuntime({
		condition: "F",
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
		tools: [],
		llm: input.llm,
	});
}
