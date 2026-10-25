import type { Database } from "bun:sqlite";
import { jstSeconds } from "../../../infrastructure/jst-time";
import { parseResourceUri } from "../../resources";
import type { ResolvedResource } from "../../resources";
import { runViewingResource } from "../repository/resources";
import type { DialogueDeps } from "./context";
import {
	dayOf,
	plain,
	type DocumentRefs,
	type ResourceLine,
} from "./context-document";

/** The most resources the state section lists (section 7.1 of the resource plan). */
export const RESOURCE_LINES = 8;
/** The ledger rows looked at to find that many that still exist at their owner. */
const RESOURCE_SCAN = 40;

/** What can be done with a resource in words, the kind's default first. */
function actionWords(resource: ResolvedResource): string[] {
	return resource.actions.flatMap((action) => {
		const word = resource.actionLabels[action];
		return word ? [word] : [];
	});
}

/**
 * The resources of the conversation as the state section lists them: the most recently used first, at most eight,
 * each with its kind, name, origin (the TODO that made it, or the history's day) and what can be done with it. One
 * that its owner no longer has is left out.
 */
export function resourceLinesInTransaction(
	deps: Pick<DialogueDeps, "resources" | "resourceLedger">,
	db: Database,
	conversationId: string,
	refs: DocumentRefs,
	year: string,
): ResourceLine[] {
	const access = deps.resources;
	const ledger = deps.resourceLedger;
	if (!access || !ledger) return [];
	const lines: ResourceLine[] = [];
	for (const row of ledger.recentInTransaction(
		db,
		conversationId,
		RESOURCE_SCAN,
	)) {
		if (lines.length >= RESOURCE_LINES) break;
		const resolved = access.registry.resolveInTransaction(db, row.uri);
		if (!resolved.ok) continue;
		const resource = resolved.resource;
		const todo =
			row.source === "work" && row.workId ? refs.todo(row.workId) : null;
		lines.push({
			ref: row.ref,
			kindLabel: resource.kindLabel,
			label: resource.label,
			origin:
				todo ??
				`履歴 ${dayOf(jstSeconds(Date.parse(resource.createdAt)), year)}`,
			actions: actionWords(resource),
		});
	}
	return lines;
}

/**
 * The resource the run's screen showed, as `<now>`'s `viewing` line (`a3 画像「…」`). The Web sends the resource's
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
	return `a${entered.ref} ${resolved.resource.kindLabel}「${plain(resolved.resource.label)}」`;
}
