import type { Database } from "bun:sqlite";
import type {
	Assertion,
	ProjectionSnapshot,
	ScopeRef,
	WorldSlice,
} from "eumenes-world-model";
import { listEntities } from "eumenes-world-model/sqlite";
import { TOPIC_MAX_ENTITIES, type RenderTopic } from "./context-render";
import type { WorldService } from "./world-service";

/** Most entities one `listEntities` call returns (the package's own maximum). */
const MAX_LISTED_ENTITIES = 500;

/** The part of a listed entity the matcher reads. */
export type TopicCandidate = {
	readonly id: string;
	readonly displayName: string;
	readonly aliases: readonly string[];
};

/** A name this short (in characters) matches too much to identify anything. */
const MIN_NAME_CHARS = 2;
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

/** Relations that carry cause and dependency; the topic Slice follows these one step from a named target. */
const TOPIC_RELATIONS: ReadonlySet<string> = new Set([
	"increases",
	"decreases",
	"causes",
	"enables",
	"inhibits",
	"depends_on",
	"part_of",
]);

/**
 * The part of a focused snapshot the topic Slice shows: what is asserted about a named target (its state, and its
 * causal/dependency relations to others), and the claims of others that act on it through such a relation
 * (depth 1). The assertions that dispute a kept one, and those a kept one disputes, stay so a contested claim
 * keeps its refutations.
 */
export function topicAssertions(
	assertions: readonly Assertion[],
	focus: ReadonlySet<string>,
): Assertion[] {
	const direct = (assertion: Assertion) => {
		const { payload } = assertion;
		if (payload.kind === "relation")
			return (
				TOPIC_RELATIONS.has(payload.relation) &&
				(focus.has(assertion.subjectId) || focus.has(payload.objectId))
			);
		return focus.has(assertion.subjectId);
	};
	const key = (ref: { id: string; revision: number }) =>
		`${ref.id}\u0000${ref.revision}`;
	const kept = new Set(assertions.filter(direct).map(key));
	const related = new Set<string>();
	for (const assertion of assertions) {
		if (kept.has(key(assertion)))
			for (const target of assertion.contradicts) related.add(key(target));
		else if (assertion.contradicts.some((target) => kept.has(key(target))))
			related.add(key(assertion));
	}
	return assertions.filter(
		(assertion) => kept.has(key(assertion)) || related.has(key(assertion)),
	);
}

type TopicAccess = { principal: string; scopeKeys: string[]; purpose: string };

/**
 * The known targets this turn's wording names, and the snapshot focused on them (depth 1) and cut to their
 * state and direct causal/dependency claims. Names and aliases come from `listEntities` (live entities of the
 * Scope only; merged ones are represented by their representative, forgotten ones are never listed) and are
 * matched deterministically. Null when nothing is named, or when World refuses the read: the caller then
 * reads the default Slice, which reports whatever the refusal was.
 */
export function readTopicSnapshot(
	db: Database,
	options: {
		world: WorldService;
		scope: ScopeRef;
		access: TopicAccess;
		texts: readonly string[] | undefined;
		nowMs: number;
	},
): { ids: string[]; snapshot: ProjectionSnapshot } | null {
	const { world, scope, access, texts } = options;
	if (!texts || texts.every((text) => text.trim() === "")) return null;
	const listed = listEntities(db, {
		contractVersion: 1,
		access: world.accessInTransaction(db, { access }),
		scopeKey: scope.scopeKey,
		limit: MAX_LISTED_ENTITIES,
	});
	if (listed.status !== "ready") return null;
	const ids = matchTopicEntities(listed.entities, texts, TOPIC_MAX_ENTITIES);
	if (ids.length === 0) return null;
	const focus = world.readSnapshot(db, {
		access,
		scope,
		asOf: options.nowMs,
		focus: { subjectIds: ids, depth: 1 },
	});
	if (focus.status !== "ready") return null;
	return {
		ids,
		snapshot: {
			...focus.snapshot,
			assertions: topicAssertions(focus.snapshot.assertions, new Set(ids)),
		},
	};
}

/** Display names of the targets a topic Slice mentions (as subject or relation object), in id order. */
export function topicNames(
	db: Database,
	world: WorldService,
	scope: ScopeRef,
	access: TopicAccess,
	slice: WorldSlice,
): RenderTopic[] {
	const ids = new Set<string>();
	for (const unit of slice.units) {
		ids.add(unit.conclusion.subjectId);
		if (unit.conclusion.payload.kind === "relation")
			ids.add(unit.conclusion.payload.objectId);
	}
	if (ids.size === 0 || ids.size > MAX_LISTED_ENTITIES) return [];
	const listed = listEntities(db, {
		contractVersion: 1,
		access: world.accessInTransaction(db, { access }),
		scopeKey: scope.scopeKey,
		query: { ids: [...ids].sort() },
		limit: MAX_LISTED_ENTITIES,
	});
	if (listed.status !== "ready") return [];
	return listed.entities.map((entity) => ({
		id: entity.id,
		name: entity.displayName,
	}));
}
