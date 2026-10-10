import { publicUrl } from "./public-url";
import { z } from "zod";
import { bytes, hash } from "./index";
export type JsonSchema = Record<string, unknown>;
export const jsonSchema = z.record(z.string(), z.unknown());
export const requirementId = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
export const requirementSpec = z
	.object({
		id: requirementId.max(56),
		statement: z.string().min(1).max(500),
		required: z.boolean(),
		applicability: z.string().min(1).max(300),
		allowNotApplicable: z.boolean(),
		valueSchema: jsonSchema,
	})
	.strict();
export const utcDateTime = z.iso.datetime();
export const requirementProfileData = z
	.object({
		version: z.literal(1),
		title: z.string().min(1).max(80),
		scope: z.string().min(1).max(300),
		requirements: z.array(requirementSpec).min(1).max(12),
		provenance: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("user") }).strict(),
			z
				.object({
					kind: z.literal("web"),
					url: publicUrl,
					retrievedAt: utcDateTime,
					contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
					scope: z.string().min(1).max(300),
					validFrom: utcDateTime.nullable(),
					validUntil: utcDateTime.nullable(),
				})
				.strict()
				.refine(
					(v) =>
						!v.validFrom ||
						!v.validUntil ||
						Date.parse(v.validFrom) <= Date.parse(v.validUntil),
				),
		]),
	})
	.strict()
	.refine(
		(v) =>
			new Set(v.requirements.map((r) => r.id)).size === v.requirements.length,
	)
	.refine((v) => bytes(v) <= 16384);
export type RequirementSpec = z.infer<typeof requirementSpec>;
export type RequirementProfileData = z.infer<typeof requirementProfileData>;
export const profileSnapshot = z
	.object({
		revisionId: z.string().min(1),
		hash: z.string().regex(/^[a-f0-9]{64}$/),
		generation: z.number().int().nonnegative(),
		data: requirementProfileData,
	})
	.strict();
export type ProfileSnapshot = z.infer<typeof profileSnapshot>;
export const profileDto = profileSnapshot
	.extend({
		id: z.string(),
		revision: z.number().int().positive(),
		enabled: z.boolean(),
		stateToken: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export type ProfileDto = z.infer<typeof profileDto>;
export type ProfilePage = { items: ProfileDto[]; nextCursor: string | null };
export type RequirementCatalog = {
	items: Array<{ ref: string; title: string; scope: string }>;
	snapshots: Record<string, ProfileSnapshot>;
};
function canonical(value: unknown): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (Array.isArray(value)) return value.map(canonical);
	if (
		value &&
		typeof value === "object" &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	)
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
		);
	throw new Error("invalid_requirement_data");
}
export const canonicalRequirementJson = (value: unknown) =>
	JSON.stringify(canonical(value));
export const hashRequirementData = (value: unknown) =>
	hash(canonicalRequirementJson(value));
export const errorStatus = {
	requirement_not_found: 404,
	requirement_conflict: 409,
	requirement_capacity_exceeded: 429,
	requirement_profile_invalidated: 409,
	invalid_requirement_profile: 400,
	invalid_requirement_schema: 400,
} as const;
