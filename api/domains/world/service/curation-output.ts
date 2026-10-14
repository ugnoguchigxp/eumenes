import { relationKinds } from "eumenes-world-model";
import { z } from "zod";
import {
	type CurationOutputClaim,
	type CurationOutputEntity,
	type CurationValue,
} from "./curation-types";

/** The model's answer is an object with the two lists; each element is judged on its own. */
export const curationOutputShapeSchema = z.object({
	entities: z.array(z.unknown()).default([]),
	claims: z.array(z.unknown()).default([]),
	changed: z.boolean().nullish(),
});

const text = (max: number) => z.string().trim().min(1).max(max);

const valueSchema = z.union([
	z.object({ type: z.literal("string"), value: z.string().max(4096) }),
	z.object({ type: z.literal("boolean"), value: z.boolean() }),
	z.object({
		type: z.literal("number"),
		value: z.number().finite(),
		unit: text(200),
	}),
]);

const entitySchema = z.object({
	name: text(200),
	aliases: z.array(text(200)).max(8).nullish(),
});

const claimSchema = z.object({
	op: z.enum(["assert", "correct", "retract"]),
	ref: z.string().min(1).nullish(),
	subject: z.string().trim().min(1).max(200).nullish(),
	predicate: text(256).nullish(),
	value: valueSchema.nullish(),
	relation: z
		.object({
			kind: z.enum(relationKinds as unknown as [string, ...string[]]),
			object: z.string().trim().min(1).max(200),
		})
		.nullish(),
	evidence: z.string().min(1),
	origin: z.enum(["user_report", "model_hypothesis"]),
	validFrom: z.string().nullish(),
	validUntil: z.string().nullish(),
});

export function parseEntity(raw: unknown): CurationOutputEntity | null {
	const parsed = entitySchema.safeParse(raw);
	if (!parsed.success) return null;
	const aliases = [
		...new Set((parsed.data.aliases ?? []).map((a) => a.normalize("NFC"))),
	].filter((alias) => alias !== parsed.data.name.normalize("NFC"));
	return { name: parsed.data.name.normalize("NFC"), aliases };
}

export function parseClaim(raw: unknown): CurationOutputClaim | null {
	const parsed = claimSchema.safeParse(raw);
	if (!parsed.success) return null;
	const d = parsed.data;
	return {
		op: d.op,
		ref: d.ref ?? null,
		subject: d.subject ?? null,
		// A relation's kind is its predicate: a model that leaves the predicate empty still means the relation.
		predicate: d.predicate ?? (d.relation ? d.relation.kind : null),
		value: (d.value ?? null) as CurationValue | null,
		relation: (d.relation ?? null) as CurationOutputClaim["relation"],
		evidence: d.evidence,
		origin: d.origin,
		validFrom: d.validFrom ?? null,
		validUntil: d.validUntil ?? null,
	};
}

// --- time ---------------------------------------------------------------------------

type Precision = "day" | "month" | "year";
const COARSENESS: Record<Precision, number> = { day: 0, month: 1, year: 2 };
const FORM = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** The UTC interval a written date can fall in, [earliest, latest). null when it is not a date. */
function boundOf(
	written: string,
): { precision: Precision; earliest: number; latest: number } | null {
	const m = FORM.exec(written);
	if (!m) return null;
	const year = Number(m[1]);
	const month = m[2] === undefined ? undefined : Number(m[2]);
	const day = m[3] === undefined ? undefined : Number(m[3]);
	if (year < 1 || (month !== undefined && (month < 1 || month > 12)))
		return null;
	const at = (y: number, mo: number, d: number) => Date.UTC(y, mo, d);
	if (month === undefined)
		return {
			precision: "year",
			earliest: at(year, 0, 1),
			latest: at(year + 1, 0, 1),
		};
	if (day === undefined)
		return {
			precision: "month",
			earliest: at(year, month - 1, 1),
			latest: at(year, month, 1),
		};
	const start = at(year, month - 1, day);
	// 2026-02-31 is no date: the day must survive the round trip.
	if (new Date(start).getUTCDate() !== day) return null;
	return { precision: "day", earliest: start, latest: start + 86_400_000 };
}

/**
 * The claim's valid time from the written bounds: a period whose precision is the coarser of the
 * two, `original` the text as written. `undefined` means none was given; `null` an unusable one.
 */
export function validTimeOf(
	validFrom: string | null,
	validUntil: string | null,
):
	| undefined
	| null
	| {
			kind: "period";
			precision: Precision;
			original: string;
			start?: { earliest: number; latest: number };
			end?: { earliest: number; latest: number };
	  } {
	if (validFrom === null && validUntil === null) return undefined;
	const from = validFrom === null ? undefined : boundOf(validFrom);
	const until = validUntil === null ? undefined : boundOf(validUntil);
	if (from === null || until === null) return null;
	const precisions = [from, until].flatMap((b) => (b ? [b.precision] : []));
	const precision = precisions.reduce<Precision>(
		(a, b) => (COARSENESS[b] > COARSENESS[a] ? b : a),
		"day",
	);
	if (from && until && from.earliest >= until.latest) return null;
	return {
		kind: "period",
		precision,
		original: `${validFrom ?? ""}..${validUntil ?? ""}`,
		...(from
			? { start: { earliest: from.earliest, latest: from.latest } }
			: {}),
		...(until
			? { end: { earliest: until.earliest, latest: until.latest } }
			: {}),
	};
}
