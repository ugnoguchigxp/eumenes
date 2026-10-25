import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { parseResourceUri, type ResourceContext } from "../../resources";
import type { WorkLink } from "../contracts/resources";
import { setWorkLinks, workLinksOf } from "../repository/resources";
import type { WorkRow } from "../repository/work";
import type { DialogueDeps } from "./context";

const log = getLogger("dialogue");

/** The most links one TODO keeps. */
export const WORK_LINKS_MAX = 16;

/**
 * The resources a finished TODO made (spec resource-uri-implementation-plan-2026-10-25.md section 4.1), in the
 * transaction in which it becomes `done`: each resource kind the toolchain produces reads them from the result
 * (`fromResultInTransaction`), `reported` adds the URIs the sub-agent named (`ChildResult.links`, already checked
 * against what its tools returned). Each is resolved at its owner (one that is not there is left out), kept in the
 * TODO's `links_json` after the links it already has, and entered into the conversation's ledger as `work`.
 * Returns the TODO's links.
 */
export function recordWorkLinksInTransaction(
	deps: Pick<DialogueDeps, "resources" | "resourceLedger">,
	db: Database,
	row: Pick<WorkRow, "id" | "conversationId" | "toolchainId">,
	result: unknown,
	context: ResourceContext,
	reported: readonly string[] = [],
): WorkLink[] {
	const access = deps.resources;
	const ledger = deps.resourceLedger;
	if (!access || !ledger) return [];
	const { registry } = access;
	const existing = workLinksOf(db, [row.id]).get(row.id) ?? [];
	const links = new Map<string, WorkLink>(
		existing.map((link) => [link.uri, link]),
	);
	const add = (text: string) => {
		const parsed = parseResourceUri(text);
		if (!parsed || links.has(parsed.uri) || links.size >= WORK_LINKS_MAX)
			return;
		const resolved = registry.resolveInTransaction(db, parsed.uri);
		if (!resolved.ok) return;
		links.set(parsed.uri, {
			uri: parsed.uri,
			kind: resolved.resource.kind,
			label: resolved.resource.label,
		});
	};
	for (const kind of access.producesInTransaction(db, row.toolchainId)) {
		const adapter = registry.adapter(kind);
		if (!adapter) continue;
		let made: Array<{ uri: string }>;
		try {
			made = adapter.fromResultInTransaction(db, result, context);
		} catch {
			// One owner that cannot read the result leaves its links out; the TODO still finishes.
			log.warn("dialogue.resource_links_failed", { reason: kind });
			continue;
		}
		for (const ref of made) add(ref.uri);
	}
	for (const uri of reported) add(uri);
	const all = [...links.values()];
	if (all.length !== existing.length) setWorkLinks(db, row.id, all);
	ledger.enterLinksInTransaction(db, {
		conversationId: row.conversationId,
		workId: row.id,
		links: all,
	});
	return all;
}
