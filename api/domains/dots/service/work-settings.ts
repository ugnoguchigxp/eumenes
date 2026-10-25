import type { Database } from "bun:sqlite";
import {
	defaultWorkSettings,
	workSettings,
	type WorkSettings,
} from "../contracts/work-settings";
import * as repo from "../repository";
import { workOperation, putWorkOperation } from "../repository/work";
export function createWorkSettings(now: () => number = Date.now) {
	return {
		inTransaction(db: Database): { revision: number; settings: WorkSettings } {
			const row = db
				.query("SELECT revision,data_json FROM dots_work_settings WHERE id=1")
				.get() as { revision: number; data_json: string } | null;
			return {
				revision: row?.revision ?? 0,
				settings: row
					? workSettings.parse(JSON.parse(row.data_json))
					: { ...defaultWorkSettings },
			};
		},
		applyInTransaction(
			db: Database,
			input: {
				requestId: string;
				expectedRevision: number;
				settings: unknown;
				digest: string;
			},
		) {
			const old = workOperation(db, input.requestId);
			if (old) {
				if (old.digest !== input.digest || old.origin_json !== '"settings"')
					throw new Error("dots_conflict");
				return {
					receipt: JSON.parse(old.receipt_json) as { revision: number },
					replay: true,
				};
			}
			const row = db
				.query("SELECT revision FROM dots_work_settings WHERE id=1")
				.get() as { revision: number } | null;
			if ((row?.revision ?? 0) !== input.expectedRevision)
				throw new Error("revision_conflict");
			const settings = workSettings.parse(input.settings);
			const connection = settings.connectionRef
				? repo.connection(db, settings.connectionRef)
				: null;
			const project = settings.projectRef
				? repo.project(db, settings.projectRef)
				: null;
			if (
				(settings.connectionRef && !connection) ||
				(settings.projectRef &&
					(!project || project.connectionRef !== settings.connectionRef))
			)
				throw new Error("dots_settings_target_invalid");
			if (settings.enabled && (!connection?.enabled || !project?.enabled))
				throw new Error("dots_unavailable");
			const revision = input.expectedRevision + 1;
			db.query(
				"INSERT INTO dots_work_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json",
			).run(revision, JSON.stringify(settings));
			const receipt = { version: 1, operation: "settings", revision };
			putWorkOperation(db, {
				id: input.requestId,
				digest: input.digest,
				origin: JSON.stringify("settings"),
				receipt,
				now: now(),
			});
			return { receipt, replay: false };
		},
	};
}
