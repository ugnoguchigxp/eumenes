import { expect, test } from "bun:test";
import {
	findViolations,
	migrationOwner,
	newViolations,
	referencedTables,
	sourceOwners,
	tableOwners,
} from "./sql-boundaries";

const owners = tableOwners([
	{
		id: "queue/0001-init",
		sql: "CREATE TABLE IF NOT EXISTS queue_jobs (id TEXT); CREATE VIRTUAL TABLE queue_fts USING fts5(x)",
	},
	{ id: "memory-package/0001", sql: 'CREATE TABLE "memory_items" (id TEXT)' },
	{ id: "queue/0002-x", sql: "ALTER TABLE queue_jobs ADD COLUMN y TEXT" },
]);

test("derives table owners from CREATE TABLE, mapping packages to their domain", () => {
	expect(owners.get("queue_jobs")).toBe("queue");
	expect(owners.get("queue_fts")).toBe("queue");
	expect(owners.get("memory_items")).toBe("memory");
	expect(migrationOwner("world-package/0003")).toBe("world");
	expect(migrationOwner("coding/0001-init")).toBe("coding");
});

test("extracts tables across keywords and whitespace", () => {
	expect(
		referencedTables(
			"SELECT a FROM x JOIN y ON 1 WHERE 1;\nDELETE\nFROM z; INSERT OR IGNORE INTO w (a) VALUES (1); UPDATE v SET a=1",
		),
	).toEqual(["x", "y", "z", "w", "v"]);
	expect(referencedTables("update the thing from here")).toEqual([]);
});

const sources: Record<string, string> = {
	"api/domains/queue/repository/index.ts":
		'export const a = "SELECT 1 FROM queue_jobs";',
	"api/domains/tasks/repository/index.ts": [
		"// FROM queue_jobs in a comment is ignored",
		"export const a = `UPDATE queue_jobs SET x=${1}`;",
		'export const b = "SELECT * FROM tasks JOIN queue_jobs ON 1";',
		'export const c = "SELECT * FROM queue_jobs";',
	].join("\n"),
	"api/domains/web/repository/index.ts":
		'db.run("CREATE TABLE IF NOT EXISTS web_cache (id)"); db.query("SELECT 1 FROM web_cache");',
};
const files: Array<[string, string]> = Object.keys(sources).map((p) => [
	p.split("/")[2] as string,
	p,
]);
const read = (p: string) => sources[p] as string;

test("reports each foreign table access once per domain", () => {
	const all = sourceOwners(owners, files, read);
	expect(all.get("web_cache")).toBe("web");
	expect(findViolations(all, files, read)).toEqual([
		{ domain: "tasks", table: "queue_jobs" },
	]);
});

test("only accesses missing from the allow list fail", () => {
	const violations = [
		{ domain: "tasks", table: "queue_jobs" },
		{ domain: "goals", table: "queue_jobs" },
	];
	expect(newViolations(violations, [], owners)).toHaveLength(2);
	const errors = newViolations(
		violations,
		[{ domain: "tasks", table: "queue_jobs" }],
		owners,
	);
	expect(errors).toHaveLength(1);
	expect(errors[0]).toContain("goals accesses table queue_jobs owned by queue");
});
