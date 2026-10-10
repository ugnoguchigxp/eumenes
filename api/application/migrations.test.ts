import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertMemorySchema,
	migrations as memoryPackageMigrations,
} from "eumenes-memory/sqlite";
import { openStore, orderMigrations } from "../infrastructure/sqlite";
import type { Migration } from "../infrastructure/sqlite";
import { createHash } from "node:crypto";
import { createConversationService } from "../domains/conversation";
import { hostMigrations, legacyOrder, migrations } from "./migrations";
import {
	migrations as worldPackageMigrations,
	readWorldSnapshot,
} from "eumenes-world-model/sqlite";

const sha256 = (sql: string) => createHash("sha256").update(sql).digest("hex");
const ids = (list: readonly Migration[]) => list.map((m) => m.id);
const indexOfId = (id: string) => migrations.findIndex((m) => m.id === id);
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/**
 * GOLDEN: the legacy positional order, frozen on 2026-10-10 from the code that built every
 * deployed database. Entry N is the id given to row N of the old `schema_migrations` table and
 * the SHA-256 of the SQL that row recorded. If this test fails, a deployed migration was
 * reordered or edited: revert the change, never update this table.
 */
const GOLDEN: readonly (readonly [string, string])[] = [
	[
		"conversation/0001-init",
		"e70d5ac260c9aa14468d1f929c4e344f28ce9967126c158dc31cfef2594fd3e0",
	],
	[
		"dialogue/0001-init",
		"491e8a609f0b20bf09c5102e289f341afea1f385da2401e61b7488cde54ac656",
	],
	[
		"voice-dialogue/0001-init",
		"a983fc05e2b835d1fe89ffded6a96c4a757ac5d867a1e7b00d18fb06f3973c2e",
	],
	[
		"queue/0001-init",
		"f6f01426e355bc6693c2c653cb0dbc4a1ba40330eb542ea503d9e185fe9ff7dd",
	],
	[
		"scheduler/0001-init",
		"5e889ed17bc9f62f5c31833015a621d54de9492cf9c369318c489843ad691e45",
	],
	[
		"dialogue/0002-queue-link",
		"4cee63e890d9a5a2eac7296196f446c551920d882f9a11a347fdf7e1fbe59142",
	],
	[
		"voice-dialogue/0002-sequence",
		"724c6f562a0ba781b649e88c83da6a6277682b5e4eb692f12f9e2a0442d1d47d",
	],
	[
		"continuity-legacy/0001-retired",
		"e004ebd5b5532a4b85984a62f8ad48a81aa3460c1ca07701f386135d72cdecf5",
	],
	[
		"settings/0001-init",
		"465a29f48bd76c06b16f812ecfb0e05028e284a2e3ec5d5356f94576e0f37814",
	],
	[
		"inference/0001-init",
		"761b68307e341c8b3e7ebb56b3b0196800745c44287437653f308929c3bf4312",
	],
	[
		"settings/0002-epochs",
		"88c8e0af7513fb82311d91ae55e456ad328cc663689a7a238d8297c92c461de7",
	],
	[
		"inference/0002-parents",
		"13be8a51c9611367c38d03851e274ebefccd5555b683dc562b327b79d38143c0",
	],
	[
		"inference/0003-diagnostics",
		"f2f3899431b29e770e845a30056b1281c8a6fd720a71f6eb3497aa79bf57a213",
	],
	[
		"tts-dictionary/0001-init",
		"4d264958a2853dc81635680b63e4235a98b3cec1be9626f592b7f979f7e3fd30",
	],
	[
		"conversation/0002-avatar-motion",
		"408459a2ecb26e914d0e0902b23921fe8c52cb18ed75a00604f6e657af144d74",
	],
	[
		"conversation/0003-answer-delivery",
		"190e83bed4068ee755578104b6a1212e8e0e1ffe41f6a5486845705c63c7d83c",
	],
	[
		"continuity/0001-init",
		"69e4088c9c74eacd8014ebe7ab43038461b776d87eb805396b0c93b28b65548d",
	],
	[
		"memory/0001-init",
		"d387b3b900b4638a05fb72f3504cf2c32b266a9b31ae55f007e6ff027890f1b1",
	],
	[
		"memory-package/0001",
		"b97c190b8f5a62057ca21ec241c10fd1ea71c03ad7044a247c8bfdea70e7ffba",
	],
	[
		"memory-package/0002",
		"24ce71705b8ae44b33e39874998a167091d27a00ddfacfcb4549fbf847d80d1a",
	],
	[
		"memory-package/0003",
		"07edacf77d2c82a8d644c1f4f08f114662cfd1dba575a1e5d696541df732d9d4",
	],
	[
		"memory-package/0004",
		"1567136edbc14b1c6f9fd4f0be280c6ff4a9cc9deb3a7a17eb438ed6e7f469dd",
	],
	[
		"service-tests/0001-init",
		"9a26e365a94afaee0d0b7d3285515178c6f8fe5512a56573ac59fe64c8cde6b4",
	],
	[
		"memory-package/0005",
		"71a6ad7ee8bbf814a5f64a2f0eede0313df01aa65cd602ed39bf7ceb83a3176e",
	],
	[
		"web-research/0001-init",
		"82bf894c464a4e1dc3dfa52bb53232d785ea71aa3ae0096b82f7a115d05d137d",
	],
	[
		"memory-package/0006",
		"895af28299939bde218e74b068ddb7decb2ad31cf79288de1903a3137e696b54",
	],
	[
		"capabilities/0001-init",
		"1fe743bc28f2511450d343c804c76c746b379c7bcd86004274c19429d030db97",
	],
	[
		"tool-runtime/0001-init",
		"3a5f04abed105969ae8eafaab700ec66fba16511f49255197429ed60152821e9",
	],
	[
		"agent-runtime/0001-init",
		"d54d51d8bc07ae06f71fde3a89b436af7009170896ef90e14d6efb5b4e9b041e",
	],
	[
		"inference/0004-control",
		"b876afdc59f97c81979ac1ff4f8fe9ee047e02444ef75269a6b96666f39b108f",
	],
	[
		"dialogue/0003-agent-link",
		"f5785259bd66f0faafb4ee0fe441711398dd275de6273d196ce13676732fcf64",
	],
	[
		"conversation/0004-outbox",
		"6a137bd2bb31c76eb37fef28595f78e11956b59facb1f06e7e97bc40ee328673",
	],
	[
		"goals/0001-init",
		"da4810bab771be47ff717d56398ec99f46507451f3b1c6b772633f5ee9f6ce91",
	],
	[
		"tasks/0001-init",
		"447625c35a171714b747b56daa3fdd20e8c64e0cc51f13775a1bab48db5b46cd",
	],
	[
		"conversation/0005-retraction",
		"e0c4a124711d2026effdbb91f3e7a75091384f9f5c2d840180c67cae5d5e128e",
	],
	[
		"goals/0002-operation",
		"ec05e8e080789723bfa348732c9098bbc98e783ebca5fb97c52b48e29902c622",
	],
	[
		"capabilities/0002-learned",
		"2ebba9ea798187ac73266a3b182619e092873a6c005e67a7f5a7dacefca2ab41",
	],
	[
		"agent-runtime/0002-acquisition",
		"a0a8d05442fde8ad332a70e661cd5d692d607b4e4ee513fd42cfbdd819bcf65d",
	],
	[
		"research-routes/0001-init",
		"60f19d31deed5de52b6e59b27aef9d3862814a0617d0c7f9cc793d9acf9d2157",
	],
	[
		"web-research/0002-attempt-timeout",
		"b9faf046c8a63ca16e7bad742f9b9bc21ba2e55e55f47d53f9f3666e78a8afa3",
	],
	[
		"tool-runtime/0002-route-grant",
		"b5347382551d7f80ca03aa0ebd8b655ee6dee418660b0185e6c06d57912b4824",
	],
	[
		"tool-runtime/0003-supersede",
		"b3fa5cb57f27e4cea5c9180705011d63504c43963a38fb2cdef23133955f0b61",
	],
	[
		"world-package/0001",
		"668433aeb797aa74a5c3e6c44237413cdb1a332514d85f2247ed6d48441fb39f",
	],
	[
		"world-package/0002",
		"257dcd5eab4aa557453332d71ad26796e35b8b289a169ec8b93fecc5623a006f",
	],
	[
		"world-package/0003",
		"98f8db52ba14634554e0ea850da4aae0bf0d5ee409a8ea7f844d37e777132b88",
	],
	[
		"world-package/0004",
		"2fa47699582bc0424ae229fb1837142d2254221bf38f111624925d235699ebf5",
	],
	[
		"world-package/0005",
		"8f68fd2f24fd3974c2e193df68b0b511abf7810cdab4726a5b35d5dbabf05743",
	],
	[
		"world-package/0006",
		"761a19eae53db0f79139218ac79881179bc8095381a4f029200c2375d817e201",
	],
	[
		"world-package/0007",
		"84e960166d7371f04dcead5231644734c2e18b1f3b497da1f581b065e6aad2cc",
	],
	[
		"world/0001-host-state",
		"ff122e35664b0575ef5c8824b41345bc30421949f4ec9ed87b5b22785974e058",
	],
	[
		"world/0002-lifecycle",
		"4f04a8034f1b7ded715f7e9dc1d005bfefbf5f6cdb98e781a9a8457364d99516",
	],
	[
		"world/0003-usage",
		"fd8d0a0df189df9a460492b6135aec3c3c4b23ebf1024e359d7648613bf7b788",
	],
	[
		"timers/0001-init",
		"c2a592c2a1aca132e151076e3a79b349c1733a7685ac9557445986c65d33303b",
	],
	[
		"agent-runtime/0003-action-result",
		"9bec998f070b3dce8469af6961fc9fca6822d0a685be3ec3c8b6a7cc8469709f",
	],
	[
		"tool-runtime/0004-action",
		"f9f17bc54f11ac5d90771bbb03271b27f4536e010df43ce4e9f2ee859c1da7c7",
	],
	[
		"coding/0001-init",
		"991cde3ec2ce284c5f9a0095aba6ebf440d86370b18418f9f6227de1a81d1772",
	],
	[
		"world/0004-guard",
		"a02750a30df35f7fb9eae8495dda32fa725a3dd282ffe88e84bb7c4a0a452068",
	],
	[
		"dialogue/0004-world-state",
		"4846a3d02fea1011da77e3000f1cc02182ee7584bc47dec2570deb3bb349be25",
	],
	[
		"inference/0005-background-control",
		"508e5a8382f765be310529c4d1cd3addcb47f1d03b63460cf4c808c61cfa40c2",
	],
	[
		"task-reports/0001-init",
		"4d7e2e314c20a420057f1e3b19839b033e5ffb772ac38cf448fa542dfb4f6f88",
	],
	[
		"coding-supervision/0001-init",
		"065ff6bf79915758ea981e36059a1c583353851033e10d38bc4028ba1292e9f2",
	],
	[
		"world/0005-extraction",
		"e6d078346266ba14c0a02938244eca7c85ccd5ef0962aa8cf7f15ff3c4ea708b",
	],
	[
		"world/0006-runtime",
		"b5d24d96580db2f6b253bd3b9ab2e76d4c186eb49b2d57b2d3bcc41e5b1378ef",
	],
	[
		"world/0007-gap-task",
		"8afcb0f0dedeb618b1291780982516dfb585cd4fbab464122636836b68c59c74",
	],
];

const legacyMigrations = migrations.filter((m) => legacyOrder.includes(m.id));
/** What the old implementation did: an INTEGER-keyed table, SQL applied by position. */
function buildPositionalDatabase(path: string, count = GOLDEN.length) {
	const db = new Database(path, { create: true });
	db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
	db.exec(
		"CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY)",
	);
	db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
	for (let i = 0; i < count; i++) {
		const sql = legacyMigrations[i]!.sql;
		db.transaction(() => {
			db.exec(sql);
			db.query(
				"INSERT INTO schema_migrations (id, checksum) VALUES (?, ?)",
			).run(i + 1, sha256(sql));
		})();
	}
	return db;
}
const schemaDump = (db: Database) =>
	db
		.query(
			"SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'schema_migrations%' AND name NOT LIKE 'sqlite_autoindex_schema_migrations%' ORDER BY type, name",
		)
		.all();
const appliedRows = (db: Database) =>
	db
		.query("SELECT id, checksum FROM schema_migrations_v2 ORDER BY id")
		.all() as { id: string; checksum: string }[];

test("GOLDEN: the legacy order and every deployed SQL string are byte-for-byte unchanged", () => {
	expect(legacyOrder).toEqual(GOLDEN.map(([id]) => id));
	expect(legacyMigrations).toHaveLength(GOLDEN.length);
	expect(ids(migrations).slice(0, GOLDEN.length)).toEqual([...legacyOrder]);
	for (const [i, [id, checksum]] of GOLDEN.entries()) {
		expect(migrations[i]?.id).toBe(id);
		expect(sha256(migrations[i]!.sql)).toBe(checksum);
	}
	expect(new Set(legacyOrder).size).toBe(legacyOrder.length);
});

test("a database built by the old positional scheme opens, is moved to schema_migrations_v2, and applies nothing", async () => {
	const dir = tmp("eumenes-positional-");
	try {
		const path = join(dir, "db.sqlite3");
		const old = buildPositionalDatabase(path);
		const dump = schemaDump(old);
		const version = (
			old.query("PRAGMA schema_version").get() as { schema_version: number }
		).schema_version;
		const legacyRows = old
			.query("SELECT id, checksum FROM schema_migrations ORDER BY id")
			.all() as { id: number; checksum: string }[];
		old.close();
		const store = openStore(path, legacyMigrations, { legacyOrder });
		try {
			expect(store.read(appliedRows)).toEqual(
				legacyRows
					.map((row) => ({
						id: legacyOrder[row.id - 1]!,
						checksum: row.checksum,
					}))
					.sort((a, b) => (a.id < b.id ? -1 : 1)),
			);
			// No migration SQL ran: the only DDL is the new bookkeeping table.
			expect(store.read(schemaDump)).toEqual(dump);
			expect(
				store.read(
					(db) =>
						(
							db.query("PRAGMA schema_version").get() as {
								schema_version: number;
							}
						).schema_version,
				),
			).toBe(version + 1);
			// The old table stays for rollback, untouched.
			expect(
				store.read(
					(db) =>
						(
							db.query("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
								n: number;
							}
						).n,
				),
			).toBe(legacyOrder.length);
		} finally {
			await store.close();
		}
		// Reopening is a no-op again.
		const again = openStore(path, legacyMigrations, { legacyOrder });
		expect(again.read(appliedRows)).toHaveLength(legacyOrder.length);
		await again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a partly migrated positional database applies only the missing migrations, in the legacy order", async () => {
	const dir = tmp("eumenes-positional-partial-");
	try {
		const path = join(dir, "db.sqlite3");
		buildPositionalDatabase(path, 30).close();
		const store = openStore(path, legacyMigrations, { legacyOrder });
		const upgraded = store.read(schemaDump);
		expect(store.read(appliedRows).map((r) => r.id)).toEqual(
			[...legacyOrder].sort(),
		);
		await store.close();
		const fresh = openStore(join(dir, "fresh.sqlite3"), legacyMigrations);
		expect(fresh.read(schemaDump)).toEqual(upgraded);
		await fresh.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a positional database with a row beyond the frozen order, or a pre-checksum row, is handled", async () => {
	const dir = tmp("eumenes-positional-edge-");
	try {
		const ahead = join(dir, "ahead.sqlite3");
		const db = buildPositionalDatabase(ahead);
		db.query(
			"INSERT INTO schema_migrations (id, checksum) VALUES (65, 'x')",
		).run();
		db.close();
		expect(() => openStore(ahead, legacyMigrations, { legacyOrder })).toThrow(
			"migration_unknown_applied:legacy/65",
		);
		const noChecksum = join(dir, "no-checksum.sqlite3");
		const old = buildPositionalDatabase(noChecksum);
		old.exec("UPDATE schema_migrations SET checksum = NULL");
		old.close();
		const store = openStore(noChecksum, legacyMigrations, { legacyOrder });
		// Rows from before checksums trust the current definition once.
		expect(store.read(appliedRows).map((r) => r.checksum)).toEqual(
			GOLDEN.map(([id, checksum]) => [id, checksum] as const)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([, checksum]) => checksum),
		);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a database that holds a migration this code does not know refuses to start", async () => {
	const dir = tmp("eumenes-unknown-");
	try {
		const path = join(dir, "db.sqlite3");
		await openStore(path, migrations).close();
		const known = migrations.slice(0, -1);
		let error: unknown;
		try {
			openStore(path, known);
		} catch (e) {
			error = e;
		}
		expect((error as Error).message).toBe(
			`migration_unknown_applied:${migrations.at(-1)!.id}`,
		);
		expect(JSON.stringify(error)).not.toContain("CREATE TABLE");
		// Nothing was applied or removed by the refused start.
		const again = openStore(path, migrations);
		expect(again.read(appliedRows)).toHaveLength(migrations.length);
		await again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a migration with `after` is applied after its dependencies, wherever it sits in the list", async () => {
	const dir = tmp("eumenes-after-");
	try {
		const path = join(dir, "db.sqlite3");
		const trace = (id: string): Migration["sql"] =>
			`INSERT INTO trace (name) VALUES ('${id}')`;
		const base: Migration[] = [
			{
				id: "t/0001",
				sql: "CREATE TABLE trace (seq INTEGER PRIMARY KEY, name TEXT)",
				after: [],
			},
			{ id: "t/0002", sql: trace("t/0002"), after: ["t/0001"] },
		];
		const first = openStore(path, base);
		await first.close();
		// Listed first, but it must wait for t/0003, which must wait for t/0002.
		const extended: Migration[] = [
			{ id: "t/0004", sql: trace("t/0004"), after: ["t/0003"] },
			...base,
			{ id: "t/0003", sql: trace("t/0003"), after: ["t/0002"] },
		];
		expect(ids(orderMigrations(extended))).toEqual([
			"t/0001",
			"t/0002",
			"t/0003",
			"t/0004",
		]);
		const store = openStore(path, extended);
		expect(
			store.read((db) =>
				(
					db.query("SELECT name FROM trace ORDER BY seq").all() as {
						name: string;
					}[]
				).map((r) => r.name),
			),
		).toEqual(["t/0002", "t/0003", "t/0004"]);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("migration ordering is stable and rejects cycles, unknown dependencies and duplicate ids", () => {
	const m = (id: string, after?: string[]): Migration => ({
		id,
		sql: `SELECT '${id}'`,
		...(after ? { after } : {}),
	});
	// Without `after`, the list order is the dependency order.
	expect(ids(orderMigrations([m("a/1"), m("a/2"), m("a/3")]))).toEqual([
		"a/1",
		"a/2",
		"a/3",
	]);
	// Independent migrations keep their listed order.
	expect(
		ids(orderMigrations([m("a/1", []), m("b/1", []), m("c/1", ["a/1"])])),
	).toEqual(["a/1", "b/1", "c/1"]);
	expect(() => orderMigrations([m("a/1", ["a/2"]), m("a/2", ["a/1"])])).toThrow(
		"migration_cycle:a/1",
	);
	expect(() => orderMigrations([m("a/1", ["zzz"])])).toThrow(
		"migration_after_unknown:a/1",
	);
	expect(() => orderMigrations([m("a/1"), m("a/1")])).toThrow(
		"migration_duplicate_id:a/1",
	);
});

test("the memory package's migrations keep their order and every one is applied; the first four stay contiguous", () => {
	expect(memoryPackageMigrations.length).toBeGreaterThan(0);
	const packaged = migrations.filter((m) => m.id.startsWith("memory-package/"));
	expect(packaged.map((m) => m.sql)).toEqual([...memoryPackageMigrations]);
	// In order as a subsequence (a host migration may sit between package migrations only
	// where it already did when those package migrations were first deployed).
	let cursor = 0;
	for (const [i, sql] of memoryPackageMigrations.entries()) {
		const id = `memory-package/${String(i + 1).padStart(4, "0")}`;
		const at = indexOfId(id);
		expect(at).toBeGreaterThanOrEqual(cursor);
		expect(migrations[at]?.sql).toBe(sql);
		cursor = at + 1;
	}
	// The original block: the first four package migrations follow the host block directly.
	expect(
		ids(migrations.slice(hostMigrations.length, hostMigrations.length + 4)),
	).toEqual(["0001", "0002", "0003", "0004"].map((n) => `memory-package/${n}`));
	expect(migrations[hostMigrations.length + 4]?.id).toBe(
		"service-tests/0001-init",
	);
	expect(ids(migrations.slice(0, hostMigrations.length))).toEqual(
		ids(hostMigrations),
	);
});

test("host migrations are frozen: the count and the retired slot never move", () => {
	expect(hostMigrations).toHaveLength(18);
	expect(hostMigrations[7]).toEqual({
		id: "continuity-legacy/0001-retired",
		sql: "SELECT 1",
		after: ["voice-dialogue/0002-sequence"],
	});
});

test("every migration is named once, and none outside the frozen order exists yet without `after`", () => {
	expect(new Set(ids(migrations)).size).toBe(migrations.length);
	for (const m of migrations)
		expect(m.id).toMatch(/^[a-z-]+\/\d{4}(-[a-z-]+)?$/);
	for (const m of migrations.filter((x) => !legacyOrder.includes(x.id)))
		expect(m.after?.length).toBeGreaterThan(0);
});

test("a fresh database gets every migration and passes the memory schema check", async () => {
	const dir = tmp("eumenes-migrations-");
	try {
		const store = openStore(join(dir, "db.sqlite3"), migrations);
		store.read((db) => assertMemorySchema(db));
		expect(store.read(appliedRows).map((r) => r.id)).toEqual(
			ids(migrations).sort(),
		);
		// A fresh database never creates the old positional table.
		expect(
			store.read((db) =>
				db
					.query(
						"SELECT name FROM sqlite_master WHERE name='schema_migrations'",
					)
					.all(),
			),
		).toEqual([]);
		await store.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an applied migration that is rewritten later stops startup with its id only", async () => {
	const dir = tmp("eumenes-checksum-");
	try {
		const path = join(dir, "db.sqlite3");
		const original = [
			"CREATE TABLE a (x INTEGER)",
			"CREATE TABLE b (y INTEGER)",
		];
		const store = openStore(path, original);
		await store.close();
		const rewritten = [original[0]!, "CREATE TABLE b (y INTEGER, z TEXT)"];
		let error: unknown;
		try {
			openStore(path, rewritten);
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"migration_checksum_mismatch:adhoc/0002",
		);
		expect((error as { migrationId: string }).migrationId).toBe("adhoc/0002");
		expect(JSON.stringify(error)).not.toContain("CREATE TABLE");
		// The unchanged list still opens.
		const again = openStore(path, original);
		await again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a database from before checksums is backfilled once and then verified", async () => {
	const dir = tmp("eumenes-checksum-legacy-");
	try {
		const path = join(dir, "db.sqlite3");
		const list = ["CREATE TABLE a (x INTEGER)", "CREATE TABLE b (y INTEGER)"];
		const legacy = new Database(path, { create: true });
		legacy.exec(
			"CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY); INSERT INTO schema_migrations (id) VALUES (1),(2);" +
				list.join(";"),
		);
		legacy.close();
		const store = openStore(path, list);
		const rows = store.read(appliedRows);
		expect(rows.map((r) => r.id)).toEqual(["adhoc/0001", "adhoc/0002"]);
		expect(rows.map((r) => r.checksum)).toEqual(list.map(sha256));
		await store.close();
		expect(() =>
			openStore(path, [list[0]!, "CREATE TABLE b (y TEXT)"]),
		).toThrow("migration_checksum_mismatch");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an existing 0.3.3 host database upgrades without rewriting migration checksums or losing data", async () => {
	const dir = tmp("eumenes-web-upgrade-");
	try {
		const path = join(dir, "db.sqlite3");
		const previous = migrations.slice(
			0,
			indexOfId("service-tests/0001-init") + 1,
		);
		expect(previous).toHaveLength(23);
		const before = openStore(path, previous);
		await createConversationService(before).append({
			id: "fixture-message",
			conversationId: "fixture-conversation",
			role: "user",
			text: "preserved across upgrade",
			createdAt: "2026-10-09T00:00:00.000Z",
			runId: null,
		});
		const checksums = before.read(appliedRows);
		await before.close();
		const after = openStore(path, migrations);
		try {
			after.read((db) => assertMemorySchema(db));
			expect(
				createConversationService(after).get("fixture-conversation").messages[0]
					?.text,
			).toBe("preserved across upgrade");
			expect(
				after
					.read(appliedRows)
					.filter((r) => checksums.some((c) => c.id === r.id)),
			).toEqual(checksums);
			expect(
				after.read((db) =>
					db
						.query(
							"SELECT name FROM sqlite_master WHERE name IN ('memory_record_retention','web_research_runs') ORDER BY name",
						)
						.all(),
				),
			).toHaveLength(2);
		} finally {
			await after.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const seedRun = (db: Database, messageId: string, answerId: string | null) =>
	db
		.query(
			"INSERT INTO dialogue_runs (id,request_id,conversation_id,status,revision,input_message_id,answer_message_id,created_at,updated_at) VALUES ('run-1','req-1','fixture-conversation','completed',1,?,?,'2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z')",
		)
		.run(messageId, answerId);
const fixtureMessage = (
	id: string,
	role: "user" | "assistant",
	text: string,
) => ({
	id,
	conversationId: "fixture-conversation",
	role,
	text,
	createdAt: "2026-10-09T00:00:00.000Z",
	runId: null,
});
const outboxDump = (db: Database) =>
	JSON.stringify(db.query("SELECT * FROM conversation_outbox").all());

test("World source/goal migrations are appended last and upgrade an already-deployed database", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-upgrade-"));
	try {
		const path = join(dir, "db.sqlite3");
		// Everything deployed before the World migrations were appended.
		const deployed = migrations.slice(0, indexOfId("conversation/0004-outbox"));
		expect(deployed.length).toBeGreaterThan(0);
		// Retraction and goal-operation columns come after everything deployed.
		expect(indexOfId("conversation/0005-retraction")).toBeGreaterThan(
			indexOfId("conversation/0004-outbox"),
		);
		const before = openStore(path, deployed);
		await createConversationService(before).append(
			fixtureMessage("pre-1", "user", "kept across upgrade"),
		);
		await createConversationService(before).append(
			fixtureMessage("pre-2", "assistant", "answer kept"),
		);
		await before.write((db) => seedRun(db, "pre-1", "pre-2"));
		await before.close();
		const store = openStore(path, migrations);
		try {
			const tables = store.read((db) =>
				(
					db
						.query(
							"SELECT name FROM sqlite_master WHERE name IN ('conversation_outbox','goals_ledger')",
						)
						.all() as { name: string }[]
				).map((row) => row.name),
			);
			expect(tables.sort()).toEqual(["conversation_outbox", "goals_ledger"]);
			const service = createConversationService(store, {
				requireOutbox: true,
			});
			// Data intact after the upgrade.
			expect(
				service.get("fixture-conversation").messages.map((m) => m.text),
			).toEqual(["kept across upgrade", "answer kept"]);
			expect(
				store.read((db) =>
					db
						.query(
							"SELECT input_message_id, answer_message_id FROM dialogue_runs",
						)
						.all(),
				),
			).toEqual([{ input_message_id: "pre-1", answer_message_id: "pre-2" }]);
			// Correct and retract work on a message that predates the outbox.
			expect(
				await service.correct({ messageId: "pre-1", text: "corrected" }),
			).toMatchObject({ status: "applied", kind: "corrected" });
			expect(service.get("fixture-conversation").messages[0]?.text).toBe(
				"corrected",
			);
			expect(await service.retract({ messageId: "pre-1" })).toMatchObject({
				status: "applied",
				kind: "retracted",
			});
			expect(
				service.get("fixture-conversation").messages.map((m) => m.id),
			).toEqual(["pre-2"]);
			expect(
				store.read((db) =>
					db.query("SELECT input_message_id FROM dialogue_runs").all(),
				),
			).toEqual([{ input_message_id: "pre-1" }]);
		} finally {
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("with the full production migrations, retracting a message referenced by a dialogue run tombstones it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-retract-prod-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), migrations);
		try {
			const service = createConversationService(store, {
				requireOutbox: true,
			});
			await service.append(fixtureMessage("in-1", "user", "secret input"));
			await service.append(
				fixtureMessage("out-1", "assistant", "secret answer"),
			);
			await store.write((db) => seedRun(db, "in-1", "out-1"));
			expect(store.read((db) => db.query("PRAGMA foreign_keys").get())).toEqual(
				{ foreign_keys: 1 },
			);
			// The scrubbed digests: a correction first, then the retraction.
			await service.correct({ messageId: "in-1", text: "secret input v2" });
			const result = await service.retract({ messageId: "in-1" });
			expect(result).toMatchObject({ status: "applied", kind: "retracted" });
			// The dialogue run is intact and still points at the tombstoned row.
			expect(
				store.read((db) =>
					db
						.query(
							"SELECT input_message_id, answer_message_id, status FROM dialogue_runs",
						)
						.all(),
				),
			).toEqual([
				{
					input_message_id: "in-1",
					answer_message_id: "out-1",
					status: "completed",
				},
			]);
			// Invisible to every conversation read (and so to memory/dialogue).
			expect(
				service.get("fixture-conversation").messages.map((m) => m.id),
			).toEqual(["out-1"]);
			expect(
				store.read((db) => service.messageInTransaction(db, "in-1")),
			).toBeNull();
			expect(
				store
					.read((db) =>
						service.messagesInTransaction(db, "fixture-conversation"),
					)
					.map((m) => m.id),
			).toEqual(["out-1"]);
			expect(
				store.read((db) => service.sourceInTransaction(db, "in-1")),
			).toMatchObject({ state: "retracted" });
			expect(
				store.read((db) => service.sourceInTransaction(db, "out-1")),
			).toMatchObject({ state: "available" });
			// The stored text is blanked in place.
			expect(
				store.read((db) =>
					db
						.query("SELECT text, retracted_at FROM messages WHERE id='in-1'")
						.get(),
				),
			).toMatchObject({ text: "" });
			// Outbox: retraction recorded, no digest or text of the removed message left.
			const events = store.read((db) =>
				service.changesInTransaction(db, 0, 100),
			);
			expect(
				events.filter((e) => e.sourceId === "in-1").map((e) => e.kind),
			).toEqual(["added", "corrected", "retracted"]);
			const dump = store.read(outboxDump);
			for (const text of ["secret input", "secret input v2"])
				expect(dump).not.toContain(
					createHash("sha256").update(text).digest("hex"),
				);
			expect(dump).not.toContain("secret");
			// A retracted id never comes back or gets corrected.
			await expect(
				service.append(fixtureMessage("in-1", "user", "again")),
			).rejects.toThrow("message_retracted");
			expect(await service.correct({ messageId: "in-1", text: "x" })).toEqual({
				status: "retracted",
			});
		} finally {
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---- World package + host state (P3-06) ----

/** Everything deployed before the World package migrations were appended. */
const beforeWorld = () => migrations.slice(0, indexOfId("world-package/0001"));
const worldProbe = (store: ReturnType<typeof openStore>) =>
	store.readSnapshot((db) => readWorldSnapshot(db, {}));

test("World's package migrations stay contiguous, and timers is appended after them", () => {
	expect(worldPackageMigrations.length).toBeGreaterThan(0);
	const worldStart = indexOfId("world-package/0001");
	const packageIds = worldPackageMigrations.map(
		(_, i) => `world-package/${String(i + 1).padStart(4, "0")}`,
	);
	expect(
		migrations
			.slice(worldStart, worldStart + packageIds.length)
			.map((m) => m.sql),
	).toEqual([...worldPackageMigrations]);
	expect(
		ids(migrations.slice(worldStart, worldStart + packageIds.length + 3)),
	).toEqual([
		...packageIds,
		"world/0001-host-state",
		"world/0002-lifecycle",
		"world/0003-usage",
	]);
	const after = ids(migrations.slice(worldStart + packageIds.length + 3));
	// Timers, the agent/tool action tables and coding follow, then World hardening, the answer
	// release, and (in order) the very tail.
	expect(after.slice(0, 6)).toEqual([
		"timers/0001-init",
		"agent-runtime/0003-action-result",
		"tool-runtime/0004-action",
		"coding/0001-init",
		"world/0004-guard",
		"dialogue/0004-world-state",
	]);
	expect(indexOfId("world/0005-extraction")).toBeGreaterThan(
		indexOfId("dialogue/0004-world-state"),
	);
	expect(indexOfId("world/0006-runtime")).toBe(
		indexOfId("world/0005-extraction") + 1,
	);
	expect(indexOfId("world/0007-gap-task")).toBe(
		indexOfId("world/0006-runtime") + 1,
	);
	expect(legacyMigrations.at(-1)?.id).toBe("world/0007-gap-task");
	// Nothing that was already deployed moved: the prefix is unchanged and contiguous.
	expect(beforeWorld().length).toBe(worldStart);
	expect(ids(beforeWorld())).toContain("conversation/0005-retraction");
	// The retired slot and the host block stay where they were.
	expect(ids(migrations.slice(0, hostMigrations.length))).toEqual(
		ids(hostMigrations),
	);
});

test("a fresh database gets the World schema; World is OFF and its schema is current", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-fresh-"));
	try {
		const store = openStore(join(dir, "db.sqlite3"), migrations);
		try {
			const names = store.read((db) =>
				(
					db
						.query(
							"SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'world\\_%' ESCAPE '\\') ORDER BY name",
						)
						.all() as { name: string }[]
				).map((row) => row.name),
			);
			expect(names).toEqual(
				expect.arrayContaining([
					"world_schema_info",
					"world_assertion",
					"world_host_state",
					"world_host_forget_epoch",
					"world_host_feed_cursor",
					"world_host_forget_intake",
					"world_host_forget_confirmation",
					"world_host_dependent",
					"world_host_restore",
					"world_host_usage",
					"world_host_forget_abandoned",
				]),
			);
			expect(
				store.read((db) =>
					db.query("SELECT enabled, restore_epoch FROM world_host_state").all(),
				),
			).toEqual([{ enabled: 0, restore_epoch: "restore-0" }]);
			// World stays OFF and cannot be switched ON before the host's initial sync.
			expect(
				store.read((db) =>
					db
						.query("SELECT initial_sync_complete AS n FROM world_host_state")
						.get(),
				),
			).toEqual({ n: 0 });
			// Current schema: an empty request reaches World's own parser and is rejected there.
			expect(worldProbe(store)).toMatchObject({
				status: "rejected",
				reasonCode: "INVALID_INPUT",
			});
		} finally {
			await store.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an already-deployed database (data present, no World yet) upgrades and keeps its data", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-existing-"));
	try {
		const path = join(dir, "db.sqlite3");
		const previous = beforeWorld();
		expect(previous.length).toBeGreaterThan(0);
		const before = openStore(path, previous);
		const service = createConversationService(before, { requireOutbox: true });
		await service.append(
			fixtureMessage("keep-1", "user", "kept across World upgrade"),
		);
		await service.append(fixtureMessage("keep-2", "assistant", "answer kept"));
		await before.write((db) => seedRun(db, "keep-1", "keep-2"));
		const checksums = before.read(appliedRows);
		await before.close();
		const after = openStore(path, migrations);
		try {
			// Earlier migration records are untouched; World's are appended.
			expect(
				after
					.read(appliedRows)
					.filter((r) => checksums.some((c) => c.id === r.id)),
			).toEqual(checksums);
			expect(after.read(appliedRows)).toHaveLength(migrations.length);
			const reread = createConversationService(after, { requireOutbox: true });
			expect(
				reread.get("fixture-conversation").messages.map((m) => m.text),
			).toEqual(["kept across World upgrade", "answer kept"]);
			expect(
				after.read((db) =>
					db
						.query(
							"SELECT input_message_id, answer_message_id FROM dialogue_runs",
						)
						.all(),
				),
			).toEqual([{ input_message_id: "keep-1", answer_message_id: "keep-2" }]);
			expect(worldProbe(after)).toMatchObject({ status: "rejected" });
			expect(
				after.read((db) =>
					db.query("SELECT enabled FROM world_host_state WHERE id = 1").get(),
				),
			).toEqual({ enabled: 0 });
		} finally {
			await after.close();
		}
		// Reopening is idempotent: nothing is re-applied.
		const again = openStore(path, migrations);
		await again.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a drifted World schema disables World; an edited World migration stops startup", async () => {
	const dir = mkdtempSync(join(tmpdir(), "eumenes-world-drift-"));
	try {
		const path = join(dir, "db.sqlite3");
		const store = openStore(path, migrations);
		await store.write((db) => {
			db.query("UPDATE world_schema_info SET sha256 = ? WHERE ordinal = 1").run(
				"f".repeat(64),
			);
		});
		// World refuses (blocked, no World table touched); the host keeps running.
		expect(worldProbe(store)).toEqual({
			status: "blocked",
			reasonCode: "SCHEMA_INCOMPATIBLE",
		});
		await createConversationService(store).append(
			fixtureMessage("alive", "user", "host still works"),
		);
		await store.close();
		// The host's own checksum guard: an edited World migration is refused at open.
		const target = "world-package/0002";
		const edited = migrations.map((m) =>
			m.id === target ? { ...m, sql: `${m.sql}\n-- edited` } : m,
		);
		let error: unknown;
		try {
			openStore(path, edited);
		} catch (e) {
			error = e;
		}
		expect((error as Error).message).toBe(
			`migration_checksum_mismatch:${target}`,
		);
		expect((error as { migrationId: string }).migrationId).toBe(target);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("research/history metadata migrations append after the frozen legacy order and upgrade without copying message bodies", async () => {
	const dir = tmp("eumenes-read-metadata-upgrade-");
	try {
		const path = join(dir, "db");
		buildPositionalDatabase(path).close();
		const store = openStore(path, migrations, { legacyOrder });
		expect(store.read(appliedRows)).toHaveLength(migrations.length);
		for (const [id, checksum] of GOLDEN)
			expect(store.read(appliedRows).find((r) => r.id === id)?.checksum).toBe(
				checksum,
			);
		expect(
			store
				.read((db) => db.query("PRAGMA table_info(tool_views)").all())
				.map((r: any) => r.name),
		).toEqual(["view_id", "invocation_id", "metadata_json"]);
		expect(
			store
				.read((db) => db.query("PRAGMA table_info(agent_tasks)").all())
				.some((r: any) => r.name === "exploration_json"),
		).toBe(true);
		await store.close();
		const reopened = openStore(path, migrations, { legacyOrder });
		expect(reopened.read(appliedRows)).toHaveLength(migrations.length);
		await reopened.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
