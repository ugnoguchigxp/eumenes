import type { Database } from "bun:sqlite";
import type { Migration } from "../../infrastructure/sqlite";

export type ImageAsset = { id: string; label: string };
type ImageGrant = {
	revision: number;
	enabled: boolean;
	assets: ImageAsset[];
	connection: string;
};
export const imageGrantMigrations: readonly Migration[] = [
	{
		id: "prototype/0001-image-grants",
		after: ["image/0005-prototype-origin"],
		sql: `CREATE TABLE prototype_image_grants (
		project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, enabled INTEGER NOT NULL,
		assets_json TEXT NOT NULL, connection TEXT NOT NULL
	)`,
	},
];

export function imageGrantInTransaction(
	db: Database,
	project: string,
): ImageGrant {
	const row = db
		.query<
			{
				revision: number;
				enabled: number;
				assets_json: string;
				connection: string;
			},
			[string]
		>(
			"SELECT revision, enabled, assets_json, connection FROM prototype_image_grants WHERE project_id=?",
		)
		.get(project);
	return row
		? {
				...row,
				enabled: row.enabled === 1,
				assets: JSON.parse(row.assets_json),
			}
		: { revision: 0, enabled: false, assets: [], connection: "" };
}
export function setImageGrantInTransaction(
	db: Database,
	project: string,
	input: ImageGrant,
) {
	const before = imageGrantInTransaction(db, project);
	if (before.revision !== input.revision)
		throw new Error("prototype_grant_conflict");
	db.query(
		`INSERT INTO prototype_image_grants(project_id, revision, enabled, assets_json, connection)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET revision=excluded.revision,
		enabled=excluded.enabled, assets_json=excluded.assets_json, connection=excluded.connection`,
	).run(
		project,
		before.revision + 1,
		Number(input.enabled),
		JSON.stringify(input.assets),
		input.connection,
	);
	return imageGrantInTransaction(db, project);
}
