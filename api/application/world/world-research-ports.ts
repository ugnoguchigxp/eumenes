import { documentReadings, documentsCurrent } from "./world-document-readings";
import type { Database } from "bun:sqlite";
import { buildProjection } from "eumenes-world-model";
import { listEntities, maxListEntities } from "eumenes-world-model/sqlite";
import type { AgentRuntime } from "../../domains/agent-runtime";
import type { Owner } from "../../domains/capabilities";
import { worldFind } from "../../domains/capabilities/contracts/world-query";
import { readActionOriginInTransaction } from "../../domains/dialogue";
import {
	createWorldQuery,
	createWorldDocuments,
	MIN_NAME_CHARS,
	normalizeTopicText,
	type WorldQueryContext,
	type WorldQueryResult,
	type WorldService,
} from "../../domains/world";
import { worldQueryToolSchema } from "../../domains/world/contracts/query";
import type { Source, ToolAdapter } from "../../domains/tool-runtime";
import {
	entityIdsOf,
	fit,
	sourceOf,
	summaryOf,
} from "./world-research-readings";
import { sha256Hex } from "../../infrastructure/digest";
import type { SqliteStore } from "../../infrastructure/sqlite";

/** Most claims one `world.query` hands the sub-agent as Sources. */
const MAX_READINGS = 24;
/** Bytes of all readings of one `world.query` (the tool result is capped at 32 KiB in all). */
const READINGS_BYTES = 24 * 1024;
/**
 * `world.find` notes. The sub-agent's operation list is bounded (4 KiB, oldest dropped, and an operation
 * that alone exceeds it empties the list), so the notes stay small; the targets come first.
 */
const FIND_BYTES = 1500;
const FIND_ENTITY_BYTES = 1100;
const MAX_FOUND_ENTITIES = 20;
const MAX_FOUND_GOALS = 3;
const MAX_ALIASES = 3;
const NAME_CHARS = 40;
const ALIAS_CHARS = 24;
const GOAL_CHARS = 60;
const DEFAULT_PURPOSE = "dialogue.read";

const bytesOf = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;
const normalize = normalizeTopicText;
const clip = (text: string, max: number) => {
	const chars = [...text.replace(/\s+/g, " ").trim()];
	return chars.length <= max
		? chars.join("")
		: chars.slice(0, max - 1).join("") + "…";
};
/** Names shorter than this identify nothing (the same bound as the names hint). */
const usableName = (name: string) => [...name].length >= MIN_NAME_CHARS;

/** The adopted goals of the Scope the sub-agent may name for `gaps` (host-bound principal and Scope). */
export type WorldResearchGoals = {
	adoptedForContextInTransaction(
		db: Database,
		access: { principal: string; scopeKeys: readonly string[] },
	): Array<{ goalId: string; desiredState: string }>;
};

export type WorldResearchPorts = Pick<
	ToolAdapter,
	| "operationFingerprintInTransaction"
	| "localInTransaction"
	| "validateEvidenceInTransaction"
> & {
	/** World is configured, ON and its gate is open. */
	available(db: Database): boolean;
};

/** A lifecycle that no longer supports a report. */
const ENDED = new Set(["retracted", "invalidated", "superseded"]);

const accessOf = (ctx: WorldQueryContext, scopeKey: string) => ({
	principal: ctx.principal,
	scopeKeys: [scopeKey],
	purpose: ctx.purpose ?? DEFAULT_PURPOSE,
});

function validateWorldEvidence(
	db: Database,
	owner: Owner,
	sources: Parameters<
		NonNullable<ToolAdapter["validateEvidenceInTransaction"]>
	>[2],
	world: WorldService,
	scopeOf: (
		db: Database,
		owner: Owner,
		stage: "read" | "adopt",
	) => { ctx: WorldQueryContext; scopeKey: string },
	now: () => number,
) {
	const claims = sources.filter((s) => s.kind === "world_claim");
	if (!claims.length) return true;
	try {
		const { ctx, scopeKey } = scopeOf(db, owner, "adopt");
		if (!world.statusInTransaction(db).usable) return false;
		const access = accessOf(ctx, scopeKey);
		const scope = { principal: ctx.principal, scopeKey };
		// Claims still readable per subject, from one source-resolving read each.
		const readable = new Map<string, Set<string>>();
		const readableOf = (subjectId: string) => {
			const known = readable.get(subjectId);
			if (known) return known;
			const read = world.readSnapshot(db, {
				access,
				scope,
				asOf: now(),
				focus: { subjectIds: [subjectId], depth: 0 },
			});
			const keys = new Set<string>();
			if (read.status === "ready") {
				const projection = buildProjection(
					{ contractVersion: 1, snapshot: read.snapshot },
					sha256Hex,
				);
				if (projection.ok)
					for (const e of projection.value.entries)
						keys.add(`${e.id}\u0000${e.revision}`);
			}
			readable.set(subjectId, keys);
			return keys;
		};
		return claims.every((s) => {
			// A claim forgotten, retracted or revised while the research ran must not support the report.
			if (s.scopeRef !== scopeKey || !s.sourceRef) return false;
			const history = world.readHistory(db, {
				access,
				scope,
				assertionId: s.sourceRef,
				limit: 1,
			});
			if (history.status !== "ready") return false;
			const latest = history.revisions[0];
			if (
				!latest ||
				String(latest.revision) !== s.sourceRevision ||
				ENDED.has(latest.lifecycle)
			)
				return false;
			// The history read checks the tombstone only. A forget is accepted (the utterance is retracted
			// and Memory excludes it) before World's own tombstone is written by the feed, so the claim is
			// also read through the source-resolving snapshot: a claim standing on a forgotten source is
			// not in it, and must not support the report in that window.
			return readableOf(latest.subjectId).has(
				`${latest.id}\u0000${latest.revision}`,
			);
		});
	} catch {
		return false;
	}
}

/** snapshot and gaps start from `entityIds`; one `entityId` there is read as that single start point. */
function startPointsOf(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const { mode, entityId, entityIds, ...rest } = raw as Record<string, unknown>;
	if (
		(mode === "snapshot" || mode === "gaps") &&
		typeof entityId === "string" &&
		entityIds === undefined
	)
		return { ...rest, mode, entityIds: [entityId] };
	return raw;
}

/** The live targets of the Scope (display name and aliases); `truncated`: more than one listing holds. */
function entitiesOf(
	world: WorldService,
	db: Database,
	ctx: WorldQueryContext,
	scopeKey: string,
) {
	const listed = listEntities(db, {
		contractVersion: 1,
		access: world.accessInTransaction(db, {
			access: accessOf(ctx, scopeKey),
		}),
		scopeKey,
		limit: maxListEntities,
	});
	if (listed.status !== "ready") throw new Error("world_unavailable");
	return { entities: listed.entities, truncated: listed.truncated };
}

/**
 * The ports of the World investigation (`world.find`, `world.query`): local reads of the host's own
 * World for the research sub-agent. The Scope and the purpose are bound by the host from the root
 * run's origin, never chosen by the model; every reading is a `world_claim` Source and is re-checked
 * when the report is adopted.
 */
export function createWorldResearchPorts(options: {
	store: SqliteStore;
	world: WorldService;
	/** Who asks: bound by the host to the conversation's principal and Scope. */
	context: () => WorldQueryContext;
	runtime: () => AgentRuntime;
	/** Adopted goals of the Scope; absent: `world.find` lists none. */
	goals?: WorldResearchGoals;
	now?: () => number;
}): WorldResearchPorts {
	const { store, world } = options;
	const query = createWorldQuery({ store, world, now: options.now });
	const documents = createWorldDocuments(store);
	const now = options.now ?? Date.now;

	/** The Scope of this task: refused unless the task belongs to a conversation run. */
	function scopeOf(db: Database, owner: Owner, stage: "read" | "adopt") {
		options.runtime().authorizeReadOwnerInTransaction(db, owner, stage);
		if (!readActionOriginInTransaction(db, owner.rootRunId))
			throw new Error("world_scope_unavailable");
		const ctx = options.context();
		const scopeKey = ctx.scopeKeys[0];
		if (scopeKey === undefined) throw new Error("world_scope_unavailable");
		return { ctx, scopeKey };
	}

	/** Display names of exactly these targets: the ones a result stands on are resolved by id, not from a capped listing. */
	function namesOf(
		db: Database,
		ctx: WorldQueryContext,
		scopeKey: string,
		ids: readonly string[],
	) {
		const names = new Map<string, string>();
		if (!ids.length) return names;
		const listed = listEntities(db, {
			contractVersion: 1,
			access: world.accessInTransaction(db, {
				access: accessOf(ctx, scopeKey),
			}),
			scopeKey,
			query: { ids },
			limit: maxListEntities,
		});
		if (listed.status !== "ready") throw new Error("world_unavailable");
		for (const e of listed.entities) names.set(e.id, e.displayName);
		return names;
	}

	function find(db: Database, owner: Owner, raw: unknown) {
		const { names } = worldFind.parse(raw);
		const { ctx, scopeKey } = scopeOf(db, owner, "read");
		if (!world.statusInTransaction(db).usable)
			throw new Error("world_unavailable");
		const wanted = [...new Set(names.map(normalize))].filter(usableName);
		const listing = entitiesOf(world, db, ctx, scopeKey);
		const rank = (entity: {
			displayName: string;
			aliases: readonly string[];
		}) => {
			const forms = [entity.displayName, ...entity.aliases].map(normalize);
			if (forms.some((f) => wanted.includes(f))) return 0;
			return forms.some((f) => wanted.some((w) => f.includes(w))) ? 1 : 2;
		};
		const matched = wanted.length
			? listing.entities
					.map((entity) => ({ entity, rank: rank(entity) }))
					.filter((m) => m.rank < 2)
					.sort((a, b) => a.rank - b.rank)
			: [];
		let cut = listing.truncated;
		const entities: Array<{ id: string; name: string; aliases: string[] }> = [];
		for (const { entity } of matched.slice(0, MAX_FOUND_ENTITIES)) {
			const next = {
				id: entity.id,
				name: clip(entity.displayName, NAME_CHARS),
				aliases: entity.aliases
					.slice(0, MAX_ALIASES)
					.map((a) => clip(a, ALIAS_CHARS)),
			};
			if (bytesOf({ entities: [...entities, next] }) > FIND_ENTITY_BYTES) break;
			entities.push(next);
		}
		if (entities.length < matched.length) cut = true;
		// A goal matches by the names asked for or by the display names of the targets found.
		const goalTerms = [
			...wanted,
			...entities.map((e) => normalize(e.name)),
		].filter(usableName);
		const goals: Array<{ id: string; desiredState: string }> = [];
		for (const g of options.goals?.adoptedForContextInTransaction(db, {
			principal: ctx.principal,
			scopeKeys: [scopeKey],
		}) ?? []) {
			const text = normalize(g.desiredState);
			if (!goalTerms.some((t) => text.includes(t))) continue;
			const next = {
				id: g.goalId,
				desiredState: clip(g.desiredState, GOAL_CHARS),
			};
			if (
				goals.length >= MAX_FOUND_GOALS ||
				bytesOf({ entities, goals: [...goals, next] }) > FIND_BYTES
			) {
				cut = true;
				break;
			}
			goals.push(next);
		}
		return {
			entities,
			goals,
			...(cut
				? {
						truncated: true,
						note: "候補が多いため一部だけを表示している。全体ではない。",
					}
				: {}),
		};
	}

	function run(db: Database, owner: Owner, raw: unknown) {
		const parsed = worldQueryToolSchema.safeParse(startPointsOf(raw));
		const observedAt = new Date(now()).toISOString();
		const base = { observedAt, hits: [], documents: [] };
		// The worker repairs its next call from the fields named here; a bare error makes it repeat the same input.
		if (!parsed.success)
			return {
				...base,
				failures: [{ url: "world", code: "invalid_input" }],
				notes: {
					invalidFields: [
						...new Set(
							parsed.error.issues.map((i) => i.path.join(".") || "(input)"),
						),
					].slice(0, 8),
					note: "入力が mode の要件に合っていない。各 mode が使う項目は world.query の説明のとおり（snapshot・gaps は entityIds の配列、relevance・influence・dependencies・scenarios は entityId）。",
				},
			};
		const { ctx, scopeKey } = scopeOf(db, owner, "read");
		const answered: WorldQueryResult = query.queryInTransaction(
			db,
			{ ...ctx, scopeKeys: [scopeKey] },
			parsed.data,
		);
		if (answered.status !== "ok")
			return {
				...base,
				failures: [{ url: "world", code: answered.code }],
			};
		const basis =
			answered.result.mode === "snapshot"
				? answered.result.entries
				: answered.basis;
		const names = namesOf(
			db,
			ctx,
			scopeKey,
			entityIdsOf(answered.result, basis),
		);
		const nameOf = (id: string) => names.get(id);
		const incomplete =
			answered.completeness !== "complete" || !!answered.basisTruncated;
		const readings: Source[] = [];
		let size = 0;
		let cutByLimit = false;
		let unnamed = 0;
		for (const claim of basis) {
			const reading = sourceOf(claim, scopeKey, observedAt, nameOf, incomplete);
			// A claim whose target has no resolvable name is not shown at all.
			if (!reading) {
				unnamed++;
				continue;
			}
			const next = size + bytesOf(reading);
			if (readings.length >= MAX_READINGS || next > READINGS_BYTES) {
				cutByLimit = true;
				break;
			}
			readings.push(reading);
			size = next;
		}
		const shown = new Set(readings.map((r) => r.sourceRef));
		const claimOf = (id: string) => (shown.has(id) ? id : undefined);
		const described = summaryOf(answered.result, nameOf, claimOf);
		const fitted = fit(described.summary);
		// Anything less than the whole answer makes every reading "truncated": the report's coverage is then partial.
		const partial =
			incomplete ||
			cutByLimit ||
			unnamed > 0 ||
			described.dropped > 0 ||
			fitted.truncated ||
			readings.some((r) => r.acquisitionTruncated);
		const marked = partial
			? readings.map((r) => ({
					...r,
					truncated: true,
					acquisitionTruncated: true,
				}))
			: readings;
		return {
			...base,
			failures: [],
			readings: marked,
			notes: {
				mode: answered.mode,
				completeness: partial ? "partial" : answered.completeness,
				reasons: answered.reasons,
				...(answered.basisTruncated || cutByLimit
					? { basisTruncated: true }
					: {}),
				...(unnamed + described.dropped > 0 ? { unnamedOmitted: true } : {}),
				summary: fitted.summary,
			},
		};
	}

	return {
		available: (db) =>
			db.inTransaction
				? world.statusInTransaction(db).usable
				: db.transaction(() => world.statusInTransaction(db).usable)(),
		operationFingerprintInTransaction(_db, r) {
			// The same names (in any order) are the same lookup; a query's arguments are canonical already.
			if (r.tool.id !== "world.find") return undefined;
			const parsed = worldFind.safeParse(r.arguments);
			if (!parsed.success) return undefined;
			return sha256Hex(
				JSON.stringify([
					"world.find",
					[...new Set(parsed.data.names.map(normalize))]
						.filter(usableName)
						.sort(),
				]),
			);
		},
		localInTransaction(db, r) {
			try {
				if (r.tool.id === "world.documents") {
					const { ctx, scopeKey } = scopeOf(db, r.owner, "read");
					if (!world.statusInTransaction(db).usable)
						throw new Error("world_unavailable");
					return {
						state: "succeeded",
						result: documentReadings(
							documents,
							db,
							{ principal: ctx.principal, scopeKey },
							r.arguments,
							now(),
						),
					};
				}
				if (r.tool.id === "world.find")
					return {
						state: "succeeded",
						result: {
							observedAt: new Date(now()).toISOString(),
							hits: [],
							documents: [],
							failures: [],
							notes: find(db, r.owner, r.arguments),
						},
					};
				return { state: "succeeded", result: run(db, r.owner, r.arguments) };
			} catch (e) {
				return {
					state: "failed",
					errorCode:
						e instanceof Error && /^[a-z_]+$/.test(e.message)
							? e.message
							: "local_read_failed",
				};
			}
		},
		validateEvidenceInTransaction: (db, owner, sources) => {
			try {
				if (sources.some((s) => s.kind === "world_document")) {
					const { ctx, scopeKey } = scopeOf(db, owner, "adopt");
					if (
						!world.statusInTransaction(db).usable ||
						!documentsCurrent(
							documents,
							db,
							{ principal: ctx.principal, scopeKey },
							sources,
						)
					)
						return false;
				}
				return validateWorldEvidence(db, owner, sources, world, scopeOf, now);
			} catch {
				return false;
			}
		},
	};
}
