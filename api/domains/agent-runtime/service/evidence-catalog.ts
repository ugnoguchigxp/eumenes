import { ValidationFailure } from "../../../infrastructure/validation-log";
import { bytes } from "../../capabilities";
import type { Source } from "../../tool-runtime";
import { evidenceExcerpts } from "./evidence-excerpts";
import type { z } from "zod";
import type { researchReport } from "./research-contract";
const EVIDENCE_LIST_BYTES = 8192;
/** Upper bound of the presented materials (evidence list and observations).
 * Registration measures the same packet, including titles and URLs, so a
 * registered reference can always be presented again in later steps. */
export const MATERIAL_BYTES = 32768;
// Room kept for the packet keys and message framing.
const MATERIAL_RESERVE_BYTES = 512;
/** Task-scoped immutable references. Bodies remain in the tool vault; no durable copy. */
export class EvidenceCatalog {
	constructor(private structuredWeb = false) {}
	private documents = new Map<string, string>();
	private entries = new Map<
		string,
		{ source: Source; excerptId: string; quote: string; document: string }
	>();
	private identities = new Map<string, string>();
	/** World readings of one claim revision arrive as fresh Sources on every
	 * query; the first one seen stays the single registered source. */
	private worldSources = new Map<string, Source>();
	private unavailable = new Set<string>();
	full = false;
	copy() {
		const copy = new EvidenceCatalog(this.structuredWeb);
		copy.documents = new Map(this.documents);
		copy.entries = new Map(this.entries);
		copy.identities = new Map(this.identities);
		copy.worldSources = new Map(this.worldSources);
		copy.unavailable = new Set(this.unavailable);
		copy.full = this.full;
		return copy;
	}
	reconcile(sources: Source[]) {
		const current = new Set(
			sources.map((s) => `${s.sourceId}:${s.viewId ?? ""}`),
		);
		this.unavailable = new Set([
			...this.unavailable,
			...[...this.entries]
				.filter(
					([, e]) =>
						!current.has(`${e.source.sourceId}:${e.source.viewId ?? ""}`),
				)
				.map(([ref]) => ref),
		]);
	}
	document(reference: string) {
		const known = [...this.documents].find(([, alias]) => alias === reference);
		if (!known) throw new Error("invalid_tool_input");
		return known[0];
	}
	arguments(raw: unknown) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
		const args = { ...raw } as Record<string, unknown>;
		if (typeof args.sourceRef === "string")
			args.sourceRef = this.document(args.sourceRef);
		if (typeof args.messageRef === "string")
			args.messageRef = this.document(args.messageRef);
		return args;
	}
	/** The same World claim revision (same text) read again by a later query is
	 * the already registered source, so re-reading never spends catalog capacity.
	 * A registered source that is no longer present is replaced, not reused. */
	private canonical(source: Source, present: Set<string>) {
		if (
			(source.kind !== "world_claim" && source.kind !== "world_document") ||
			!source.sourceRef
		)
			return source;
		const key = JSON.stringify([
			source.kind,
			source.sourceRef,
			source.sourceRevision ?? null,
			source.scopeRef ?? null,
			source.viewDigest ?? null,
		]);
		const known = this.worldSources.get(key);
		if (known && present.has(`${known.sourceId}:${known.viewId ?? ""}`))
			return known;
		this.worldSources.set(key, source);
		return source;
	}
	observe(raw: Source[], limit = MATERIAL_BYTES) {
		const present = new Set(raw.map((s) => `${s.sourceId}:${s.viewId ?? ""}`));
		const sources = raw.map((s) => this.canonical(s, present));
		const budget = limit - MATERIAL_RESERVE_BYTES;
		const observations: Array<{ excerpts: unknown[] }> = [];
		const added: Array<{ reference: string; identity: string }> = [];
		// The same view can arrive from several operations; present it once, at
		// its latest position, so duplicates never consume the material bound.
		const last = new Map(
			sources.map((s, i) => [`${s.sourceId}:${s.viewId ?? ""}`, i]),
		);
		for (const [index, source] of sources.entries()) {
			if (last.get(`${source.sourceId}:${source.viewId ?? ""}`) !== index)
				continue;
			const metadata = {
				title: source.title,
				url: source.url,
				basis: source.basis,
				...(this.structuredWeb
					? {
							source: source.source,
							security: source.security,
							fetchedAt: source.fetchedAt,
						}
					: {}),
				speaker: source.speaker,
				createdAt: source.createdAt,
				origin: source.origin,
				truncated: source.truncated,
				acquisitionTruncated: source.acquisitionTruncated,
				previewTruncated: source.previewTruncated,
				start: source.start,
				end: source.end,
				nextCursor: source.nextCursor,
			};
			const key = source.sourceRef ?? source.messageRef ?? source.sourceId;
			let document = this.documents.get(key);
			if (!document) {
				document = `d${this.documents.size + 1}`;
				this.documents.set(key, document);
			}
			const excerpts: Array<{
				reference: string;
				quote: string;
				context?: string[];
			}> = [];
			const observation = () => ({
				...metadata,
				document,
				sourceRef: source.sourceRef ? document : undefined,
				messageRef: source.messageRef ? document : undefined,
				excerpts,
			});
			const all = evidenceExcerpts(
				source.body,
				this.structuredWeb && source.basis === "page",
			);
			for (const excerpt of all) {
				const context = excerpt.context?.flatMap((id) => {
					const ref = this.identities.get(
						`${source.sourceId}:${source.viewId ?? ""}:${id}`,
					);
					return ref ? [ref] : [];
				});
				const identity = `${source.sourceId}:${source.viewId ?? ""}:${excerpt.excerptId}`;
				let reference = this.identities.get(identity);
				if (!reference) {
					// Once capacity is reached no later excerpt is registered, so every
					// step re-presents exactly the references the model has already seen.
					if (this.full || this.entries.size >= 64) {
						this.full = true;
						break;
					}
					reference = `e${this.entries.size + 1}`;
					this.entries.set(reference, {
						source,
						excerptId: excerpt.excerptId,
						quote: excerpt.quote,
						document,
					});
					excerpts.push({
						reference,
						quote: excerpt.quote,
						...(context?.length ? { context } : {}),
					});
					if (
						bytes(this.list()) > EVIDENCE_LIST_BYTES ||
						bytes({
							evidence: this.list(),
							observations: [...observations, observation()],
						}) > budget
					) {
						excerpts.pop();
						this.entries.delete(reference);
						this.full = true;
						break;
					}
					this.identities.set(identity, reference);
					added.push({ reference, identity });
					continue;
				}
				excerpts.push({
					reference,
					quote: this.entries.get(reference)!.quote,
					...(context?.length ? { context } : {}),
				});
			}
			// A source without any excerpt (an empty page with a cursor) still
			// shows its metadata; one whose excerpts did not fit is withheld.
			if (
				excerpts.length ||
				(!all.length &&
					bytes({
						evidence: this.list(),
						observations: [...observations, observation()],
					}) <= budget)
			)
				observations.push(observation());
		}
		// A replayed observation may follow this step's new excerpts. Withdraw the
		// newest unpresented registrations until the whole packet fits.
		const packet = () => bytes({ evidence: this.list(), observations });
		while (added.length && packet() > budget) {
			const { reference, identity } = added.pop()!;
			this.entries.delete(reference);
			this.identities.delete(identity);
			this.full = true;
			for (const [index, o] of observations.entries()) {
				const at = o.excerpts.findIndex(
					(e) => (e as { reference: string }).reference === reference,
				);
				if (at < 0) continue;
				o.excerpts.splice(at, 1);
				if (!o.excerpts.length) observations.splice(index, 1);
				break;
			}
		}
		return observations as unknown[];
	}
	project(value: unknown): unknown {
		if (typeof value === "string") return this.documents.get(value) ?? value;
		if (Array.isArray(value)) return value.map((v) => this.project(v));
		if (value && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.filter(
						([k]) =>
							![
								"scopeRef",
								"messageId",
								"conversationId",
								"viewId",
								"digest",
								"revision",
								"viewDigest",
								"sourceId",
							].includes(k),
					)
					.map(([k, v]) => [k, this.project(v)]),
			);
		return value;
	}
	list() {
		return [...this.entries].map(([reference, e]) => ({
			reference,
			document: e.document,
			...(this.unavailable.has(reference) ? { available: false } : {}),
		}));
	}
	sources() {
		return [
			...new Map(
				[...this.entries]
					.filter(([ref]) => !this.unavailable.has(ref))
					.map(([, e]) => [
						`${e.source.sourceId}:${e.source.viewId ?? ""}`,
						e.source,
					]),
			).values(),
		];
	}
	verificationEvidence(refs: string[]) {
		return refs.map((reference) => {
			const e = this.entries.get(reference);
			if (this.unavailable.has(reference))
				throw new Error("evidence_invalidated");
			if (!e || !e.source.viewId)
				throw new ValidationFailure("invalid_evidence", [
					{
						validationPath: "report.evidence",
						validationCode: e ? "missing_view" : "unknown_evidence",
					},
				]);
			return {
				reference,
				quote: e.quote,
				sourceId: e.source.sourceId,
				viewId: e.source.viewId,
				sourceRevision: e.source.sourceRevision ?? e.source.revision ?? null,
				viewDigest: e.source.viewDigest ?? null,
				url: e.source.url ?? null,
				speaker: e.source.speaker ?? null,
				createdAt: e.source.createdAt ?? null,
			};
		});
	}
	canonicalEvidence(refs: string[]) {
		return this.verificationEvidence(refs).map((e) => ({
			sourceId: e.sourceId,
			viewId: e.viewId,
			quote: ["conversation_source", "world_claim", "world_document"].includes(
				this.entries.get(e.reference)!.source.kind ?? "",
			)
				? ""
				: e.quote,
		}));
	}
	referencedSources(refs: string[]) {
		this.verificationEvidence(refs);
		return [
			...new Map(
				refs.map((ref) => {
					const s = this.entries.get(ref)!.source;
					return [`${s.sourceId}:${s.viewId}`, s] as const;
				}),
			).values(),
		];
	}

	report(
		raw: Omit<z.infer<typeof researchReport>, "checks" | "externalRules"> &
			Partial<Pick<z.infer<typeof researchReport>, "checks" | "externalRules">>,
		exploration: string[],
	) {
		return {
			...raw,
			version: 2 as const,
			exploration,
			claims: raw.claims.map((c) => ({
				...c,
				evidence: c.evidence.map((ref, index) => {
					const e = this.entries.get(ref);
					if (this.unavailable.has(ref))
						throw new Error("evidence_invalidated");
					if (!e || !e.source.viewId)
						throw new ValidationFailure("invalid_evidence", [
							{
								validationPath: `report.claims.${raw.claims.indexOf(c)}.evidence.${index}`,
								validationCode: e ? "missing_view" : "unknown_evidence",
							},
						]);
					return {
						sourceId: e.source.sourceId,
						viewId: e.source.viewId,
						excerptId: e.excerptId,
					};
				}),
			})),
		};
	}
}
