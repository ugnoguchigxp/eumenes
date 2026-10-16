import type { Database } from "bun:sqlite";
import {
	buildProjection,
	type ProjectionEntry,
	type ScopeRef,
} from "eumenes-world-model";
import { listEntities } from "eumenes-world-model/sqlite";
import { sha256Hex } from "../../../infrastructure/digest";
import { clipChars } from "./budget";
import type { WorldService } from "../../world";
import { mentions } from "./relevance";
import type { StepEnv } from "./types";

/** The most the model is shown of World when a request or a goal may need to name it. */
const WORLD_VIEW_ENTITIES = 30;
const WORLD_VIEW_CLAIMS = 30;
const PER_WORD = 5;
/** Entities read in one listing (World's own cap), to find the ones the texts name whatever their letter case or width. */
const LISTED_ENTITIES = 500;
const MAX_WORDS = 20;
const CLAIM_TEXT_CHARS = 160;

type WorldRef = {
	kind: "entity" | "claim";
	id: string;
	/** A claim: the entities it is about (its subject and its relation object). */
	entityIds?: string[];
};
export type WorldView = {
	/** `w1`... -> entity id, `k1`... -> claim id. The ids never reach the model. */
	refs: Record<string, WorldRef>;
	entities: Array<{ ref: string; name: string; aliases: string[] }>;
	claims: Array<{ ref: string; text: string }>;
};

const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
const TOO_SHORT = /^[\p{Script=Hiragana}\p{Script=Katakana}\p{ASCII}]$/u;
function wordsOf(texts: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const text of texts)
		for (const part of segmenter.segment(text)) {
			if (!part.isWordLike) continue;
			const word = part.segment.normalize("NFC").trim();
			if (word === "" || [...word].length > 64 || TOO_SHORT.test(word))
				continue;
			seen.add(word);
			if (seen.size >= MAX_WORDS) return [...seen];
		}
	return [...seen];
}

type Listed = {
	id: string;
	displayName: string;
	aliases: readonly string[];
};

function valueText(entry: ProjectionEntry): string | null {
	const payload = entry.assertion.payload;
	if (payload.kind !== "value") return null;
	const value = payload.value;
	switch (value.kind) {
		case "string":
			return value.value;
		case "boolean":
			return value.value ? "はい" : "いいえ";
		case "number":
			return `${value.value}${value.unit}`;
		default:
			return null;
	}
}

/**
 * The read side the steward needs of World: its entities and claims as short refs, for the steps that let the model
 * name them (a forget request's `resolve.refs`, the entities a goal concerns). Bounded, and chosen by the words of
 * `texts` first (an entity whose name starts with one of them), then by the newest claims. null: World can not
 * answer now. Built over World's public read API only.
 */
export type WorldViewReader = (
	db: Database,
	texts: readonly string[],
	nowMs: number,
) => WorldView | null;

export function createWorldView(options: {
	service: Pick<WorldService, "readSnapshot" | "accessInTransaction">;
	/** `AccessContext.purpose` of the reads: one the conversation source adapter allows. */
	purpose: string;
	scope: ScopeRef;
}): WorldViewReader {
	return (db, texts, nowMs) => viewOf(options, db, texts, nowMs);
}

function viewOf(
	world: {
		service: Pick<WorldService, "readSnapshot" | "accessInTransaction">;
		purpose: string;
		scope: ScopeRef;
	},
	db: Database,
	texts: readonly string[],
	nowMs: number,
): WorldView | null {
	const { scope } = world;
	const access = {
		principal: scope.principal,
		scopeKeys: [scope.scopeKey],
		purpose: world.purpose,
	};
	const read = world.service.readSnapshot(db, {
		access,
		scope,
		asOf: nowMs,
	});
	if (read.status !== "ready") return null;
	const projection = buildProjection(
		{ contractVersion: 1, snapshot: read.snapshot },
		(bytes) => sha256Hex(bytes),
	);
	if (!projection.ok) return null;
	const entryAccess = world.service.accessInTransaction(db, { access });
	const list = (
		query: { aliasPrefix?: string; ids?: readonly string[] },
		limit: number,
	) => {
		const result = listEntities(db, {
			contractVersion: 1,
			access: entryAccess,
			scopeKey: scope.scopeKey,
			query,
			limit,
		});
		return result.status === "ready"
			? (result.entities as readonly Listed[])
			: null;
	};

	const newest = [...projection.value.entries].sort(
		(a, b) =>
			b.assertion.recordedAt - a.assertion.recordedAt ||
			a.id.localeCompare(b.id),
	);
	const picked = new Map<string, Listed>();
	// Entities whose name or alias the texts contain, compared folded (NFKC, case-insensitive): World's alias lookup
	// is a case-sensitive prefix match, which misses "larm" for LARM.
	const said = texts.join(" ");
	for (const entity of list({}, LISTED_ENTITIES) ?? []) {
		if (picked.size >= WORLD_VIEW_ENTITIES) break;
		if ([entity.displayName, ...entity.aliases].some((n) => mentions(said, n)))
			picked.set(entity.id, entity);
	}
	for (const word of wordsOf(texts)) {
		if (picked.size >= WORLD_VIEW_ENTITIES) break;
		const found = list({ aliasPrefix: word }, PER_WORD);
		for (const entity of found ?? []) {
			if (picked.size >= WORLD_VIEW_ENTITIES) break;
			picked.set(entity.id, entity);
		}
	}
	if (picked.size < WORLD_VIEW_ENTITIES) {
		const recent = [...new Set(newest.map((entry) => entry.subjectId))]
			.filter((id) => !picked.has(id))
			.slice(0, WORLD_VIEW_ENTITIES);
		const found = recent.length > 0 ? list({ ids: recent }, recent.length) : [];
		if (found === null) return null;
		for (const entity of found) {
			if (picked.size >= WORLD_VIEW_ENTITIES) break;
			picked.set(entity.id, entity);
		}
	}
	const claims = newest
		.filter((entry) => picked.has(entry.subjectId))
		.slice(0, WORLD_VIEW_CLAIMS);
	// The objects of the shown relations are named too, so a claim can be read.
	const objectIds = [
		...new Set(
			claims.flatMap((entry) =>
				entry.assertion.payload.kind === "relation" &&
				!picked.has(entry.assertion.payload.objectId)
					? [entry.assertion.payload.objectId]
					: [],
			),
		),
	];
	const objects =
		objectIds.length > 0 ? list({ ids: objectIds }, objectIds.length) : [];
	if (objects === null) return null;
	const names = new Map<string, string>();
	for (const entity of [...picked.values(), ...objects])
		names.set(entity.id, entity.displayName);

	const refs: WorldView["refs"] = {};
	const entities: WorldView["entities"] = [];
	for (const entity of picked.values()) {
		const ref = `w${entities.length + 1}`;
		refs[ref] = { kind: "entity", id: entity.id };
		entities.push({
			ref,
			name: entity.displayName,
			aliases: entity.aliases.filter((alias) => alias !== entity.displayName),
		});
	}
	const shown: WorldView["claims"] = [];
	for (const entry of claims) {
		const subject = names.get(entry.subjectId);
		if (subject === undefined) continue;
		const payload = entry.assertion.payload;
		let text: string | null;
		if (payload.kind === "relation") {
			const object = names.get(payload.objectId);
			text =
				object === undefined
					? null
					: `${subject} ${payload.relation} ${object}`;
		} else {
			const value = valueText(entry);
			text =
				value === null ? null : `${subject} の ${entry.predicate}: ${value}`;
		}
		if (text === null) continue;
		const ref = `k${shown.length + 1}`;
		refs[ref] = {
			kind: "claim",
			id: entry.id,
			entityIds: [
				entry.subjectId,
				...(payload.kind === "relation" ? [payload.objectId] : []),
			],
		};
		shown.push({ ref, text: clipChars(text, CLAIM_TEXT_CHARS) });
	}
	return { refs, entities, claims: shown };
}

/** World's refs for a step, or null when World is off or can not answer. */
export function describeWorld(
	env: StepEnv,
	texts: readonly string[],
): WorldView | null {
	return env.deps.world?.view(env.db, texts, env.deps.nowMs()) ?? null;
}
