import type { Database } from "bun:sqlite";
import type { ScopeRef } from "eumenes-world-model";
import { listEntities } from "eumenes-world-model/sqlite";
import {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
} from "../../conversation";
import type { WorldService } from "./world-service";

/** Most known targets one turn's wording is resolved to. */
export const TOPIC_MAX_ENTITIES = 5;

/** Most entities one `listEntities` call returns (the package's own maximum). */
const MAX_LISTED_ENTITIES = 500;

/** The part of a listed entity the matcher reads. */
export type TopicCandidate = {
	readonly id: string;
	readonly displayName: string;
	readonly aliases: readonly string[];
};

/** A name this short (in characters) matches too much to identify anything. */
export const MIN_NAME_CHARS = 2;
const ASCII_WORD = /[a-z0-9]/;

/** NFKC, trimmed, case-folded: the one form names and wording are compared in. */
export const normalizeTopicText = (text: string): string =>
	text.normalize("NFKC").trim().toLowerCase();

/**
 * Names (display name and aliases, normalized) that identify exactly ONE entity. A name shared by two or more
 * entities is ambiguous and is never matched; a name too short to identify anything is dropped as well.
 */
export function unambiguousNames(
	entities: readonly TopicCandidate[],
): Map<string, string> {
	const owners = new Map<string, Set<string>>();
	for (const entity of entities)
		for (const raw of [entity.displayName, ...entity.aliases]) {
			const name = normalizeTopicText(raw);
			if ([...name].length < MIN_NAME_CHARS) continue;
			const set = owners.get(name) ?? new Set<string>();
			set.add(entity.id);
			owners.set(name, set);
		}
	const names = new Map<string, string>();
	for (const [name, ids] of owners)
		if (ids.size === 1) names.set(name, [...ids][0]!);
	return names;
}

/** Latin letters and digits only count as a name when they are not the middle of a longer word. */
function atBoundary(text: string, start: number, end: number): boolean {
	const first = text[start]!;
	const last = text[end - 1]!;
	if (ASCII_WORD.test(first) && start > 0 && ASCII_WORD.test(text[start - 1]!))
		return false;
	if (ASCII_WORD.test(last) && end < text.length && ASCII_WORD.test(text[end]!))
		return false;
	return true;
}

/**
 * Known entities named in the wording, deterministic: each text is normalized (NFKC, trim, lower case); the
 * longest names are looked for first and the characters a match covers are not matched again by a shorter
 * name. Texts are taken in the given order (the current input first); within a text, longer names come first.
 * At most `max` entity ids.
 */
export function matchTopicEntities(
	entities: readonly TopicCandidate[],
	texts: readonly string[],
	max = TOPIC_MAX_ENTITIES,
): string[] {
	const names = [...unambiguousNames(entities)].sort(
		([a], [b]) => [...b].length - [...a].length || (a < b ? -1 : a > b ? 1 : 0),
	);
	const found: string[] = [];
	for (const raw of texts) {
		const text = normalizeTopicText(raw);
		if (text === "") continue;
		const covered = Array.from({ length: text.length }, () => false);
		for (const [name, id] of names) {
			if (found.length >= max) return found;
			let from = 0;
			for (;;) {
				const at = text.indexOf(name, from);
				if (at < 0) break;
				const end = at + name.length;
				from = at + 1;
				if (covered.slice(at, end).some(Boolean) || !atBoundary(text, at, end))
					continue;
				covered.fill(true, at, end);
				if (!found.includes(id)) found.push(id);
				from = end;
			}
		}
	}
	return found.slice(0, max);
}

export type ContextNamesOptions = {
	world: WorldService;
	/** The Scope a conversation reads from. Default: the conversation default principal/scope. */
	scopeOf?: (conversationId: string) => ScopeRef;
	/** Purpose named in the AccessContext (the conversation SourceAdapter must allow it). */
	purpose?: string;
};

/**
 * The names dialogue shows as a hint: the display names of the known targets this turn's wording names, never
 * their claims. Names and aliases come from `listEntities` (live entities of the Scope only; merged ones are
 * represented by their representative, forgotten ones are never listed) and are matched deterministically.
 * Empty when World is unusable, refuses the read, or nothing is named.
 */
export function createWorldContextNames(options: ContextNamesOptions) {
	const { world } = options;
	const purpose = options.purpose ?? "dialogue.read";
	const scopeOf =
		options.scopeOf ??
		((): ScopeRef => ({
			principal: CONVERSATION_DEFAULT_PRINCIPAL,
			scopeKey: CONVERSATION_DEFAULT_SCOPE,
		}));
	return {
		knownNamesInTransaction(
			db: Database,
			input: { conversationId: string; texts: readonly string[] },
		): string[] {
			if (input.texts.every((text) => text.trim() === "")) return [];
			if (!world.statusInTransaction(db).usable) return [];
			const scope = scopeOf(input.conversationId);
			const listed = listEntities(db, {
				contractVersion: 1,
				access: world.accessInTransaction(db, {
					access: {
						principal: scope.principal,
						scopeKeys: [scope.scopeKey],
						purpose,
					},
				}),
				scopeKey: scope.scopeKey,
				limit: MAX_LISTED_ENTITIES,
			});
			if (listed.status !== "ready") return [];
			const names = new Map(
				listed.entities.map((entity) => [entity.id, entity.displayName]),
			);
			return matchTopicEntities(listed.entities, input.texts).flatMap(
				(id) => names.get(id) ?? [],
			);
		},
	};
}
export type WorldContextNames = ReturnType<typeof createWorldContextNames>;
