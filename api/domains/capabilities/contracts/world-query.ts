import { z } from "zod";

/**
 * Input of the conversation agent's `world_query` tool. The world domain validates the same limits (its
 * `worldQueryToolSchema`; a test keeps every field equal): capabilities may not import the world domain.
 * `linkGaps` (turning a gap into a task) is not part of the model's vocabulary: it is an unknown key and is
 * rejected.
 */
const BUDGET = {
	causalDepth: 3,
	relevanceDepth: 4,
	entities: 30,
	relations: 60,
	paths: 10,
	candidates: 500,
	expansions: 500,
	presentationBytes: 8192,
};
const ID_BYTES = 256;
const MODES = [
	"snapshot",
	"relevance",
	"influence",
	"dependencies",
	"scenarios",
	"gaps",
] as const;
const START_POINTS = 10;
const FOCUS_DEPTH = 4;
const OVERLAY_EDGES = 100;
const OVERLAY_REMOVALS = 100;

const utf8 = (value: string) => new TextEncoder().encode(value).length;
const id = z
	.string()
	.min(1)
	.superRefine((value, ctx) => {
		if (utf8(value) > ID_BYTES)
			ctx.addIssue({
				code: "too_big",
				origin: "string",
				maximum: ID_BYTES,
				inclusive: true,
				input: value,
			});
	});
const bound = (max: number) => z.number().int().min(1).max(max);
const budget = z
	.strictObject({
		causalDepth: bound(BUDGET.causalDepth).optional(),
		relevanceDepth: bound(BUDGET.relevanceDepth).optional(),
		entities: bound(BUDGET.entities).optional(),
		relations: bound(BUDGET.relations).optional(),
		paths: bound(BUDGET.paths).optional(),
		candidates: z.number().int().min(2).max(BUDGET.candidates).optional(),
		expansions: z.number().int().min(2).max(BUDGET.expansions).optional(),
		presentationBytes: bound(BUDGET.presentationBytes).optional(),
	})
	.describe("読み取りの上限。通常は指定しない。");
const direction = z.enum(["forward", "reverse"]);
const overlay = z.strictObject({
	overlayId: id,
	addEdges: z.array(z.unknown()).max(OVERLAY_EDGES),
	removeEdgeIds: z.array(id).max(OVERLAY_REMOVALS),
});
const startPoints = z
	.array(id)
	.min(1)
	.max(START_POINTS)
	.refine((ids) => new Set(ids).size === ids.length);

/**
 * A tool offered to a model takes one flat object, so the modes share one object here and which fields a
 * mode needs is in the descriptions; the world domain's `worldQueryToolSchema` (a union by mode) is the
 * authority and the adapter checks the input against it.
 */
export const worldQuery = z.strictObject({
	mode: z
		.enum(MODES)
		.describe(
			"snapshot: 起点（entityIds、省略可）まわりの保存済みの主張を根拠つきで見る。relevance: entityIdに関係の深いもの。influence: entityIdを変えたときの影響。dependencies: entityIdの依存先。scenarios: 二つの仮定（overlays）の影響の比較。gaps: 調べる価値のある不足している情報。",
		),
	entityId: id
		.optional()
		.describe(
			"relevance・influence・dependencies・scenarios で必須。起点にする対象のID。hostが示した対象の一覧のIDだけを使い、作らない。",
		),
	entityIds: startPoints
		.optional()
		.describe(
			"snapshot・gaps の起点にする対象のID（任意、最大10件）。hostが示した対象の一覧のIDだけを使う。",
		),
	depth: z
		.number()
		.int()
		.min(0)
		.max(FOCUS_DEPTH)
		.optional()
		.describe("snapshot だけ。起点から辿る段数（0〜4）。"),
	direction: direction
		.optional()
		.describe(
			"influence・scenarios だけ。forward は起点が及ぼす影響（既定）、reverse は起点に及ぶ影響。",
		),
	goalId: id.optional().describe("gaps だけ。目標の範囲に絞るときのID。"),
	overlays: z
		.tuple([overlay, overlay])
		.optional()
		.describe(
			"scenarios で必須。比べる二つの仮定。保存されない。addEdgesは仮に足す関係、removeEdgeIdsは仮に外す関係のID。",
		),
	scopeKey: id.optional().describe("指定しない。利用者が求めたときだけ。"),
	budget: budget.optional(),
});
export type WorldQueryInput = z.infer<typeof worldQuery>;
