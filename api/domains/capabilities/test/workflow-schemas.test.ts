import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../../../infrastructure/sqlite";
import { createCapabilities, migrations } from "..";

const input = {
	scope: "scope-a",
	workflowId: "daily-report",
	name: "input",
	revision: 1,
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["date"],
		properties: { date: { type: "string", minLength: 10, maxLength: 10 } },
	},
};

test("workflow schemas are immutable and resolve only within their workflow", async () => {
	const dir = mkdtempSync(join(tmpdir(), "workflow-schemas-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const caps = createCapabilities(store);
		const save = (value: unknown) =>
			store.write((db) => caps.registerWorkflowSchemaInTransaction(db, value));
		const first = await save(input);
		expect(await save(input)).toEqual(first);
		await expect(
			save({ ...input, schema: { ...input.schema, required: [] } }),
		).rejects.toThrow("capability_revision_conflict");
		const scoped = (scope: string, workflowId: string) =>
			store.read((db) =>
				caps.workflowSchemaInTransaction(db, first.revisionId, {
					scope,
					workflowId,
				}),
			);
		expect(scoped("scope-a", "daily-report")?.digest).toBe(first.digest);
		expect(
			scoped("scope-a", "daily-report")?.validate.safeParse({
				date: "2026-11-09",
			}).success,
		).toBe(true);
		expect(scoped("scope-b", "daily-report")).toBeNull();
		expect(scoped("scope-a", "other-report")).toBeNull();
		expect(
			store.read((db) => caps.schemaInTransaction(db, first.revisionId)),
		).toBeNull();
		expect(
			store.read((db) => caps.documentInTransaction(db, first.revisionId)),
		).toBeNull();
		expect((await save({ ...input, revision: 2 })).revisionId).not.toBe(
			first.revisionId,
		);
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("workflow schema registration validates the finite subset and shares the caller transaction", async () => {
	const dir = mkdtempSync(join(tmpdir(), "workflow-schemas-"));
	const store = openStore(join(dir, "db"), migrations);
	try {
		const caps = createCapabilities(store);
		await expect(
			store.write((db) =>
				caps.registerWorkflowSchemaInTransaction(db, {
					...input,
					schema: { ...input.schema, $ref: "https://example.com/schema" },
				}),
			),
		).rejects.toThrow("unsupported_schema");
		let ref = "";
		await expect(
			store.write((db) => {
				ref = caps.registerWorkflowSchemaInTransaction(db, input).revisionId;
				throw new Error("workflow_save_failed");
			}),
		).rejects.toThrow("workflow_save_failed");
		expect(ref).not.toBe("");
		expect(
			store.read((db) => caps.workflowSchemaInTransaction(db, ref, input)),
		).toBeNull();
	} finally {
		await store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
