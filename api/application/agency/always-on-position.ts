import type { AgencyHostDeps } from "./host-types";

/**
 * Where the records writer stopped reading a conversation, kept across a revoke of the agency's checkpoint (a change
 * of settings, a purge): the position is the conversation's reading place, not what the agency remembers. The host
 * holds it from the moment the record is revoked to the moment the conversation's scope is made again.
 */
const kept = new WeakMap<object, Map<string, number>>();

export function keepPosition(
	deps: AgencyHostDeps,
	conversationId: string,
	seq: number | null,
) {
	if (seq === null) return;
	const map = kept.get(deps) ?? new Map<string, number>();
	kept.set(deps, map);
	map.set(conversationId, Math.max(seq, map.get(conversationId) ?? 0));
}

/** The position kept for the conversation (once); null when none was. */
export function takePosition(
	deps: AgencyHostDeps,
	conversationId: string,
): number | null {
	const map = kept.get(deps);
	const seq = map?.get(conversationId) ?? null;
	map?.delete(conversationId);
	return seq;
}
