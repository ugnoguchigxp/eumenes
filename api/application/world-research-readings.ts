import type { ConditionSpec } from "eumenes-world-model";
import { maxListEntities } from "eumenes-world-model/sqlite";
import { conditionText } from "../domains/world";
import type {
	WorldQueryBasis,
	WorldQueryPayload,
} from "../domains/world/contracts/query";
import type { Source } from "../domains/tool-runtime";
import { sha256Hex } from "../infrastructure/digest";

/** The operation list the sub-agent sees is bounded (4 KiB): the summary stays well inside it. */
const SUMMARY_BYTES = 2400;
const VALUE_CHARS = 120;
const CONDITION_CHARS = 100;
/** Collapse whitespace and cut to `max` characters; `cut` says whether text was lost. */
const clipped = (text: string, max: number) => {
	const chars = [...text.replace(/\s+/g, " ").trim()];
	return chars.length <= max
		? { text: chars.join(""), cut: false }
		: { text: chars.slice(0, max - 1).join("") + "…", cut: true };
};
const bytesOf = (value: unknown) =>
	new TextEncoder().encode(JSON.stringify(value)).length;

/** The relation kinds World stores, in plain words (the model never sees the stored identifiers). */
const RELATION_TEXT: Record<string, string> = {
	increases: "増やす",
	decreases: "減らす",
	causes: "引き起こす",
	enables: "可能にする",
	inhibits: "抑える",
	correlates_with: "相関がある",
	depends_on: "依存している",
	part_of: "一部である",
	serves_goal: "目標に資する",
	related_to: "関連がある",
};
const GAP_TEXT: Record<string, string> = {
	MISSING_RESOURCE: "必要なものの記録がない",
	RESOURCE_STATE_UNKNOWN: "使えるかどうかが分かっていない",
	CONDITION_UNKNOWN: "条件が分かっていない",
	MEASUREMENT_MISSING: "測定した値がない",
};
const EFFECT_TEXT: Record<string, string> = {
	increases: "増える",
	decreases: "減る",
	unknown: "分からない",
};
const DIRECTION_TEXT: Record<string, string> = {
	forward: "この対象が及ぼす影響",
	reverse: "この対象に及ぶ影響",
};
const OUTCOME_TEXT: Record<string, string> = {
	all_available: "依存するものはすべて使える",
	unsatisfied: "使えないものがある",
	unknown: "分からないものがある",
};
const STATE_TEXT: Record<string, string> = {
	available: "使える",
	unavailable: "使えない",
	unknown: "分からない",
};
const DEPENDENCY_WHY_TEXT: Record<string, string> = {
	RESOURCE_STATE_MISSING: "使えるかどうかの記録がない",
	CONDITION_UNKNOWN: "条件が分からない",
	EDGE_NOT_ADOPTED: "依存の記録が採用されていない",
};
const relationText = (kind: string) => RELATION_TEXT[kind] ?? "関連がある";

const ORIGIN_TITLE: Record<string, string> = {
	user_report: "本人の報告",
	model_hypothesis: "仮説",
	runtime_observation: "観測",
	document_claim: "文書の記述",
};
const ORIGIN_TEXT: Record<string, string> = {
	user_report: "本人の報告",
	model_hypothesis: "モデルの仮説（確認された事実ではない）",
	runtime_observation: "実行時の観測",
	document_claim: "文書の記述",
};
const STATUS_TEXT: Record<string, string> = {
	active: "採用済み",
	disputed: "異論あり",
	candidate: "候補（未採用）",
};
const FRESHNESS_TEXT: Record<string, string> = {
	fresh: "新しい",
	stale: "古くなっている",
	unknown: "不明",
};
/** A function from an entity id to its display name; undefined when the name cannot be resolved. */
export type NameOf = (id: string) => string | undefined;

/** Entity ids a query result and its claims mention (to resolve their names in one listing). */
export function entityIdsOf(
	payload: WorldQueryPayload,
	basis: readonly WorldQueryBasis[],
): string[] {
	const ids = new Set<string>();
	const ID_KEYS = new Set(["subjectId", "entityId", "objectId", "from", "to"]);
	const LIST_KEYS = new Set(["nodes", "unsatisfied", "unknown"]);
	const walk = (v: unknown, depth: number) => {
		if (depth > 8 || !v || typeof v !== "object") return;
		if (Array.isArray(v)) {
			for (const item of v) walk(item, depth + 1);
			return;
		}
		const record = v as Record<string, unknown>;
		for (const [k, x] of Object.entries(record)) {
			if (ID_KEYS.has(k) && typeof x === "string") ids.add(x);
			else if (LIST_KEYS.has(k) && Array.isArray(x))
				for (const item of x) if (typeof item === "string") ids.add(item);
		}
		if (
			record["kind"] === "entity" &&
			typeof record["id"] === "string" &&
			typeof record["entityId"] !== "string"
		)
			ids.add(record["id"]);
		for (const x of Object.values(record)) walk(x, depth + 1);
	};
	walk(payload, 0);
	for (const claim of basis) {
		ids.add(claim.subjectId);
		if (claim.relation) ids.add(claim.relation.objectId);
		const value = claim.value as
			| { kind?: string; entityId?: string }
			| undefined;
		if (value?.kind === "entity" && value.entityId) ids.add(value.entityId);
	}
	return [...ids].slice(0, maxListEntities);
}

/** The entity ids of one claim that its reading names (all must resolve for the reading to be written). */
function claimEntityIds(claim: WorldQueryBasis): string[] {
	const value = claim.value as { kind?: string; entityId?: string } | undefined;
	return [
		claim.subjectId,
		...(claim.relation ? [claim.relation.objectId] : []),
		...(value?.kind === "entity" && value.entityId ? [value.entityId] : []),
	];
}

function valueOf(
	value: unknown,
	nameOf: NameOf,
): { text: string; cut: boolean } {
	const v = value as
		| { kind?: string; value?: unknown; unit?: string; entityId?: string }
		| undefined;
	if (!v || typeof v !== "object") return clipped(String(value), VALUE_CHARS);
	if (v.kind === "entity")
		return { text: nameOf(v.entityId ?? "") ?? "", cut: false };
	if (v.kind === "number")
		return clipped(`${String(v.value)} ${v.unit ?? ""}`.trim(), VALUE_CHARS);
	return clipped(
		typeof v.value === "string" ? v.value : JSON.stringify(v.value),
		VALUE_CHARS,
	);
}

/**
 * One claim as a `world_claim` Source, or undefined when a name it needs cannot be resolved (the
 * reading would otherwise show an unnamed target). `truncated` / `acquisitionTruncated` say the text
 * of this claim (value, condition, predicate) was clipped or `incomplete` (the whole read was partial):
 * the report's coverage then becomes partial.
 */
export function sourceOf(
	claim: WorldQueryBasis,
	scopeKey: string,
	fetchedAt: string,
	nameOf: NameOf,
	incomplete = false,
): Source | undefined {
	if (claimEntityIds(claim).some((id) => nameOf(id) === undefined))
		return undefined;
	const subject = nameOf(claim.subjectId)!;
	const value = valueOf(claim.value, nameOf);
	const content = claim.relation
		? `関係: ${relationText(claim.relation.kind)}（相手: ${nameOf(claim.relation.objectId)!}）`
		: `値: ${value.text}`;
	const refutations = claim.refutations.length
		? `${claim.refutations.length}件`
		: "なし";
	const condition = clipped(
		conditionText(claim.condition as ConditionSpec),
		CONDITION_CHARS,
	);
	const predicate = clipped(claim.predicate, 60);
	const cut = (!claim.relation && value.cut) || condition.cut || predicate.cut;
	const freshness = String(claim.freshness);
	const body = [
		`対象: ${subject} / 項目: ${predicate.text} / ${content}`,
		`由来: ${ORIGIN_TEXT[claim.origin] ?? claim.origin}。状態: ${STATUS_TEXT[claim.status] ?? claim.status}。鮮度: ${FRESHNESS_TEXT[freshness] ?? "不明"}。条件: ${condition.text}。反証: ${refutations}。`,
	].join("\n");
	const truncated = cut || incomplete;
	return {
		kind: "world_claim",
		sourceId: crypto.randomUUID(),
		viewId: crypto.randomUUID(),
		viewDigest: sha256Hex(body),
		sourceRef: claim.id,
		sourceRevision: String(claim.revision),
		scopeRef: scopeKey,
		title: `Worldの記録（${ORIGIN_TITLE[claim.origin] ?? "記録"}）`,
		basis: "world",
		fetchedAt,
		truncated,
		...(truncated ? { acquisitionTruncated: true } : {}),
		origin: claim.origin,
		body,
	};
}

/**
 * The result in names (targets) and claim ids (which the sub-agent sees as document numbers, under
 * `document` / `documents`: never `claims`, which is the report's own field), in plain words. Items whose target names cannot be resolved are left out and counted in `dropped`.
 */
export function summaryOf(
	payload: WorldQueryPayload,
	nameOf: NameOf,
	claimOf: (id: string) => string | undefined,
): { summary: unknown; dropped: number } {
	let dropped = 0;
	const known = (id: string): string | undefined => {
		const name = nameOf(id);
		if (name === undefined) dropped++;
		return name;
	};
	const chain = (nodes: readonly string[]) => {
		const names = nodes.map(known);
		return names.every((n) => n !== undefined) ? names.join(" → ") : undefined;
	};
	const influence = (r: {
		direction: string;
		entityId: string;
		paths: ReadonlyArray<{
			nodes: readonly string[];
			edges: ReadonlyArray<{ id: string }>;
			effect: string;
			confirmed: boolean;
		}>;
		skipped: ReadonlyArray<{ edgeId: string; reasonCode: string }>;
		noPathMeaning?: string;
	}) => ({
		direction: DIRECTION_TEXT[r.direction] ?? "",
		from: known(r.entityId) ?? "",
		paths: r.paths.flatMap((p) => {
			const route = chain(p.nodes);
			return route === undefined
				? []
				: [
						{
							route,
							effect: EFFECT_TEXT[p.effect] ?? "分からない",
							...(p.confirmed ? {} : { note: "確認できていない経路" }),
							documents: p.edges
								.flatMap((e) => claimOf(e.id) ?? [])
								.slice(0, 3),
						},
					];
		}),
		...(r.skipped.length ? { skippedPaths: r.skipped.length } : {}),
		...(r.noPathMeaning
			? { noPath: "経路が見つからなかった（影響がないとは限らない）" }
			: {}),
	});
	const out = (summary: unknown) => ({ summary, dropped });
	switch (payload.mode) {
		case "snapshot":
			return out({ claims: payload.entries.length });
		case "relevance":
			return out({
				entity: known(payload.relevance.entityId) ?? "",
				related: payload.relevance.entities.flatMap((e) => {
					const name = known(e.entityId);
					return name === undefined ? [] : [{ name, distance: e.distance }];
				}),
				relations: payload.relevance.relations.flatMap((r) => {
					const from = known(r.from);
					const to = known(r.to);
					return from === undefined || to === undefined
						? []
						: [
								{
									from,
									to,
									relation: relationText(r.relation),
									document: claimOf(r.edgeId),
								},
							];
				}),
			});
		case "influence":
			return out(influence(payload.influence));
		case "dependencies": {
			const d = payload.dependencies;
			const names = (ids: readonly string[]) =>
				ids.flatMap((id) => known(id) ?? []);
			return out({
				entity: known(d.entityId) ?? "",
				outcome: OUTCOME_TEXT[d.outcome] ?? "分からないものがある",
				...(d.reasonCode
					? { note: "依存するものの記録がない（依存がないとは限らない）" }
					: {}),
				dependencies: d.dependencies.flatMap((item) => {
					const name = known(item.entityId);
					return name === undefined
						? []
						: [
								{
									name,
									depth: item.depth,
									state: STATE_TEXT[item.state] ?? "分からない",
									document: claimOf(item.viaEdgeId),
									...(item.reasonCode
										? { why: DEPENDENCY_WHY_TEXT[item.reasonCode] ?? "" }
										: {}),
								},
							];
				}),
				unsatisfied: names(d.unsatisfied),
				unknown: names(d.unknown),
				caution: "使えることは、成功を保証しない",
			});
		}
		case "scenarios": {
			const s = payload.scenarios;
			return out({
				hypothetical: "仮定の比較（保存されない）",
				baseline: influence(s.baseline),
				overlays: s.overlays.map((o) => ({
					overlayId: o.overlayId,
					...influence(o.influence),
					added: o.versusBaseline.added.length,
					removed: o.versusBaseline.removed.length,
					effectChanged: o.versusBaseline.effectChanged.length,
				})),
				comparison: {
					onlyA: s.comparison.onlyA.length,
					onlyB: s.comparison.onlyB.length,
					sameEffect: s.comparison.sameEffect.length,
					differentEffect: s.comparison.differentEffect.length,
				},
				quantitativeEffect: "量的な効果は計算されていない",
			});
		}
		case "gaps":
			return out({
				gaps: payload.gaps.gaps.flatMap((g) => {
					const subject = known(g.subjectId);
					const target =
						g.confirmWith.kind === "entity" ? known(g.confirmWith.id) : "";
					const confirmWith =
						target === undefined
							? undefined
							: g.confirmWith.kind === "entity"
								? { target }
								: { document: claimOf(g.confirmWith.id) };
					return subject === undefined || confirmWith === undefined
						? []
						: [
								{
									gap: GAP_TEXT[g.kind] ?? "分かっていないことがある",
									subject,
									document: claimOf(g.edgeId),
									confirmWith,
									blocksGoal: g.blocksGoal,
								},
							];
				}),
			});
	}
}

/** Cut the longest list in half until the structure fits; say so. */
export function fit(summary: unknown): {
	summary: unknown;
	truncated: boolean;
} {
	let cut = false;
	const longest = (value: unknown): unknown[] | null => {
		let best: unknown[] | null = null;
		const walk = (v: unknown) => {
			if (Array.isArray(v)) {
				if (v.length > 1 && (!best || v.length > best.length)) best = v;
				v.forEach(walk);
			} else if (v && typeof v === "object") Object.values(v).forEach(walk);
		};
		walk(value);
		return best;
	};
	while (bytesOf(summary) > SUMMARY_BYTES) {
		const list = longest(summary);
		if (!list) break;
		list.length = Math.ceil(list.length / 2);
		cut = true;
	}
	return {
		summary: cut ? { ...(summary as object), truncated: true } : summary,
		truncated: cut,
	};
}
