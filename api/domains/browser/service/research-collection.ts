import { z } from "zod";
import type { Observation } from "../contracts";
import { snapshotNodes } from "./observation";

export const collectInput = z.strictObject({
	observationRef: z.uuid(),
	blockRefs: z
		.array(z.string().regex(/^b[1-9][0-9]*$/))
		.min(1)
		.max(80),
	purpose: z.enum(["candidates", "facts"]),
	linkBlockRefs: z.array(z.string().regex(/^b[1-9][0-9]*$/)).max(5),
});
export type CollectedPage = {
	collectionRef: string;
	observationRef: string;
	url: string;
	title: string;
	text: string;
	purpose: "candidates" | "facts";
	fetchedAt: string;
	links: { reference: string; url: string; title: string; text: string }[];
};
const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** Ephemeral observed material. Models select host refs; they never supply text or URLs. */
export class ResearchCollection {
	private latest = new Map<string, Observation>();
	private reviews = new Map<string, number>();
	private pages = new Map<string, CollectedPage[]>();
	observe(taskId: string, observation: Observation) {
		const blocks = snapshotNodes(observation.text).map((node, i) => ({
			blockRef: `b${i + 1}`,
			text: node.lines.join("\n"),
		}));
		const links = blocks.flatMap((block) => {
			try {
				return [
					{
						blockRef: block.blockRef,
						...observedLink(block.text, observation.url),
					},
				];
			} catch {
				return [];
			}
		});
		const current = { ...observation, blocks, links };
		this.latest.set(taskId, current);
		return current;
	}
	collect(taskId: string, raw: unknown, now: number): CollectedPage {
		const input = collectInput.parse(raw),
			observation = this.latest.get(taskId);
		if (!observation || observation.observationRef !== input.observationRef)
			throw new Error("observation_stale");
		const blocks = observation.blocks!;
		const refs = new Set(input.blockRefs);
		if (
			refs.size !== input.blockRefs.length ||
			input.linkBlockRefs.some((ref) => !refs.has(ref))
		)
			throw new Error("collection_ref_invalid");
		const selected = input.blockRefs.map((ref) => {
			const block = blocks.find((b) => b.blockRef === ref);
			if (!block) throw new Error("collection_ref_invalid");
			return block;
		});
		const links = input.linkBlockRefs.map((ref) => {
			const text = selected.find((b) => b.blockRef === ref)!.text;
			return {
				reference: crypto.randomUUID(),
				...observedLink(text, observation.url),
				text,
			};
		});
		const page: CollectedPage = {
			collectionRef: crypto.randomUUID(),
			observationRef: observation.observationRef,
			url: observation.url,
			title: observation.title,
			text: selected.map((b) => b.text).join("\n"),
			purpose: input.purpose,
			links,
			fetchedAt: new Date(now).toISOString(),
		};
		// A visited result page can itself be returned as a candidate when no href was exposed.
		if (input.purpose === "candidates" && !links.length)
			page.links = [
				{
					reference: crypto.randomUUID(),
					url: page.url,
					title: page.title,
					text: page.text,
				},
			];
		const previous = this.pages.get(taskId) ?? [];
		if (
			previous.length >= 2 ||
			size(page) > 8192 ||
			size([...previous, page]) > 16384 ||
			previous.reduce((n, p) => n + p.links.length, 0) + page.links.length > 5
		)
			throw new Error("collection_capacity");
		return structuredClone(page);
	}
	accept(taskId: string, page: CollectedPage) {
		const current = this.latest.get(taskId);
		if (current?.observationRef !== page.observationRef)
			throw new Error("observation_stale");
		this.pages.set(taskId, [
			...(this.pages.get(taskId) ?? []),
			structuredClone(page),
		]);
	}
	beginReview(taskId: string) {
		const count = this.reviews.get(taskId) ?? 0;
		if (count >= 2) throw new Error("collection_review_budget");
		this.reviews.set(taskId, count + 1);
	}
	current(taskId: string) {
		const o = this.latest.get(taskId);
		return o ? { tabRef: o.tabRef, observationRef: o.observationRef } : null;
	}
	read(taskId: string) {
		return structuredClone(this.pages.get(taskId) ?? []);
	}
	clear(taskId: string, all = true) {
		this.latest.delete(taskId);
		this.reviews.delete(taskId);
		if (all) this.pages.delete(taskId);
	}
}

/** The driver's observed ARIA href and label, shared by presentation and collection. */
function observedLink(text: string, base: string) {
	const href = text.match(/^\s*- \/url: (.+)$/m)?.[1];
	if (!href) throw new Error("observed_link_missing");
	const url = new URL(href, base);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password
	)
		throw new Error("observed_link_invalid");
	return { url: url.href, title: linkTitle(text) };
}

/** Decode the driver's link label, keeping ARIA control metadata out of user-facing titles. */
function linkTitle(text: string) {
	const quoted = text.match(/^\s*- link ("(?:[^"\\]|\\.)*")/);
	if (quoted) {
		try {
			return String(JSON.parse(quoted[1]!)).slice(0, 200);
		} catch {}
	}
	return text
		.split("\n")[0]!
		.replace(/^\s*- link\s*/, "")
		.replace(/\s*\[ref=[^\]]+\].*$/, "")
		.replace(/\s*\[[^\]]*\]/g, "")
		.replace(/:\s*$/, "")
		.trim()
		.slice(0, 200);
}
