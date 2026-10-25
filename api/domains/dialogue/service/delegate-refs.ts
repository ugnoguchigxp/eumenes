import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import { parseResourceUri } from "../../resources";
import type { ExecutionReference } from "../../tool-runtime";
import type { DialogueDeps } from "./context";
import { TOOL_NAMES, toolRejection } from "./generation-tools";

/** The longest text of a resource handed to a sub-agent (`ExecutionReference.preview`). */
export const REFERENCE_TEXT_CHARS = 2000;

const REFS = `${TOOL_NAMES.delegate}`;
const refused = (path: string, reason: string) =>
	toolRejection(reason, [{ tool: REFS, path, reason }]);

/**
 * The resources a `delegate` call hands to the toolchain with its request (spec resource-uri-implementation-plan
 * section 6.2). The model names them `a<n>`; each must be in the conversation's ledger and not forgotten, and its
 * owner must still have it. A number that does not hold is refused with the reason (`unknown_resource`), so the
 * model reads it and corrects the call. Returns the resources' URIs (kept with a confirmation) and the references
 * the toolchain reads: `ref` is the URI, `preview` the owner's own shortened text of the resource.
 */
export async function resolveDelegateRefs(
	deps: Pick<DialogueDeps, "store" | "resources" | "resourceLedger">,
	conversationId: string,
	names: readonly string[] | undefined,
	signal: AbortSignal,
): Promise<{ uris: string[]; references: ExecutionReference[] }> {
	const unique = [...new Set(names ?? [])];
	if (unique.length === 0) return { uris: [], references: [] };
	const { store, resources: access, resourceLedger: ledger } = deps;
	if (!access || !ledger) throw refused("refs", "unknown_resource");
	const found = store.read((db) =>
		unique.map((name) => ledger.byRefInTransaction(db, conversationId, name)),
	);
	const uris = found.map((row, i) => {
		if (!row) throw refused(`refs[${i}]`, "unknown_resource");
		return row.uri;
	});
	return {
		uris,
		references: await referencesOf(deps, uris, signal, (i) => `refs[${i}]`),
	};
}

/** The references of resources named by URI (an approved confirmation's): each must still be there and not forgotten. */
export async function referencesOfUris(
	deps: Pick<DialogueDeps, "store" | "resources" | "resourceLedger">,
	conversationId: string,
	uris: readonly string[],
	signal: AbortSignal,
): Promise<ExecutionReference[] | null> {
	const { store, resourceLedger: ledger } = deps;
	if (uris.length === 0) return [];
	if (!ledger || !deps.resources) return null;
	const held = store.read((db) =>
		uris.every((uri) => {
			const row = ledger.byUriInTransaction(db, conversationId, uri);
			return !!row && !row.forgottenAt;
		}),
	);
	if (!held) return null;
	try {
		return await referencesOf(deps, uris, signal, () => "refs");
	} catch {
		return null;
	}
}

async function referencesOf(
	deps: Pick<DialogueDeps, "store" | "resources">,
	uris: readonly string[],
	signal: AbortSignal,
	path: (index: number) => string,
): Promise<ExecutionReference[]> {
	const { registry } = deps.resources!;
	const references: ExecutionReference[] = [];
	for (const [i, uri] of uris.entries()) {
		const parsed = parseResourceUri(uri);
		if (!parsed || uri.length > 160) throw refused(path(i), "unknown_resource");
		const resolved = deps.store.read((db: Database) =>
			registry.resolveInTransaction(db, uri),
		);
		if (!resolved.ok) throw refused(path(i), "unknown_resource");
		const read = await deps.store.read((db: Database) =>
			registry.read(db, uri, signal),
		);
		if (!read.ok) throw refused(path(i), "unknown_resource");
		const text = [...read.text].slice(0, REFERENCE_TEXT_CHARS).join("");
		const kind = registry.kind(parsed.kind);
		references.push({
			ref: uri,
			owner: kind?.owner ?? parsed.kind,
			id: parsed.id,
			revision: resolved.resource.createdAt,
			digest: hash(text),
			label: resolved.resource.label.slice(0, 200),
			kind: "resource",
			preview: text,
		});
	}
	return references;
}
