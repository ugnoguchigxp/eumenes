import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import {
	executionObservation,
	type ParentState,
} from "../repository/executions";
import { planReady, runnablePlanItems } from "./execution-plan";

/** An item is the identity of an operation; equal text in different items is intentional. */
export function plannedInvocation(
	db: Database,
	state: ParentState,
	chainRevisionId: string,
	args: Record<string, unknown>,
) {
	const item = state.plan?.items.find(
		(entry) => entry.stepRef === args.stepRef,
	);
	if (!planReady(state) || !item) throw new Error("execution_step_not_offered");
	const input = {
		chainRevisionId,
		request: item.request,
		...(args.arguments
			? { arguments: args.arguments as Record<string, unknown> }
			: {}),
		refs: state.refs.filter((ref) =>
			(args.contextRefs as string[]).includes(ref.ref),
		),
	};
	const digest = hash(input);
	if (item.inputDigest) {
		if (item.inputDigest !== digest) throw new Error("execution_step_conflict");
		return {
			item,
			digest,
			input,
			replay: executionObservation(db, item.childId),
		};
	}
	if (!runnablePlanItems(state).includes(item))
		throw new Error("execution_step_not_offered");
	return { item, digest, input, replay: null };
}
