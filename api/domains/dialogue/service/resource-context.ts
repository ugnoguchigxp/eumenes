import type { Database } from "bun:sqlite";
import { parseResourceUri } from "../../resources";
import { runViewingResource } from "../repository/resources";
import type { DialogueDeps } from "./context";
import { lineText } from "./input-text";

/**
 * The resource the run's screen showed, as `## State`'s line of what is in front of the user (`a3 画像「…」`). The Web sends the resource's
 * URI; it is entered into the ledger as `viewed` (the same URI keeps its number) and the model reads only the
 * number. Anything else the run carries, or a resource its owner no longer has, adds no line.
 */
export function viewingLineInTransaction(
	deps: Pick<DialogueDeps, "resources" | "resourceLedger">,
	db: Database,
	run: { id: string; conversationId: string },
): string | undefined {
	const access = deps.resources;
	const ledger = deps.resourceLedger;
	if (!access || !ledger) return undefined;
	const stored = runViewingResource(db, run.id);
	const parsed = stored ? parseResourceUri(stored) : null;
	if (!parsed) return undefined;
	const resolved = access.registry.resolveInTransaction(db, parsed.uri);
	if (!resolved.ok) return undefined;
	const entered = ledger.enterInTransaction(db, {
		conversationId: run.conversationId,
		uri: parsed.uri,
		kind: resolved.resource.kind,
		label: resolved.resource.label,
		source: "viewed",
	});
	return `a${entered.ref} ${resolved.resource.kindLabel}「${lineText(resolved.resource.label)}」`;
}
