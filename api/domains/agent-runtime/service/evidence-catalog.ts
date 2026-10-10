import { ValidationFailure } from "../../../infrastructure/validation-log";
import { bytes } from "../../capabilities";
import type { Source } from "../../tool-runtime";
import { evidenceExcerpts } from "./evidence-excerpts";
import type { z } from "zod";
import type { researchReport } from "./research-contract";
/** Task-scoped immutable references. Bodies remain in the tool vault; no durable copy. */
export class EvidenceCatalog {
	private documents = new Map<string, string>();
	private entries = new Map<
		string,
		{ source: Source; excerptId: string; quote: string; document: string }
	>();
	private identities = new Map<string, string>();
	private unavailable = new Set<string>();
	full = false;
	copy() {
		const copy = new EvidenceCatalog();
		copy.documents = new Map(this.documents);
		copy.entries = new Map(this.entries);
		copy.identities = new Map(this.identities);
		copy.unavailable = new Set(this.unavailable);
		copy.full = this.full;
		return copy;
	}
	reconcile(sources: Source[]) {
		const current = new Set(
			sources.map((s) => `${s.sourceId}:${s.viewId ?? ""}`),
		);
		this.unavailable = new Set(
			[...this.entries]
				.filter(
					([, e]) =>
						!current.has(`${e.source.sourceId}:${e.source.viewId ?? ""}`),
				)
				.map(([ref]) => ref),
		);
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
	observe(sources: Source[]) {
		const observations: unknown[] = [];
		for (const [sourceIndex, source] of sources.entries()) {
			const key = source.sourceRef ?? source.messageRef ?? source.sourceId;
			let document = this.documents.get(key);
			if (!document) {
				document = `d${this.documents.size + 1}`;
				this.documents.set(key, document);
			}
			const excerpts = [];
			for (const excerpt of evidenceExcerpts(source.body)) {
				const identity = `${source.sourceId}:${source.viewId ?? ""}:${excerpt.excerptId}`;
				let reference = this.identities.get(identity);
				if (reference && sourceIndex !== sources.length - 1) continue;
				if (bytes(observations) + bytes(excerpts) + bytes(excerpt) > 11000) {
					break;
				}
				if (!reference) {
					if (this.entries.size >= 64) {
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
					if (bytes(this.list()) > 8192) {
						this.entries.delete(reference);
						this.full = true;
						break;
					}
					this.identities.set(identity, reference);
				}
				excerpts.push({ reference, quote: excerpt.quote });
			}
			const metadata = {
				title: source.title,
				url: source.url,
				basis: source.basis,
				speaker: source.speaker,
				createdAt: source.createdAt,
				truncated: source.truncated,
				acquisitionTruncated: source.acquisitionTruncated,
				previewTruncated: source.previewTruncated,
				start: source.start,
				end: source.end,
				nextCursor: source.nextCursor,
			};
			observations.push({
				...metadata,
				document,
				sourceRef: source.sourceRef ? document : undefined,
				messageRef: source.messageRef ? document : undefined,
				excerpts,
			});
		}
		return observations;
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
			preview: e.quote.slice(0, 24),
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
			quote:
				this.entries.get(e.reference)!.source.kind === "conversation_source"
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
