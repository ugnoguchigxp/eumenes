import { createHash } from "node:crypto";
import type { AcquiredBody, BodyOwner } from "./saved-bodies";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export type BodyGrant = {
	owner: BodyOwner;
	body: string;
	operationId: string;
	sourceId: string;
	sourceRevision: string;
	expires: number;
	readUntil: number;
};
export function createBodyStorage(
	now: () => number,
	limits: { count: number; total: number },
) {
	type Body = AcquiredBody & {
		points: string[];
		digest: string;
		bytes: number;
		expires: number;
		deliveries: Set<string>;
	};
	const bodies = new Map<string, Body>(),
		deliveries = new Map<string, string[]>();
	function pruneBodies(active?: Set<string>) {
		for (const [id, b] of bodies)
			if (
				b.expires <= now() ||
				(active && !b.deliveries.size && !active.has(id))
			)
				bodies.delete(id);
	}
	function stage(operationId: string, documents: AcquiredBody[]) {
		pruneBodies();
		const ids: string[] = [];
		for (const doc of documents) {
			const text = Array.from(doc.text.replaceAll("\r\n", "\n"))
				.slice(0, 64000)
				.join("");
			let bounded = "",
				size = 0;
			for (const c of text) {
				const n = Buffer.byteLength(c);
				if (size + n > 262144) break;
				bounded += c;
				size += n;
			}
			const id = sha(
				JSON.stringify([
					doc.url,
					doc.fetchedAt,
					bounded,
					doc.acquisitionTruncated,
				]),
			);
			const existing = bodies.get(id);
			if (existing) {
				existing.deliveries.add(operationId);
				ids.push(id);
				continue;
			}
			if (
				bodies.size >= limits.count ||
				[...bodies.values()].reduce((a, b) => a + b.bytes, 0) + size >
					limits.total
			)
				continue;
			bodies.set(id, {
				...doc,
				text: bounded,
				acquisitionTruncated:
					doc.acquisitionTruncated ||
					bounded !== doc.text.replaceAll("\r\n", "\n"),
				points: Array.from(bounded),
				digest: sha(bounded),
				bytes: size,
				expires: now() + 900000,
				deliveries: new Set([operationId]),
			});
			ids.push(id);
		}
		deliveries.set(operationId, ids);
	}

	return {
		bodies,
		deliveries,
		stage,
		pruneBodies,
		deliveryText(operationId: string, url: string) {
			pruneBodies();
			for (const id of deliveries.get(operationId) ?? []) {
				const b = bodies.get(id);
				if (b?.url === url) return b.text;
			}
			return undefined;
		},
	};
}

export type SavedPositionInput = {
	sourceRef: string;
	query?: string;
	cursor?: string;
	characters?: number;
};
export function savedFingerprint(
	owner: BodyOwner,
	input: SavedPositionInput,
	kind: string,
	lookup: (owner: BodyOwner, ref: string) => { g: { sourceRevision: string } },
	cursors: Map<string, { sourceRef: string; position: number }>,
) {
	const { g } = lookup(owner, input.sourceRef);
	const position = input.cursor ? cursors.get(input.cursor) : undefined;
	if (input.cursor && position?.sourceRef !== input.sourceRef)
		throw new Error("source_cursor_invalid");
	return sha(
		JSON.stringify([
			kind,
			g.sourceRevision,
			position?.position ?? 0,
			kind === "web.find"
				? input.query?.normalize("NFKC").toLowerCase()
				: undefined,
			input.characters ?? 2400,
		]),
	);
}
