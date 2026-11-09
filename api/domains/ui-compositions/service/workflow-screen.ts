import type { Database } from "bun:sqlite";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import { validatedDefinition } from "../contracts";

const key = z.string().min(1).max(64);
const path = z.array(z.number().int().nonnegative()).max(5);
const fields = z.array(key).min(1).max(12);
const screenInput = z.strictObject({
	id: z.string().min(1).max(160),
	revision: z.number().int().positive(),
	definition: z.json(),
	bindings: z.strictObject({
		inputs: z.record(key, key),
		table: z
			.strictObject({
				path,
				rowsKey: key,
				columns: fields,
			})
			.optional(),
		sections: z
			.strictObject({
				path,
				rowsKey: key,
				groupBy: key,
				itemKeys: fields,
				labels: z
					.record(key, z.record(z.string(), z.string().min(1).max(200)))
					.optional(),
			})
			.optional(),
	}),
});

export function prepareWorkflowScreen(raw: unknown) {
	const {
		id,
		revision,
		bindings,
		definition: rawDefinition,
	} = screenInput.parse(raw);
	const { definition, fields } = validatedDefinition(rawDefinition);
	const formFields = new Set(fields?.map((field) => field.id));
	if (Object.keys(bindings.inputs).some((field) => !formFields.has(field)))
		throw new Error("workflow_screen_input_invalid");
	const { table, sections } = bindings;
	if (table && sections) throw new Error("workflow_screen_output_invalid");
	const output = table ?? sections;
	if (output) {
		let part: unknown = definition;
		for (const index of output.path) {
			const children = (part as { children?: unknown } | undefined)?.children;
			part = Array.isArray(children) ? children[index] : undefined;
		}
		const target = part as { view?: unknown; columns?: unknown } | undefined;
		if (
			sections &&
			(target?.view !== "grouped-list" ||
				Object.keys(sections.labels ?? {}).some(
					(key) => !sections.itemKeys.includes(key),
				))
		)
			throw new Error("workflow_screen_sections_invalid");
		if (
			table &&
			(target?.view !== "data-table" ||
				!Array.isArray(target.columns) ||
				target.columns.length !== table.columns.length)
		)
			throw new Error("workflow_screen_table_invalid");
	}
	const value = { definition, bindings };
	const digest = sha256Hex(
		canonicalJson(value, { omitUndefined: true, keyOrder: "codeUnit" }),
	);
	return { id, revision, digest, value };
}

export function workflowScreenInTransaction(
	db: Database,
	owner: { scope: string; workflowId: string },
	id: string,
	revision: number,
) {
	const row = db
		.query<
			{ digest: string; value_json: string },
			[string, string, string, number]
		>(
			"SELECT digest,value_json FROM ui_workflow_screens WHERE scope=? AND workflow_id=? AND id=? AND revision=?",
		)
		.get(owner.scope, owner.workflowId, id, revision);
	return row
		? {
				id,
				revision,
				digest: row.digest,
				value: JSON.parse(row.value_json) as ReturnType<
					typeof prepareWorkflowScreen
				>["value"],
			}
		: null;
}

export function saveWorkflowScreenInTransaction(
	db: Database,
	owner: { scope: string; workflowId: string },
	raw: unknown,
) {
	const screen = prepareWorkflowScreen(raw);
	const prior = workflowScreenInTransaction(
		db,
		owner,
		screen.id,
		screen.revision,
	);
	if (prior && prior.digest !== screen.digest)
		throw new Error("workflow_screen_revision_conflict");
	if (!prior)
		db.query(
			"INSERT INTO ui_workflow_screens(scope,workflow_id,id,revision,digest,value_json) VALUES(?,?,?,?,?,?)",
		).run(
			owner.scope,
			owner.workflowId,
			screen.id,
			screen.revision,
			screen.digest,
			JSON.stringify(screen.value),
		);
	return screen;
}
