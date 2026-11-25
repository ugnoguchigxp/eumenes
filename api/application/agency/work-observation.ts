import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../infrastructure/digest";
import { workRoot } from "./always-on-flow";
import type { AgendaScope } from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";
import { currentInput } from "./input";

export function assignmentViews(
	deps: AgencyHostDeps,
	db: Database,
	c: AgendaScope,
) {
	const state = deps.state;
	if (!state) return [];
	return c.tickets.flatMap((ticket) => {
		if (!ticket.assignment) return [];
		const view = state.assignmentViewInTransaction(db, workRoot(c, ticket.id));
		return view ? [{ ticket, view }] : [];
	});
}

export function workVersionInTransaction(
	deps: AgencyHostDeps,
	db: Database,
	c: AgendaScope,
) {
	return JSON.stringify(
		assignmentViews(deps, db, c).map(({ ticket, view }) => [
			ticket.id,
			view.status,
		]),
	);
}

/** What the agent's step is told of the assignments it holds (what each asked, its status, whether its report came). */
export type WorkObservation = { text: string; digest: string };

export function workObservation(
	deps: AgencyHostDeps,
	db: Database,
	c: AgendaScope,
): WorkObservation | null {
	const current = assignmentViews(deps, db, c)
		.filter(({ ticket }) =>
			currentInput(deps, db, { sources: ticket.inputs, complete: true }),
		)
		.map(({ ticket, view }) => ({
			work: ticket.itemId,
			request: ticket.question.slice(0, 240),
			status: view.status,
			reportReceived: view.result != null,
		}));
	if (!current.length) return null;
	const text = JSON.stringify(current);
	return { text, digest: sha256Hex(text) };
}
