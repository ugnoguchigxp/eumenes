import type { Database } from "bun:sqlite";
import {
	capturesRevision,
	connectionCount,
	listCaptures,
	listReplayRows,
	listTasks,
	replaysRevision,
	replayView,
	tabsRevision,
	tasksRevision,
} from "../repository";
import { connectionView } from "./connection";
import type { Ctx } from "./context";
import { tabViews } from "./tabs";

/** What the browser screen reads: the connection, the tabs, and the owner's newest tasks, captures and replays. */
export function workspaceSource(ctx: Ctx, db: Database, owner: string) {
	const view = connectionView(ctx, db);
	const settings = db
		.query(
			"SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),0) AS t FROM browser_settings",
		)
		.get() as { n: number; t: number };
	return {
		revision:
			connectionCount(db) +
			tabsRevision(db) +
			tasksRevision(db) +
			capturesRevision(db) +
			replaysRevision(db) +
			settings.n +
			settings.t,
		data: {
			availability: view.availability,
			connection: view,
			tabs: tabViews(ctx, db),
			tasks: listTasks(db, owner),
			captures: listCaptures(db, owner),
			replays: listReplayRows(db, owner).map(replayView),
		},
	};
}
