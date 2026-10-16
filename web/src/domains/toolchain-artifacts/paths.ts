import type { JsonValue } from "./drafts";
import type { FieldChange } from "./drafts";

/**
 * The fixed document paths a registered field names: `$.a.b`, or an array element chosen by its
 * stable id, `$.resources[id=$target].voice`. Anything else is not a path (no index, no
 * expression), exactly as the backend adapter checks it.
 */
type Segment = { key: string; select: boolean };
const SEGMENT = /^([A-Za-z][A-Za-z0-9_]{0,40})(\[id=\$target\])?$/;

function parsePath(path: string): Segment[] | null {
	if (!path.startsWith("$.")) return null;
	const segments: Segment[] = [];
	for (const part of path.slice(2).split(".")) {
		const match = SEGMENT.exec(part);
		if (!match) return null;
		segments.push({ key: match[1]!, select: !!match[2] });
	}
	return segments;
}

type Node = { [key: string]: unknown };
const isNode = (value: unknown): value is Node =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Walks to the parent object of the last segment; undefined when any step is missing. */
function parentOf(
	document: unknown,
	segments: Segment[],
	target: string | undefined,
): Node | undefined {
	let node: unknown = document;
	for (const segment of segments.slice(0, -1)) {
		if (!isNode(node)) return undefined;
		node = node[segment.key];
		if (segment.select) {
			if (!Array.isArray(node)) return undefined;
			node = node.find((item) => isNode(item) && item.id === target);
		}
	}
	return isNode(node) ? node : undefined;
}

/** The value at a path, or undefined when absent. */
export function readPath(
	document: unknown,
	path: string,
	target?: string,
): JsonValue | undefined {
	const segments = parsePath(path);
	if (!segments) return undefined;
	const last = segments.at(-1)!;
	const parent = parentOf(document, segments, target);
	if (!parent || last.select) return undefined;
	const value = parent[last.key];
	return value === undefined ? undefined : (value as JsonValue);
}

/** Applies one change to a copy-owned document (the caller clones first). */
export function writePath(
	document: unknown,
	path: string,
	target: string | undefined,
	change: FieldChange,
): void {
	const segments = parsePath(path);
	if (!segments) return;
	const parent = parentOf(document, segments, target);
	if (!parent) return;
	const key = segments.at(-1)!.key;
	if ("unset" in change) delete parent[key];
	else parent[key] = change.value;
}
