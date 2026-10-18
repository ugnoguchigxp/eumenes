import type { Database } from "bun:sqlite";
import { connectedConnection } from "./connection";
import type { Ctx } from "./context";
import { ownedTask, taskRow, tabRow, type TabRow } from "../repository";
import {
	acquireLease,
	assertActionable,
	leaseHeld,
	openTab,
	type Holder,
} from "./tabs";

export type TaskRef = { id: string; epoch: number; deadline: number };

export function taskFor(
	db: Database,
	owner: string,
	taskId: string | null,
): TaskRef | null {
	if (!taskId) return null;
	const t = ownedTask(db, taskId, owner);
	if (t.state === "indeterminate") throw new Error("task_indeterminate");
	if (t.state !== "running") throw new Error("task_not_active");
	return { id: t.id, epoch: t.epoch, deadline: t.deadline };
}

export const checkRef = (
	db: Database,
	tab: TabRow,
	task: TaskRef | null,
	observationRef: string,
	ref: string,
) => assertActionable(db, tab, task?.id ?? null, observationRef, ref);

/** Connection, task and tab checks and the tab lease; used by operations and observations alike. */
export function begin(
	ctx: Ctx,
	db: Database,
	owner: string,
	taskId: string | null,
	tabRef: string | undefined,
	needsTab: boolean,
	opId: string,
) {
	const conn = connectedConnection(ctx, db);
	const task = taskFor(db, owner, taskId);
	if (!needsTab)
		return {
			conn,
			task,
			tab: null,
			epoch: 0,
			holder: null,
			releaseAfter: false,
		};
	const t = openTab(tabRef ? tabRow(db, tabRef) : null);
	if (t.connection_id !== conn.id) throw new Error("tab_lost");
	const holder: Holder = task
		? { id: task.id, deadline: task.deadline }
		: { id: `op:${opId}`, deadline: Number.MAX_SAFE_INTEGER };
	const { tab, epoch } = acquireLease(ctx, db, t.tab_ref, holder);
	return { conn, task, tab, epoch, holder, releaseAfter: !task };
}

/** What must still hold at the moment a call is sent. */
export function guard(
	ctx: Ctx,
	db: Database,
	p: {
		connectionId: string;
		task: TaskRef | null;
		tab: TabRow | null;
		holder: Holder | null;
		epoch: number;
	},
) {
	if (connectedConnection(ctx, db).id !== p.connectionId)
		throw new Error("browser_disconnected");
	if (p.task) {
		const t = taskRow(db, p.task.id);
		if (!t || t.state !== "running" || t.epoch !== p.task.epoch)
			throw new Error("task_not_active");
	}
	if (p.tab && p.holder) {
		const t = openTab(tabRow(db, p.tab.tab_ref));
		if (!leaseHeld(ctx, db, t.tab_ref, p.holder, p.epoch))
			throw new Error("lease_lost");
	}
}
