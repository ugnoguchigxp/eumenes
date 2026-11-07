/**
 * Only the first check's schema has a condition's kind: an answer without one is an operation condition there,
 * and a later check's answer carries none.
 */
export function offeredKinds(
	tools: import("../../infrastructure/chat-stream").NativeTool[],
	step: { name: string; arguments: Record<string, unknown> },
) {
	const kinded = JSON.stringify(tools).includes('"kind"');
	const conditions = step.arguments.conditions as
		Array<Record<string, unknown>> | undefined;
	if (!Array.isArray(conditions)) return step;
	return {
		...step,
		arguments: {
			...step.arguments,
			conditions: conditions.map(({ kind, ...c }) =>
				kinded ? { ...c, kind: kind ?? "operation" } : c,
			),
		},
	};
}
