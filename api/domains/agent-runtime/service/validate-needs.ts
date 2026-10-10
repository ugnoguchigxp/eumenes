import { ValidationFailure } from "../../../infrastructure/validation-log";
import type { Database } from "bun:sqlite";
import type { z } from "zod";
import { needsSchema, type Task } from "../contracts";

/** Once bound, the original request/item belongs to the host; later replies update status. */
export function canonicalNeeds(
	needs: z.infer<typeof needsSchema> | undefined,
	question: string,
	previous: string | null,
	required: boolean,
) {
	const known = previous ? needsSchema.parse(JSON.parse(previous)) : [];
	const result = needs?.map((need) => {
		const original = known.find((item) => item.id === need.id);
		return original ? { ...original, status: need.status } : need;
	});
	if (result)
		result.push(
			...known.filter((item) => !result.some((need) => need.id === item.id)),
		);
	if (result && result.length > 8)
		throw new ValidationFailure("invalid_needs", [
			{ validationPath: "needs", validationCode: "too_big" },
		]);
	validateNeeds(result, question, required && !previous);
	return result;
}
export function settleNeeds(
	db: Database,
	task: Task,
	needs: z.infer<typeof needsSchema> | undefined,
	question: string,
	required: boolean,
) {
	const result = canonicalNeeds(
		needs,
		question,
		task.exploration_json ?? null,
		required,
	);
	if (result)
		db.query("UPDATE agent_tasks SET exploration_json=? WHERE id=?").run(
			JSON.stringify(result),
			task.id,
		);
}

export function validateNeeds(
	needs: Array<{ id: string; requestQuote: string }> | undefined,
	question: string,
	required: boolean,
) {
	if (!needs) {
		if (required)
			throw new ValidationFailure("invalid_needs", [
				{ validationPath: "needs", validationCode: "required" },
			]);
		return;
	}
	const ids = new Set<string>();
	for (const [index, need] of needs.entries()) {
		if (!question.includes(need.requestQuote))
			throw new ValidationFailure("invalid_needs", [
				{
					validationPath: `needs.${index}.requestQuote`,
					validationCode: "verbatim_quote_required",
				},
			]);
		if (ids.has(need.id))
			throw new ValidationFailure("invalid_needs", [
				{ validationPath: `needs.${index}.id`, validationCode: "duplicate_id" },
			]);
		ids.add(need.id);
	}
}
