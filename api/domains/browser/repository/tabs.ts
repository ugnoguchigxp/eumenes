import type { Database } from "bun:sqlite";
import { patchRow } from "./sql";

export type TabRow = {
	tab_ref: string;
	connection_id: string;
	mcp_index: number;
	url: string;
	title: string;
	status: "open" | "lost" | "closed" | "blocked";
	is_current: number;
	generation: number;
	observation_ref: string | null;
	lease_holder: string | null;
	lease_epoch: number;
	lease_expires_at: number | null;
	revision: number;
	created_at: number;
	updated_at: number;
};

export const tabRow = (db: Database, tabRef: string) =>
	db
		.query("SELECT * FROM browser_tabs WHERE tab_ref=?")
		.get(tabRef) as TabRow | null;

export const openTabs = (db: Database, connectionId: string) =>
	db
		.query(
			"SELECT * FROM browser_tabs WHERE connection_id=? AND status='open' ORDER BY mcp_index",
		)
		.all(connectionId) as TabRow[];

/** Tabs of the live connection, then the ones that just ended, for the screen. */
export const recentTabs = (db: Database, limit = 50) =>
	db
		.query(
			`SELECT * FROM browser_tabs ORDER BY (status='open') DESC, updated_at DESC, mcp_index LIMIT ?`,
		)
		.all(limit) as TabRow[];

export function insertTab(
	db: Database,
	tab: {
		tabRef: string;
		connectionId: string;
		index: number;
		url: string;
		title: string;
		current: boolean;
	},
	now: number,
) {
	db.query(
		`INSERT INTO browser_tabs(tab_ref,connection_id,mcp_index,url,title,status,is_current,created_at,updated_at)
		 VALUES(?,?,?,?,?,'open',?,?,?)`,
	).run(
		tab.tabRef,
		tab.connectionId,
		tab.index,
		tab.url,
		tab.title,
		tab.current ? 1 : 0,
		now,
		now,
	);
}

type TabChange = Partial<
	Pick<
		TabRow,
		| "mcp_index"
		| "url"
		| "title"
		| "status"
		| "is_current"
		| "generation"
		| "observation_ref"
		| "lease_holder"
		| "lease_epoch"
		| "lease_expires_at"
	>
>;
export function patchTab(
	db: Database,
	tabRef: string,
	change: TabChange,
	now: number,
) {
	patchRow(db, "browser_tabs", "tab_ref", tabRef, change, now);
}

/** Any action that may have reached the page: previous observations stop being valid. */
export function bumpGeneration(db: Database, tabRef: string, now: number) {
	db.query(
		"UPDATE browser_tabs SET generation=generation+1, observation_ref=NULL, revision=revision+1, updated_at=? WHERE tab_ref=?",
	).run(now, tabRef);
}

export function clearLeases(db: Database, holder: string, now: number) {
	db.query(
		"UPDATE browser_tabs SET lease_holder=NULL, lease_expires_at=NULL, revision=revision+1, updated_at=? WHERE lease_holder=?",
	).run(now, holder);
}

/** Every open tab of a connection stops being addressable (disconnect, restart). */
export function loseTabs(db: Database, connectionId: string, now: number) {
	db.query(
		`UPDATE browser_tabs SET status='lost', is_current=0, generation=generation+1, observation_ref=NULL,
		 lease_holder=NULL, lease_expires_at=NULL, revision=revision+1, updated_at=?
		 WHERE connection_id=? AND status='open'`,
	).run(now, connectionId);
	db.query(
		"DELETE FROM browser_observations WHERE tab_ref IN (SELECT tab_ref FROM browser_tabs WHERE connection_id=?)",
	).run(connectionId);
}

export type ObservationRow = {
	ref: string;
	tab_ref: string;
	generation: number;
	task_id: string | null;
	refs_json: string;
	truncated: number;
	created_at: number;
};

export const observationRow = (db: Database, ref: string) =>
	db
		.query("SELECT * FROM browser_observations WHERE ref=?")
		.get(ref) as ObservationRow | null;

/** A new observation replaces the tab's earlier ones: only the latest pair is actionable. */
export function insertObservation(
	db: Database,
	o: {
		ref: string;
		tabRef: string;
		generation: number;
		taskId: string | null;
		refs: readonly string[];
		truncated: boolean;
	},
	now: number,
) {
	db.query("DELETE FROM browser_observations WHERE tab_ref=?").run(o.tabRef);
	db.query(
		"INSERT INTO browser_observations(ref,tab_ref,generation,task_id,refs_json,truncated,created_at) VALUES(?,?,?,?,?,?,?)",
	).run(
		o.ref,
		o.tabRef,
		o.generation,
		o.taskId,
		JSON.stringify(o.refs),
		o.truncated ? 1 : 0,
		now,
	);
	patchTab(db, o.tabRef, { observation_ref: o.ref }, now);
}

export function pruneTabs(db: Database, before: number) {
	db.query("DELETE FROM browser_observations WHERE created_at<?").run(before);
	db.query(
		"DELETE FROM browser_tabs WHERE status!='open' AND updated_at<? AND lease_holder IS NULL",
	).run(before);
}

export const tabsRevision = (db: Database) =>
	(
		db
			.query("SELECT COALESCE(SUM(revision+1),0) AS n FROM browser_tabs")
			.get() as { n: number }
	).n;
