import type { InputContext } from "eumenes-agency";
import type { AgencyHostDeps, Conv } from "./host-types";
import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../infrastructure/digest";

export const combineInput = (
	...inputs: readonly InputContext[]
): InputContext => ({
	sources: [...new Set(inputs.flatMap((i) => i.sources))].sort(),
	complete: inputs.every((i) => i.complete),
});
export const fixedInput = (value: unknown): InputContext => ({
	sources: [`host-config:${sha256Hex(JSON.stringify(value))}`],
	complete: true,
});
export function staleInputSources(
	deps: AgencyHostDeps,
	db: Database,
	sources: readonly string[],
): string[] {
	return [
		...(deps.memory.referenceInputs?.staleInTransaction(db, sources) ?? []),
		...(deps.state?.staleSourcesInTransaction(db, sources) ?? []),
	];
}
export function currentInput(
	deps: AgencyHostDeps,
	db: Database,
	input: InputContext,
): boolean {
	return (
		(!deps.memory.referenceInputs ||
			deps.memory.referenceInputs.isCurrentInTransaction(db, input)) &&
		!deps.state?.staleSourcesInTransaction(db, input.sources).length
	);
}

/** Capture before the core validates dependencies. The port sends these same frozen messages. */
export function captureHostInput(
	deps: AgencyHostDeps,
	c: Conv,
	config: unknown,
): InputContext {
	const captured = deps.captureContext?.(c.id);
	if (deps.captureContext && !captured)
		throw new Error("agency_context_unavailable");
	c.preparedContext = captured ? structuredClone(captured.messages) : undefined;
	return combineInput(
		fixedInput(config),
		captured?.input ?? { sources: [], complete: !deps.captureContext },
	);
}

export function observationInput(
	deps: AgencyHostDeps,
	db: Database,
	id: string,
): InputContext {
	if (deps.memory.referenceInputs)
		return deps.memory.referenceInputs.captureInTransaction(db, {
			messageIds: [id],
		});
	// A host without Memory still has the conversation's own source contract.
	const source = deps.conversation.sourceInTransaction(db, id);
	return {
		sources: [id],
		complete: source.state === "available" && source.message.role === "user",
	};
}

/**
 * The sources behind what the agenda agent cites (a user's message, `memory:<id>`, `note:<id>`): captured now from
 * Memory, so the action that rests on them is refused once any was forgotten. A note rests on what it was made from.
 */
export function referencedInput(
	deps: AgencyHostDeps,
	db: Database,
	notes: readonly { id: string; refs: readonly string[] }[],
	refs: readonly string[],
): InputContext {
	const messageIds = new Set<string>();
	const itemIds = new Set<string>();
	let complete = true;
	const seen = new Set<string>();
	const visit = (ref: string) => {
		const base = ref.replace(/:c\d+$/u, "");
		if (seen.has(base)) return;
		seen.add(base);
		if (base.startsWith("memory:")) itemIds.add(base.slice("memory:".length));
		else if (base.startsWith("note:")) {
			const note = notes.find((n) => n.id === base.slice("note:".length));
			if (note) note.refs.forEach(visit);
			else complete = false;
		} else if (!base.startsWith("profile:")) messageIds.add(base);
	};
	refs.forEach(visit);
	if (!deps.memory.referenceInputs)
		return { sources: [...messageIds], complete };
	const captured = deps.memory.referenceInputs.captureInTransaction(db, {
		messageIds: [...messageIds],
		itemIds: [...itemIds],
	});
	return {
		sources: captured.sources,
		complete: complete && captured.complete,
	};
}
