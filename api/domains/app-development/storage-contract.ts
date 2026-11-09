import { z } from "zod";

export const storageOperations = [
	"list",
	"get",
	"create",
	"update",
	"delete",
] as const;
const collectionId = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);
const fieldId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/);

export const appStorage = z.strictObject({
	version: z.literal(1),
	collections: z
		.array(
			z.strictObject({
				id: collectionId,
				schema: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/),
				operations: z
					.array(z.enum(storageOperations))
					.min(1)
					.max(storageOperations.length),
			}),
		)
		.min(1)
		.max(8),
});

export const storageScreenBinding = z.strictObject({
	collection: collectionId,
	inputs: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), fieldId),
});

const page = z.number().int().min(0).max(399);
const data = z.record(fieldId, z.json());
const record = { id: z.uuid(), expectedRevision: z.number().int().positive() };
export const recordRequest = z.discriminatedUnion("operation", [
	z.strictObject({
		operation: z.literal("list"),
		page: page.optional(),
		sort: fieldId.optional(),
		search: z
			.strictObject({ field: fieldId, value: z.string().min(1).max(160) })
			.optional(),
	}),
	z.strictObject({ operation: z.literal("get"), id: record.id }),
	z.strictObject({ operation: z.literal("create"), values: data }),
	z.strictObject({ operation: z.literal("update"), ...record, values: data }),
	z.strictObject({ operation: z.literal("delete"), ...record }),
]);

type Declaration = z.infer<typeof appStorage>;
type Column = {
	name: string;
	type: "string" | "integer" | "number" | "boolean" | "array" | "object";
	required: boolean;
};
export type StorageCollection = Declaration["collections"][number] & {
	row: Record<string, unknown>;
	columns: Column[];
};
export type StoragePlan = { collections: StorageCollection[] };
export type RecordRequest = z.infer<typeof recordRequest>;
export type StorageRecord = {
	id: string;
	revision: number;
	createdAt: number;
	updatedAt: number;
	values: Record<string, unknown>;
};
export type StoragePage = {
	rows: StorageRecord[];
	page: number;
	hasMore: boolean;
};

export class AppStorageDefinitionError extends Error {
	readonly issues: Array<{ path: string; rule: string; detail: string }>;
	constructor(code: string, path: string, detail: string) {
		super(code);
		this.issues = [{ path, rule: code, detail }];
	}
}

export function prepareAppStorage(
	storage: Declaration,
	schemas: readonly { name: string; schema: Record<string, unknown> }[],
	compile: (schema: Record<string, unknown>) => z.ZodType,
): StoragePlan {
	const names = new Set(storage.collections.map(({ id }) => id));
	if (names.size !== storage.collections.length)
		throw new Error("app_storage_duplicate_collection");
	return {
		collections: storage.collections.map((collection, index) => {
			if (new Set(collection.operations).size !== collection.operations.length)
				throw new Error("app_storage_duplicate_operation");
			const matches = schemas.filter(({ name }) => name === collection.schema);
			if (matches.length !== 1) {
				const names = schemas
					.slice(0, 8)
					.map(({ name }) => name)
					.join(", ");
				throw new AppStorageDefinitionError(
					"app_storage_schema_missing",
					`storage.collections.${index}.schema`,
					names
						? `schemas[].name と完全に一致する名前を指定してください。定義されている名前は ${names} です。`
						: "同じ下書きの schemas に行スキーマを定義し、その name を指定してください。",
				);
			}
			const row = matches[0]!.schema;
			compile(row);
			const entries = Object.entries(
				row.properties as Record<string, { type: Column["type"] }>,
			);
			if (
				!entries.length ||
				entries.length > 24 ||
				new Set(entries.map(([key]) => key.toLowerCase())).size !==
					entries.length ||
				entries.some(
					([key]) =>
						!fieldId.safeParse(key).success ||
						["constructor", "prototype"].includes(key),
				)
			)
				throw new Error("app_storage_columns_invalid");
			const required = new Set(row.required as string[] | undefined);
			return {
				...collection,
				row,
				columns: entries.map(([name, { type }]) => ({
					name,
					type,
					required: required.has(name),
				})),
			};
		}),
	};
}

/** Automatic migrations only add collections or optional columns. */
export function checkStorageUpgrade(
	before: StoragePlan | null,
	after: StoragePlan | null,
	digest: (value: unknown) => string,
) {
	if (!before) return;
	if (!after) throw new Error("app_storage_removal_requires_deletion");
	for (const old of before.collections) {
		const next = after.collections.find(({ id }) => id === old.id);
		if (!next) throw new Error("app_storage_migration_incompatible");
		const properties = (value: StorageCollection) =>
			value.row.properties as Record<string, unknown>;
		const shapeChanged = old.columns.some(
			({ name, required }) =>
				!next.columns.some(
					(column) => column.name === name && column.required === required,
				) ||
				digest(properties(old)[name]) !==
					digest(properties(next)[name] ?? null),
		);
		const oldNames = new Set(old.columns.map(({ name }) => name));
		if (
			shapeChanged ||
			next.columns.some(({ name, required }) => required && !oldNames.has(name))
		)
			throw new Error("app_storage_migration_incompatible");
	}
}
