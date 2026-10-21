import type { ExecutionSource } from "../../tool-runtime";
import type {
	ExecutionRow,
	ParentState,
	executionObservations,
} from "../repository/executions";
import {
	executionPlanProjection,
	executionPhaseInstruction,
} from "./execution-plan";

/** Match bounded observations to their persisted invocation; never infer an action from prose. */
export function executionMessages(
	row: ExecutionRow,
	state: ParentState,
	source: ExecutionSource,
	observations: ReturnType<typeof executionObservations>,
) {
	const results = state.notes.map((note) => {
		const observation = observations.find(({ child }) => child.id === note.id);
		const child = observation?.child;
		const output = observation?.result?.output;
		const text = output === undefined ? undefined : JSON.stringify(output);
		return {
			...note,
			...(text && text.length <= 2000
				? { output, ...(note.summary === text ? { summary: undefined } : {}) }
				: {}),
			...(child
				? {
						toolchainRevisionId: child.chainRevisionId,
						stepRequest: child.request.slice(0, 500),
						requestTruncated: child.request.length > 500,
					}
				: {}),
		};
	});
	return [
		{
			role: "system" as const,
			content: `${state.instructions}\n\n${executionPhaseInstruction(state)}`,
		},
		{
			role: "user" as const,
			content:
				"CONVERSATION_REFERENCE=" +
				JSON.stringify({ delegationSummary: row.request }),
		},
		{
			role: "user" as const,
			content: JSON.stringify({
				plan: executionPlanProjection(state),
				references: state.refs.map(
					({ ref, kind, label, preview, id, owner }) => ({
						ref,
						kind,
						label,
						// The observation already carries its summary. Host identities and digests are not model inputs.
						...(owner === "agent-runtime" &&
						results.some((note) => note.id === id)
							? {}
							: { preview }),
					}),
				),
				results,
				callsLeft: state.limits.parentCalls - state.calls,
				childCallsLeft: state.limits.childCalls - state.children,
				modelCallsLeft: state.limits.modelCalls - state.consumed,
				searchesLeft: state.limits.searches - state.searches,
				...(state.correction ? { contractError: state.correction } : {}),
				originalRequest: source.request,
				requestUpdates: source.amendments,
				userAnswers: source.responses,
			}),
		},
	];
}
