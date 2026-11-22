import type { InputContext } from "eumenes-agency";
import type { AgencyHostDeps } from "./host-types";
import type { Database } from "bun:sqlite";
import { sha256Hex } from "../../infrastructure/digest";

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

/**
 * The plain `memory:<id>` references whose item is no longer current (superseded, deactivated, expired). A reply that
 * cites one is refused at adoption (`referencedInput`), so the agenda lets go of what rests on it as well.
 */
export function staleMemoryRefs(
	deps: AgencyHostDeps,
	db: Database,
	sources: readonly string[],
): string[] {
	const refs = [...new Set(sources.filter((r) => r.startsWith("memory:")))];
	if (!refs.length || !deps.memory.referenceInputs) return [];
	const status = deps.memory.status();
	if (!status.enabled || !status.healthy) return [];
	const current = new Set(
		deps.memory.referenceInputs.captureInTransaction(db, {
			itemIds: refs.map((r) => r.slice("memory:".length)),
		}).sources,
	);
	return refs.filter((r) => !current.has(r));
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

/**
 * The sources behind what the agenda agent cites (a user's message, `memory:<id>`, `note:<id>`): captured now from
 * Memory, so the action that rests on them is refused once any was forgotten. A note rests on what it was made from.
 */
export function referencedInput(
	deps: AgencyHostDeps,
	db: Database,
	notes: readonly {
		id: string;
		refs: readonly string[];
		inputs?: readonly string[];
	}[],
	refs: readonly string[],
): InputContext {
	const messageIds = new Set<string>();
	const itemIds = new Set<string>();
	const retained: string[] = [];
	let complete = true;
	const seen = new Set<string>();
	const visit = (ref: string) => {
		const base = ref.replace(/:c\d+$/u, "");
		if (seen.has(base)) return;
		seen.add(base);
		if (base.startsWith("memory:")) itemIds.add(base.slice("memory:".length));
		else if (base.startsWith("note:")) {
			const note = notes.find((n) => n.id === base.slice("note:".length));
			if (note?.inputs) {
				retained.push(...note.inputs);
				complete &&= currentInput(deps, db, {
					sources: note.inputs,
					complete: true,
				});
			} else if (note) note.refs.forEach(visit);
			else complete = false;
		} else if (!base.startsWith("profile:")) messageIds.add(base);
	};
	refs.forEach(visit);
	if (!deps.memory.referenceInputs)
		return { sources: [...new Set([...messageIds, ...retained])], complete };
	const captured = deps.memory.referenceInputs.captureInTransaction(db, {
		messageIds: [...messageIds],
		itemIds: [...itemIds],
	});
	return {
		sources: [...new Set([...captured.sources, ...retained])],
		complete: complete && captured.complete,
	};
}
