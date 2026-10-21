import type { Source } from "../../tool-runtime";

/** Task-local identities of acquired links. Snippets never become body evidence. */
export class CandidateCatalog {
	private entries = new Map<string, Source>();
	private identities = new Map<string, string>();
	private live = new Set<string>();
	copy() {
		const copy = new CandidateCatalog();
		copy.entries = new Map(this.entries);
		copy.identities = new Map(this.identities);
		copy.live = new Set(this.live);
		return copy;
	}
	observe(sources: Source[]) {
		this.live.clear();
		for (const source of sources) {
			if (source.basis !== "snippet" || !source.url) continue;
			const identity = `${source.sourceId}:${source.viewId ?? ""}`;
			let reference = this.identities.get(identity);
			if (!reference) {
				reference = `c${this.entries.size + 1}`;
				this.identities.set(identity, reference);
				this.entries.set(reference, source);
			}
			if (this.live.size < 5) this.live.add(reference);
		}
		return [...this.live].slice(0, 5).map((reference) => {
			const source = this.source(reference);
			const url = new URL(source.url!);
			return {
				reference,
				title: source.title.slice(0, 80),
				place: `${url.hostname}${url.pathname}`.slice(0, 160),
				snippet: source.body.slice(0, 80),
				provider: source.source?.provider,
			};
		});
	}
	source(reference: string) {
		const source = this.entries.get(reference);
		if (!source || !this.live.has(reference))
			throw new Error("candidate_invalidated");
		return source;
	}
	results(references: string[]) {
		if (new Set(references).size !== references.length)
			throw new Error("duplicate_candidate");
		return references.map((reference) => {
			const source = this.source(reference);
			return {
				reference,
				sourceId: source.sourceId,
				url: source.url!,
				title: source.title.slice(0, 200),
				fetchedAt: source.fetchedAt,
				provider: source.source?.provider,
				contentStatus: "unverified" as const,
			};
		});
	}
}
