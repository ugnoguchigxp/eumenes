import { workRoot } from "./always-on-flow";
import type { AgendaScope } from "./always-on-scope";
import type { AgencyHostDeps } from "./host-types";

/**
 * Reconcile the saved research tickets with the work ledger after a restart: a ticket whose work is gone (the start
 * never committed, or it was revoked) is dropped, one whose work still runs or whose result is not yet taken stays.
 * Pending speech was never saved, so nothing is said twice; the agent asks again for what it still owes.
 */
export function recoverAgendaScope(
	deps: AgencyHostDeps,
	c: AgendaScope,
	now: number,
) {
	if (!deps.state) return;
	const alive = deps.store.read((db) =>
		c.tickets.filter((t) =>
			deps.state!.workActiveInTransaction(db, workRoot(c, t.id)),
		),
	);
	if (alive.length !== c.tickets.length) {
		c.tickets = alive;
		c.revision++;
	}
	c.touched = now;
}
