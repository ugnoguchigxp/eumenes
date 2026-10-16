import type { Entity, ProjectionEntry, ScopeRef } from "eumenes-world-model";
import type { Database } from "bun:sqlite";
import {
	CURATION_LIMITS,
	type CurationClaimView,
	type CurationEntityView,
	type CurationHostTable,
	type CurationValue,
} from "./curation-types";
import type { CurationCtx } from "./curation-ctx";
import type { ListedEntity } from "./curation-reads";

/** Words looked up per window, and entities one word may bring. */
const MAX_WORDS = 40;
const PER_WORD = 5;
/** A name is short: a longer run of letters is no alias to look up. */
const MAX_WORD_LENGTH = 64;

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
/** A one character particle or letter is no name. */
const TOO_SHORT = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{ASCII}]$/u;

/** Distinct words of the texts, in the order they appear. Deterministic: no model is involved. */
function wordsOf(texts: readonly string[], max = MAX_WORDS): string[] {
	const seen = new Set<string>();
	const words: string[] = [];
	for (const text of texts)
		for (const part of segmenter.segment(text)) {
			if (!part.isWordLike) continue;
			const word = part.segment.normalize("NFC").trim();
			if (
				word === "" ||
				[...word].length > MAX_WORD_LENGTH ||
				TOO_SHORT.test(word) ||
				seen.has(word)
			)
				continue;
			seen.add(word);
			words.push(word);
			if (words.length >= max) return words;
		}
	return words;
}

/** The value of a claim as the model reads it; null for a value the model never sees (an entity). */
export function valueOf(
	assertion: ProjectionEntry["assertion"],
): CurationValue | null {
	if (assertion.payload.kind !== "value") return null;
	const value = assertion.payload.value;
	switch (value.kind) {
		case "string":
			return { type: "string", value: value.value };
		case "boolean":
			return { type: "boolean", value: value.value };
		case "number":
			return { type: "number", value: value.value, unit: value.unit };
		default:
			return null;
	}
}

type View = {
	entities: ListedEntity[];
	claims: ProjectionEntry[];
};

/**
 * Which entities and claims the model sees: entities whose name or alias starts with a word
 * of the utterances, then the entities of the most recently recorded claims, at most 30; the live
 * claims about them (at most 40, newest first); the objects of those claims' relations are shown
 * too (at most 40 entities in all). null when World can not answer.
 */
export function selectView(
	ctx: CurationCtx,
	db: Database,
	scope: ScopeRef,
	texts: readonly string[],
): View | null {
	const read = ctx.liveClaims(db, scope);
	if (read === null) return null;
	const picked = new Map<string, ListedEntity>();
	for (const word of wordsOf(texts)) {
		if (picked.size >= CURATION_LIMITS.entities) break;
		const found = ctx.entitiesByPrefix(db, scope, word, PER_WORD);
		if (found === null) return null;
		for (const entity of found) {
			if (picked.size >= CURATION_LIMITS.entities) break;
			picked.set(entity.id, entity);
		}
	}
	const newestFirst = [...read.entries].sort(
		(a, b) =>
			b.assertion.recordedAt - a.assertion.recordedAt ||
			a.id.localeCompare(b.id),
	);
	if (picked.size < CURATION_LIMITS.entities) {
		const recent: string[] = [];
		for (const entry of newestFirst) {
			if (!picked.has(entry.subjectId) && !recent.includes(entry.subjectId))
				recent.push(entry.subjectId);
			if (recent.length >= CURATION_LIMITS.entities) break;
		}
		const found = ctx.entitiesByIds(db, scope, recent);
		if (found === null) return null;
		for (const entity of found) {
			if (picked.size >= CURATION_LIMITS.entities) break;
			if (!picked.has(entity.id)) picked.set(entity.id, entity);
		}
	}
	const subjects = new Set(picked.keys());
	const claims = newestFirst
		.filter((entry) => subjects.has(entry.subjectId))
		.filter(
			(entry) =>
				entry.assertion.payload.kind === "relation" ||
				valueOf(entry.assertion) !== null,
		)
		.slice(0, CURATION_LIMITS.claims);
	const objects: string[] = [];
	for (const entry of claims) {
		const payload = entry.assertion.payload;
		if (
			payload.kind === "relation" &&
			!picked.has(payload.objectId) &&
			!objects.includes(payload.objectId)
		)
			objects.push(payload.objectId);
	}
	if (objects.length > 0) {
		const found = ctx.entitiesByIds(db, scope, objects);
		if (found === null) return null;
		for (const entity of found) {
			if (picked.size >= CURATION_LIMITS.entitiesWithObjects) break;
			if (!picked.has(entity.id)) picked.set(entity.id, entity);
		}
	}
	return {
		entities: [...picked.values()],
		claims: claims.filter((entry) => {
			const payload = entry.assertion.payload;
			return payload.kind !== "relation" || picked.has(payload.objectId);
		}),
	};
}

/** The view as the model reads it, with the host's table of what its refs stand for. */
export function describeView(
	ctx: CurationCtx,
	scope: ScopeRef,
	view: View,
): {
	entities: CurationEntityView[];
	claims: CurationClaimView[];
	table: Pick<CurationHostTable, "entities" | "entitySnapshot" | "claims">;
} {
	const refOf = new Map<string, string>();
	const entities = view.entities.map((entity, index): CurationEntityView => {
		const ref = `w${index + 1}`;
		refOf.set(entity.id, ref);
		return {
			ref,
			name: entity.displayName,
			aliases: entity.aliases.filter((alias) => alias !== entity.displayName),
		};
	});
	const claims: CurationClaimView[] = [];
	const table: CurationHostTable["claims"] = [];
	for (const entry of view.claims) {
		const payload = entry.assertion.payload;
		const subject = refOf.get(entry.subjectId);
		if (subject === undefined) continue;
		const ref = `c${claims.length + 1}`;
		claims.push({
			ref,
			subject,
			predicate: entry.predicate,
			value: valueOf(entry.assertion),
			relation:
				payload.kind === "relation"
					? {
							kind: payload.relation,
							object: refOf.get(payload.objectId) as string,
						}
					: null,
			status: entry.status === "active" ? "adopted" : entry.status,
			origin: entry.origin,
		});
		table.push({
			ref,
			id: entry.id,
			revision: entry.revision,
			subjectId: entry.subjectId,
			predicate: entry.predicate,
			kind: payload.kind,
		});
	}
	return {
		entities,
		claims,
		table: {
			entities: view.entities.map((entity, index) => ({
				ref: `w${index + 1}`,
				id: entity.id,
				revision: entity.revision,
			})),
			entitySnapshot: view.entities.map((entity): Entity =>
				ctx.entityOf(scope, entity),
			),
			claims: table,
		},
	};
}
