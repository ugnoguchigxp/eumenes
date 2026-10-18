import {
	SNAPSHOT_MAX_BYTES,
	SNAPSHOT_MAX_DEPTH,
	SNAPSHOT_MAX_REFS,
} from "../contracts";

export type BoundedSnapshot = {
	text: string;
	truncated: boolean;
	reasons: ("bytes" | "depth" | "refs")[];
	/** The element refs that appear in `text`; nothing else may be acted on. */
	refs: string[];
};

const REF = /\[ref=([A-Za-z0-9_-]+)\]/g;
const encoder = new TextEncoder();

/**
 * Cuts an ARIA snapshot at whole-node boundaries (a node is a `- ` line with its continuation lines).
 * Nodes are taken in document order until the byte or ref budget would be exceeded; nodes deeper than
 * the depth limit are left out with their subtrees. Whole text stays in memory only.
 */
export function boundSnapshot(
	snapshot: string,
	limits = {
		bytes: SNAPSHOT_MAX_BYTES,
		depth: SNAPSHOT_MAX_DEPTH,
		refs: SNAPSHOT_MAX_REFS,
	},
): BoundedSnapshot {
	const nodes: { level: number; lines: string[] }[] = [];
	for (const raw of snapshot.split("\n")) {
		const line = raw.replace(/\r$/, "").replace(/\t/g, "  ");
		if (!line.trim()) continue;
		const trimmed = line.trimStart();
		const last = nodes.at(-1);
		if (trimmed.startsWith("- ") || !last)
			nodes.push({
				level: Math.floor((line.length - trimmed.length) / 2),
				lines: [line],
			});
		else last.lines.push(line);
	}
	const kept: string[] = [];
	const refs: string[] = [];
	const reasons = new Set<"bytes" | "depth" | "refs">();
	let bytes = 0;
	for (const node of nodes) {
		if (node.level >= limits.depth) {
			reasons.add("depth");
			continue;
		}
		const text = node.lines.join("\n");
		const size = encoder.encode(text).length + 1;
		const found = [...text.matchAll(REF)].map((m) => m[1]!);
		if (bytes + size > limits.bytes) {
			reasons.add("bytes");
			break;
		}
		if (refs.length + found.length > limits.refs) {
			reasons.add("refs");
			break;
		}
		kept.push(text);
		refs.push(...found);
		bytes += size;
	}
	return {
		text: kept.join("\n"),
		truncated: reasons.size > 0,
		reasons: [...reasons],
		refs,
	};
}
