import type { Database } from "bun:sqlite";
import type { Task } from "../contracts";

/** Stored in the existing task acquisition column; pending reads use normal tool receipts. */
export type WebReadState = {
	kind: "guided-web";
	executionRef?: string;
	stepId?: string;
	parentJobId?: string;
	queue: string[];
	reads: Array<{
		id: string;
		url: string;
		settled: boolean;
		retryAfter?: number;
	}>;
	arrivals: number;
	presented: number;
	batchArrivals: number;
	hedgeAt: number | null;
};
export function webReadState(t: Task): WebReadState {
	const parsed = t.acquisition_plan_json
		? JSON.parse(t.acquisition_plan_json)
		: null;
	return parsed?.kind === "guided-web"
		? parsed
		: {
				kind: "guided-web",
				queue: [],
				reads: [],
				arrivals: 0,
				presented: 0,
				batchArrivals: 0,
				hedgeAt: null,
			};
}
export function saveWebReadState(
	db: Database,
	id: string,
	state: WebReadState,
) {
	db.query("UPDATE agent_tasks SET acquisition_plan_json=? WHERE id=?").run(
		JSON.stringify(state),
		id,
	);
}
export const WEB_READ_POLICY = Object.freeze({
	pair: 2,
	hedgeMs: 10000,
	concurrent: 6,
	perHost: 2,
});
