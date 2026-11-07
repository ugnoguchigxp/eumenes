import {
	createAgencyRuntime,
	defaultBudget,
	RECENT_OBSERVATION_WINDOW,
	type LlmPort,
	type HostTodo,
	type HostTopic,
	type AgencyRestore,
	type ToolCapability,
	type InputContext,
	type ObservationArchive,
} from "eumenes-agency";
import type { Settings } from "../../domains/settings";
import { agencyBackgroundSystem } from "./system-context";

/** Composition of the adopted F model on Eumenes-owned instructions and host data. */
export function createHostRuntime(input: {
	agency: Settings["agency"];
	now: () => number;
	persona: Pick<Settings["general"], "agentName" | "userName" | "persona">;
	llm: LlmPort;
	topics(): readonly HostTopic[];
	todos(): readonly HostTodo[];
	restore?: AgencyRestore;
	tools?: readonly ToolCapability[];
	input?: () => InputContext;
	archive?: ObservationArchive;
}) {
	const { agency, persona } = input;
	return createAgencyRuntime({
		condition: "F",
		conversationParticipation: true,
		now: input.now,
		planOnOpportunity: true,
		repairUpdates: true,
		constrainToolNames: true,
		findings: true,
		archive: input.archive,
		...(input.restore ? { restore: input.restore } : {}),
		interestFormation: true,
		hostTopics: true,
		hostTodos: true,
		// A live selection uses ~13k tokens: discovery and delegation share one activity.
		// Keep Agency's three-operation / 30-minute bounds and account for the full input.
		activityLimits: {
			toolCalls: 3,
			tokens: 60_000,
			elapsedMs: 30 * 60_000,
		},
		...(agency.emotion ? { utteranceEmotion: true } : {}),
		systemContext: {
			update: (data) => ({
				value: agencyBackgroundSystem("update", data, persona, agency.emotion),
				input: input.input?.() ?? { sources: [], complete: false },
			}),
			select: (data) => ({
				value: agencyBackgroundSystem("select", data, persona, agency.emotion),
				input: input.input?.() ?? { sources: [], complete: false },
			}),
		},
		standingInterests: agency.interests.map((text, index) => ({
			id: `persona-${index + 1}`,
			text,
			input: { sources: [], complete: true },
		})),
		todos: input.todos,
		topics: input.topics,
		budget: {
			...defaultBudget,
			// Consume a burst in one bounded update instead of spending the call window catching up.
			batchSize: RECENT_OBSERVATION_WINDOW,
			updateMaxOutputTokens: 2400,
			selectMaxOutputTokens: 1000,
		},
		tools: input.tools ?? [],
		llm: input.llm,
	});
}
