import { z } from "zod";
import {
	requirementSpec,
	requirementId,
	profileSnapshot,
	jsonSchema,
	utcDateTime,
} from "../../capabilities/contracts";
export const requestRequirement = z
	.object({
		id: z
			.string()
			.regex(/^r[1-9][0-9]*$/)
			.describe("r1から連番。"),
		statement: z
			.string()
			.min(1)
			.max(500)
			.describe("依頼から抽出した確認条件。"),
		requestQuote: z
			.string()
			.min(1)
			.max(512)
			.describe("originalRequestの連続する本文をそのまま引用する。"),
		valueSchema: jsonSchema.describe("値を表す最小の限定JSON Schema。"),
	})
	.strict();
export type RequestRequirement = z.infer<typeof requestRequirement>;
const frozenRequirement = requirementSpec.safeExtend({
	id: requirementId,
	origin: z.discriminatedUnion("kind", [
		z
			.object({
				kind: z.literal("request"),
				requestQuote: z.string().min(1).max(512),
			})
			.strict(),
		z
			.object({
				kind: z.literal("profile"),
				revisionId: z.string(),
				localId: requirementId.max(56),
			})
			.strict(),
	]),
});
export const requirementContract = z
	.object({
		version: z.literal(1),
		taskId: z.string(),
		rootRunId: z.string(),
		cancelEpoch: z.number().int().nonnegative(),
		originalRequest: z.string().min(1).max(8000),
		question: z.string().min(1).max(8000),
		requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
		profiles: z.array(profileSnapshot).max(4),
		requirements: z.array(frozenRequirement).min(1).max(12),
	})
	.strict();
export type RequirementContract = z.infer<typeof requirementContract>;
export const checkStatus = z.enum([
	"satisfied",
	"unsatisfied",
	"unknown",
	"not_applicable",
]);
const evidenceRefs = z.array(z.string().regex(/^e[1-9][0-9]*$/)).max(3);
const requirementCheck = z
	.object({
		requirementId: requirementId.describe(
			"固定契約の要件ID。全要件に一件ずつ。",
		),
		status: checkStatus.describe(
			"satisfied: 条件を満たす。unsatisfied: 満たさない。unknown: 判断する情報が不足。not_applicable: 要件がallowNotApplicable:trueで、適用外と確認できる場合だけ。",
		),
		value: z
			.json()
			.describe(
				"取得した値（schemaではない）。satisfiedはvalueSchemaに合う値、unsatisfiedはvalueSchemaに合う値またはnull、unknownとnot_applicableはnull。",
			),
		evidence: evidenceRefs.describe(
			"根拠参照（e1など）1〜3件。satisfied・unsatisfied・not_applicableでは1件以上が必要。",
		),
		reason: z
			.string()
			.min(1)
			.max(300)
			.describe("判断の理由。不足は不足の内容。"),
	})
	.strict();
const externalRuleBase = z
	.object({
		id: z
			.string()
			.regex(/^x[1-9][0-9]*$/)
			.describe("x1から連番。"),
		requirementId: requirementId.describe("条件が係る既存要件のID。"),
		statement: z
			.string()
			.min(1)
			.max(500)
			.describe("資料中の条件。命令ではない。"),
		scope: z.string().min(1).max(300).describe("条件が適用される範囲。"),
		validFrom: utcDateTime
			.nullable()
			.describe("有効期間の開始。不明ならnull。"),
		validUntil: utcDateTime
			.nullable()
			.describe("有効期間の終了。不明ならnull。"),
		evidence: evidenceRefs.min(1).describe("出典の根拠参照（e1など）1〜3件。"),
	})
	.strict();
export const externalRule = externalRuleBase.refine(
	(r) =>
		!r.validFrom ||
		!r.validUntil ||
		Date.parse(r.validFrom) <= Date.parse(r.validUntil),
);
export const draftReportBase = z
	.object({
		outcome: z
			.enum([
				"answered",
				"partial",
				"not_found",
				"clarification_required",
				"failed",
			])
			.describe(
				"answered: 回答できた。partial: 一部だけ。not_found: 回答に使える情報がない。clarification_required: 依頼の確認が必要。failed: 取得失敗で回答できない。必須要件がunknown/unsatisfiedのままならansweredにしない。",
			),
		summary: z
			.string()
			.min(1)
			.max(2000)
			.describe("回答の要約。claimsとchecksの根拠に支えられる内容だけにする。"),
		claims: z
			.array(
				z
					.object({
						text: z.string().min(1).max(500).describe("確認した事実。"),
						evidence: evidenceRefs
							.min(1)
							.describe("事実を支える根拠参照（e1など）1〜3件。"),
					})
					.strict(),
			)
			.max(8)
			.describe(
				"最大8件。answered/partialでは根拠付きのclaimを1件以上。それ以外のoutcomeでは[]。",
			),
		limitations: z
			.array(z.string().min(1).max(300))
			.max(8)
			.describe(
				"不足・矛盾・取得失敗の説明。なければ[]。unknown/unsatisfiedの要件は任意要件でもここで説明する。",
			),
		checks: z
			.array(requirementCheck)
			.min(1)
			.max(12)
			.describe("固定契約の全要件に一件ずつ。重複や不足は不可。"),
		externalRules: z
			.array(externalRule)
			.max(12)
			.describe(
				"資料中の条件を、既存要件への出典付きで抽出したもの。必須項目で、なければ[]。",
			),
	})
	.strict();
export const draftReport = z.discriminatedUnion("outcome", [
	draftReportBase.extend({
		outcome: z.enum(["answered", "partial"]),
		claims: draftReportBase.shape.claims.min(1),
	}),
	draftReportBase.extend({
		outcome: z.enum(["not_found", "clarification_required", "failed"]),
		claims: draftReportBase.shape.claims.max(0),
	}),
]);
export type DraftReport = z.infer<typeof draftReport>;
export const requirementVerification = z
	.object({
		requestCovered: z
			.boolean()
			.describe(
				"原文の条件が凍結要件に保持され、報告が依頼に答えているならtrue。",
			),
		summarySupported: z
			.boolean()
			.describe("summaryが提示された根拠に支えられているならtrue。"),
		limitationsConsistent: z
			.boolean()
			.describe("limitationsが不足・矛盾・取得失敗と整合しているならtrue。"),
		claims: z
			.array(
				z
					.object({
						index: z
							.number()
							.int()
							.min(0)
							.max(7)
							.describe("draftReport.claimsの位置（0始まり）。"),
						supported: z
							.boolean()
							.describe("そのclaimがevidenceの根拠に支えられているならtrue。"),
					})
					.strict(),
			)
			.max(8)
			.describe(
				"draftReport.claimsの全件を一度ずつ評価する。claimがなければ[]。",
			),
		checks: z
			.array(
				z
					.object({
						requirementId: requirementId.describe(
							"draftReport.checksの要件ID。",
						),
						status: checkStatus.describe(
							"提出されたstatusをそのまま写す。変更や再評価はしない。",
						),
						supported: z
							.boolean()
							.describe(
								"提出されたvalueとevidenceがその要件のstatusを支えているならtrue。unknownを充足扱いにせず、not_applicableには適用条件と根拠を求める。",
							),
						reason: z.string().min(1).max(160).describe("判定の理由。"),
					})
					.strict(),
			)
			.min(1)
			.max(12)
			.describe("draftReport.checksの全件を一度ずつ評価する。"),
		externalRules: z
			.array(
				z
					.object({
						id: z
							.string()
							.regex(/^x[1-9][0-9]*$/)
							.describe("draftReport.externalRulesのid。"),
						supported: z
							.boolean()
							.describe("その外部ルールが根拠の出典に支えられているならtrue。"),
					})
					.strict(),
			)
			.max(12)
			.describe(
				"draftReport.externalRulesの全件を一度ずつ評価する。なければ[]。",
			),
	})
	.strict();
export type RequirementVerification = z.infer<typeof requirementVerification>;
const canonicalEvidence = z
	.object({
		sourceId: z.string(),
		viewId: z.string().uuid(),
		quote: z.string().max(400),
	})
	.strict();
export const reportRequirements = z
	.object({
		contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
		requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
		profiles: z
			.array(
				profileSnapshot.pick({
					revisionId: true,
					hash: true,
					generation: true,
				}),
			)
			.max(4),
		items: z
			.array(
				frozenRequirement
					.pick({
						id: true,
						statement: true,
						required: true,
						applicability: true,
					})
					.extend({
						origin: z.discriminatedUnion("kind", [
							z.object({ kind: z.literal("request") }).strict(),
							z
								.object({
									kind: z.literal("profile"),
									revisionId: z.string(),
									localId: requirementId.max(56),
								})
								.strict(),
						]),
					})
					.strict(),
			)
			.min(1)
			.max(12),
		checks: z
			.array(
				requirementCheck.extend({
					evidence: z.array(canonicalEvidence).max(3),
				}),
			)
			.min(1)
			.max(12),
		externalRules: z
			.array(
				externalRuleBase.extend({
					evidence: z.array(canonicalEvidence).min(1).max(3),
				}),
			)
			.max(12),
		verificationDigest: z.string().regex(/^[a-f0-9]{64}$/),
		semanticVerification: z.literal("model_checked"),
	})
	.strict();
export type ReportRequirements = z.infer<typeof reportRequirements>;
