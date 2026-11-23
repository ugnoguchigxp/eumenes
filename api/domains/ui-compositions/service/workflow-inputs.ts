import { z } from "zod";
import { fieldsOfDefinition, type Definition } from "../contracts";

export type WorkflowInputIssue = { path: string; rule: string; detail: string };

/** A confirmed screen must be able to supply every required workflow input. */
export function workflowScreenInputIssues(
	definition: unknown,
	bindings: Record<string, string>,
	schema: z.ZodType,
	fixed: Record<string, unknown>,
): WorkflowInputIssue[] {
	if (!(schema instanceof z.ZodObject))
		return [
			{
				path: "workflow.input.schemaRef",
				rule: "workflow_schema_unavailable",
				detail: "オブジェクト型の入力を選んでください。",
			},
		];
	const fields = definition
		? (fieldsOfDefinition(definition as Definition) ?? [])
		: [];
	const issues: WorkflowInputIssue[] = [];
	for (const [key, type] of Object.entries(schema.shape) as [
		string,
		z.ZodType,
	][]) {
		if (Object.hasOwn(fixed, key) || type.safeParse(undefined).success)
			continue;
		const field = fields.find((value) => bindings[value.id] === key);
		if (!field || (!field.required && field.type !== "boolean"))
			issues.push({
				path: "screen.bindings.inputs",
				rule: "workflow_screen_input_missing",
				detail: `必須入力 ${key} を固定値か必須のフォーム項目で渡してください。`,
			});
	}
	for (const [id, key] of Object.entries(bindings)) {
		const field = fields.find((value) => value.id === id);
		let type = schema.shape[key] as z.ZodType | undefined;
		if (!field || !type || Object.hasOwn(fixed, key)) {
			issues.push({
				path: `screen.bindings.inputs.${id}`,
				rule: "workflow_screen_input_invalid",
				detail:
					"存在するフォーム項目を、固定値と重複しない入力へ対応させてください。",
			});
			continue;
		}
		while (type instanceof z.ZodOptional || type instanceof z.ZodDefault)
			type = type.unwrap() as z.ZodType;
		const compatible =
			field.type === "number"
				? type instanceof z.ZodNumber
				: field.type === "boolean"
					? type instanceof z.ZodBoolean
					: field.type === "checkbox"
						? type instanceof z.ZodArray &&
							(type.element instanceof z.ZodString ||
								type.element instanceof z.ZodEnum)
						: type.type === "string" ||
							type instanceof z.ZodEnum ||
							(type instanceof z.ZodLiteral &&
								[...type.values].every((value) => typeof value === "string"));
		if (
			!compatible ||
			(field.options &&
				field.options.some(
					(value) =>
						!z.safeParse(
							field.type === "checkbox" && type instanceof z.ZodArray
								? type.element
								: type,
							value,
						).success,
				))
		)
			issues.push({
				path: `screen.bindings.inputs.${id}`,
				rule: "workflow_screen_input_type",
				detail: "フォームの型と選択肢を、実行側の入力の型に合わせてください。",
			});
	}
	return issues;
}
