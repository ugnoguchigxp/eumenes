import type { Migration, SqliteStore } from "../../../infrastructure/sqlite";
import {
	monitoringEventSchema,
	type MonitoringEvent,
} from "../../larm/contracts";
import {
	collectedLarmSchema,
	emptyLarm,
	type CollectedLarm,
} from "../contracts/larm";

export const migrations: readonly Migration[] = [
	{
		id: "monitoring/0001-larm",
		after: ["settings/0001-init"],
		sql: `
CREATE TABLE monitoring_larm_state (id INTEGER PRIMARY KEY CHECK(id=1), source_key TEXT NOT NULL, document TEXT NOT NULL);
CREATE TABLE monitoring_larm_events (source_key TEXT NOT NULL, id TEXT NOT NULL, occurred INTEGER NOT NULL, bytes INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(source_key,id));
CREATE INDEX monitoring_larm_events_time ON monitoring_larm_events(source_key,occurred);
`,
	},
];

/** The same ten-minute window and 100k/64MiB bounds as the upstream event store. */
export function createLarmRepository(store: SqliteStore, now = Date.now) {
	return {
		read(key: string): CollectedLarm {
			return store.read((db) => {
				const row = db
					.query(
						"SELECT source_key,document FROM monitoring_larm_state WHERE id=1",
					)
					.get() as { source_key: string; document: string } | null;
				return row?.source_key === key
					? collectedLarmSchema.parse(JSON.parse(row.document))
					: emptyLarm(now());
			});
		},
		async save(
			key: string,
			state: CollectedLarm,
			events: readonly MonitoringEvent[],
			current: () => void,
		) {
			await store.write((db) => {
				current();
				db.query("DELETE FROM monitoring_larm_events WHERE source_key<>?").run(
					key,
				);
				const insert = db.query(
					"INSERT OR IGNORE INTO monitoring_larm_events VALUES(?,?,?,?,?)",
				);
				for (const event of events) {
					const document = JSON.stringify(event);
					insert.run(
						key,
						event.id,
						Date.parse(event.occurredAt),
						Buffer.byteLength(document),
						document,
					);
				}
				const expired = db
					.query(
						"SELECT max(occurred) AS through FROM monitoring_larm_events WHERE occurred<?",
					)
					.get(now() - 600_000) as { through: number | null };
				if (expired.through !== null)
					state.localPrunedBefore = Math.max(
						state.localPrunedBefore ?? 0,
						expired.through,
					);
				db.query("DELETE FROM monitoring_larm_events WHERE occurred<?").run(
					now() - 600_000,
				);
				const totals = db
					.query(
						"SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM monitoring_larm_events WHERE source_key=?",
					)
					.get(key) as { count: number; bytes: number };
				if (totals.count > 100_000 || totals.bytes > 67_108_864) {
					const rows = db
						.query(
							"SELECT id,occurred,bytes FROM monitoring_larm_events WHERE source_key=? ORDER BY occurred,id",
						)
						.all(key) as { id: string; occurred: number; bytes: number }[];
					const remove = db.query(
						"DELETE FROM monitoring_larm_events WHERE source_key=? AND id=?",
					);
					for (const row of rows) {
						if (totals.count <= 100_000 && totals.bytes <= 67_108_864) break;
						remove.run(key, row.id);
						totals.count--;
						totals.bytes -= row.bytes;
						state.localPrunedBefore = Math.max(
							state.localPrunedBefore ?? 0,
							row.occurred,
						);
					}
				}
				db.query(
					"INSERT INTO monitoring_larm_state VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET source_key=excluded.source_key,document=excluded.document",
				).run(key, JSON.stringify(state));
			});
		},
		events(key: string) {
			return store.read((db) =>
				(
					db
						.query(
							"SELECT document FROM monitoring_larm_events WHERE source_key=? AND occurred>=? ORDER BY occurred,id",
						)
						.all(key, now() - 600_000) as { document: string }[]
				).map((row) => monitoringEventSchema.parse(JSON.parse(row.document))),
			);
		},
	};
}
export type LarmRepository = ReturnType<typeof createLarmRepository>;
