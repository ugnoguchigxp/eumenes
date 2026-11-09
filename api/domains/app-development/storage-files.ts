import { Database } from "bun:sqlite";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { openStore } from "../../infrastructure/sqlite";
import {
	type RecordRequest,
	type StorageCollection,
	type StoragePage,
	type StoragePlan,
	type StorageRecord,
} from "./storage-contract";

const migration = {
	id: "app-records/0001-init",
	sql: `CREATE TABLE storage_version (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
CREATE TABLE storage_receipts (operation_id TEXT PRIMARY KEY, digest TEXT NOT NULL, result_json TEXT NOT NULL);`,
};
const columnName = (name: string) => `"c_${name}"`;
const tableName = (name: string) => `"rows_${name}"`;
const sqlType = {
	string: "TEXT",
	integer: "INTEGER",
	number: "REAL",
	boolean: "INTEGER",
	array: "TEXT",
	object: "TEXT",
} as const;
const pageSize = 25;
const maxRows = 10_000;
const managedFiles = [
	"app.sqlite",
	"app.sqlite-wal",
	"app.sqlite-shm",
	"app.sqlite-journal",
	"app.sqlite.owner.lock",
];
const inspect = (path: string) => lstatSync(path, { throwIfNoEntry: false });
const assertDirectory = (path: string) => {
	const stat = inspect(path);
	if (stat && !stat.isDirectory()) throw new Error("app_storage_path_invalid");
	return !!stat;
};
const assertRegular = (path: string) => {
	const stat = inspect(path);
	if (stat && (!stat.isFile() || stat.nlink !== 1))
		throw new Error("app_storage_path_invalid");
	return !!stat;
};
function assertTree(path: string) {
	for (const name of readdirSync(path)) {
		const child = join(path, name);
		if (inspect(child)?.isDirectory()) assertTree(child);
		else assertRegular(child);
	}
}
function version(db: Database) {
	return (
		db
			.query<{ revision: number }, []>(
				"SELECT revision FROM storage_version WHERE id=1",
			)
			.get()?.revision ?? 0
	);
}
function applyPlan(db: Database, plan: StoragePlan) {
	for (const collection of plan.collections) {
		const table = tableName(collection.id);
		const definitions = collection.columns.map(
			({ name, type, required }) =>
				`${columnName(name)} ${sqlType[type]}${required ? " NOT NULL" : ""}`,
		);
		db.run(
			`CREATE TABLE IF NOT EXISTS ${table} (record_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ${definitions.join(", ")}) STRICT`,
		);
		const existing = new Set(
			db
				.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
				.all()
				.map(({ name }) => name),
		);
		for (const [index, { name }] of collection.columns.entries()) {
			if (!existing.has(`c_${name}`))
				db.run(`ALTER TABLE ${table} ADD COLUMN ${definitions[index]}`);
		}
	}
}

type SQLValue = string | number | null;
type Row = Record<string, SQLValue> & {
	record_id: string;
	revision: number;
	created_at: number;
	updated_at: number;
};

function storageRecord(collection: StorageCollection, row: Row): StorageRecord {
	return {
		id: row.record_id,
		revision: row.revision,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		values: Object.fromEntries(
			collection.columns.flatMap(({ name, type }) => {
				const value = row[`c_${name}`];
				if (value === null || value === undefined) return [];
				return [
					[
						name,
						type === "boolean"
							? value === 1
							: type === "array" || type === "object"
								? JSON.parse(String(value))
								: value,
					],
				];
			}),
		),
	};
}

export function createAppStorageFiles(
	root: string,
	compile: (schema: Record<string, unknown>) => z.ZodType,
	now = Date.now,
) {
	const configured = resolve(root);
	const managedRoot = join(
		realpathSync(dirname(configured)),
		basename(configured),
	);
	function directory(id: string, create = false) {
		const path = join(managedRoot, z.uuid().parse(id));
		const rootExists = assertDirectory(managedRoot);
		if (create && !rootExists) mkdirSync(managedRoot, { mode: 0o700 });
		if (!rootExists && !create) return null;
		const present = assertDirectory(path);
		if (create && !present) mkdirSync(path, { mode: 0o700 });
		return present || create ? path : null;
	}
	function file(id: string, create = false) {
		const dir = directory(id, create);
		if (!dir) throw new Error("app_storage_file_missing");
		for (const name of managedFiles) assertRegular(join(dir, name));
		return join(dir, "app.sqlite");
	}
	return {
		async initialize(
			id: string,
			previous: number,
			revision: number,
			plan: StoragePlan,
		) {
			const filename = file(id, previous === 0);
			if (previous !== 0 && !assertRegular(filename))
				throw new Error("app_storage_file_missing");
			const store = openStore(filename, [migration]);
			try {
				await store.write((db) => {
					const current = version(db);
					if (current === revision) return;
					if (current !== previous)
						throw new Error("app_storage_revision_conflict");
					applyPlan(db, plan);
					db.run(
						"INSERT INTO storage_version VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
						[revision],
					);
				});
				if (store.read(version) !== revision)
					throw new Error("app_storage_revision_conflict");
				chmodSync(filename, 0o600);
			} finally {
				await store.close();
			}
		},
		remove(id: string) {
			const dir = directory(id);
			if (!dir) return;
			assertTree(dir);
			rmSync(dir, { recursive: true });
			if (inspect(dir)) throw new Error("app_storage_delete_incomplete");
		},
		records(
			id: string,
			revision: number,
			collection: StorageCollection,
			request: RecordRequest,
			operationId: string,
			digest: string,
		) {
			if (!collection.operations.includes(request.operation))
				throw new Error("app_storage_operation_forbidden");
			const filename = file(id);
			if (!assertRegular(filename)) throw new Error("app_storage_file_missing");
			const readOnly =
				request.operation === "list" || request.operation === "get";
			const db = new Database(filename, { create: false, readonly: readOnly });
			try {
				if (version(db) !== revision)
					throw new Error("app_storage_revision_conflict");
				const table = tableName(collection.id);
				const get = (recordId: string) => {
					const row = db
						.query<Row, [string]>(`SELECT * FROM ${table} WHERE record_id=?`)
						.get(recordId);
					if (!row) throw new Error("app_storage_record_not_found");
					return storageRecord(collection, row);
				};
				if (request.operation === "get") return get(request.id);
				if (request.operation === "list") {
					const { sort, search, page = 0 } = request;
					if (
						(sort && !collection.columns.some(({ name }) => name === sort)) ||
						(search &&
							!collection.columns.some(
								({ name, type }) => name === search.field && type === "string",
							))
					)
						throw new Error("app_storage_field_invalid");
					const where = search
						? ` WHERE instr(${columnName(search.field)},?) > 0`
						: "";
					const order = sort
						? `${columnName(sort)},record_id`
						: "created_at DESC,record_id";
					const rows = db
						.query<Row, SQLValue[]>(
							`SELECT * FROM ${table}${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
						)
						.all(
							...(search ? [search.value] : []),
							pageSize + 1,
							pageSize * page,
						);
					return {
						rows: rows
							.slice(0, pageSize)
							.map((row) => storageRecord(collection, row)),
						page,
						hasMore: rows.length > pageSize,
					} satisfies StoragePage;
				}
				return db.transaction(() => {
					const prior = db
						.query<{ digest: string; result_json: string }, [string]>(
							"SELECT digest,result_json FROM storage_receipts WHERE operation_id=?",
						)
						.get(operationId);
					if (prior) {
						if (prior.digest !== digest) throw new Error("request_conflict");
						return JSON.parse(prior.result_json) as
							StorageRecord | { id: string };
					}
					const result = mutate(db, table, collection, request, get);
					db.run("INSERT INTO storage_receipts VALUES(?,?,?)", [
						operationId,
						digest,
						JSON.stringify(result),
					]);
					return result;
				})();
			} finally {
				db.close();
			}
		},
	};
	function mutate(
		db: Database,
		table: string,
		collection: StorageCollection,
		request: Extract<
			RecordRequest,
			{ operation: "create" | "update" | "delete" }
		>,
		get: (id: string) => StorageRecord,
	) {
		if (
			request.operation !== "create" &&
			get(request.id).revision !== request.expectedRevision
		)
			throw new Error("app_storage_record_conflict");
		if (request.operation === "delete") {
			db.run(`DELETE FROM ${table} WHERE record_id=? AND revision=?`, [
				request.id,
				request.expectedRevision,
			]);
			return { id: request.id };
		}
		const decoded = compile(collection.row).safeParse(request.values);
		if (
			!decoded.success ||
			Buffer.byteLength(JSON.stringify(request.values)) > 8192
		)
			throw new Error("app_storage_record_invalid");
		const values = decoded.data as Record<string, unknown>;
		const columns = collection.columns.map(({ name }) => columnName(name));
		const args = collection.columns.map(({ name, type }): SQLValue => {
			const value = values[name];
			if (value === undefined) return null;
			if (type === "boolean") return value ? 1 : 0;
			if (type === "array" || type === "object") return JSON.stringify(value);
			return value as string | number;
		});
		const time = now();
		if (request.operation === "create") {
			const count = db
				.query<{ count: number }, []>(`SELECT count(*) AS count FROM ${table}`)
				.get()!.count;
			if (count >= maxRows) throw new Error("app_storage_collection_full");
			const id = crypto.randomUUID();
			db.run(
				`INSERT INTO ${table}(record_id,revision,created_at,updated_at,${columns.join(",")}) VALUES(?,1,?,?,${columns.map(() => "?").join(",")})`,
				[id, time, time, ...args],
			);
			return get(id);
		}
		db.run(
			`UPDATE ${table} SET revision=revision+1,updated_at=?,${columns.map((name) => `${name}=?`).join(",")} WHERE record_id=? AND revision=?`,
			[time, ...args, request.id, request.expectedRevision],
		);
		return get(request.id);
	}
}
