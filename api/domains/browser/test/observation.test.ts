import { expect, test } from "bun:test";
import {
	SNAPSHOT_MAX_BYTES,
	SNAPSHOT_MAX_DEPTH,
	SNAPSHOT_MAX_REFS,
} from "../contracts";
import { boundSnapshot } from "../service/observation";

test("the limits are 32 KiB, depth 12 and 200 refs", () => {
	expect(SNAPSHOT_MAX_BYTES).toBe(32768);
	expect(SNAPSHOT_MAX_DEPTH).toBe(12);
	expect(SNAPSHOT_MAX_REFS).toBe(200);
});

test("a small snapshot passes whole with its refs", () => {
	const text = '- main [ref=e1]:\n  - button "Go" [ref=e2]\n  - text: hi';
	const r = boundSnapshot(text);
	expect(r.truncated).toBe(false);
	expect(r.text).toBe(text);
	expect(r.refs).toEqual(["e1", "e2"]);
});

test("the cut falls between whole nodes and only refs in the text are actionable", () => {
	const lines = Array.from(
		{ length: 4000 },
		(_, i) => `- link "item ${i}" [ref=e${i}]`,
	);
	const r = boundSnapshot(lines.join("\n"));
	expect(r.truncated).toBe(true);
	expect(r.reasons).toContain("refs");
	expect(r.refs).toHaveLength(SNAPSHOT_MAX_REFS);
	expect(r.text.split("\n")).toHaveLength(SNAPSHOT_MAX_REFS);
	expect(r.text.endsWith("[ref=e199]")).toBe(true);
	expect(r.refs).not.toContain("e200");
});

test("the byte limit counts UTF-8 and never cuts inside a node", () => {
	const lines = Array.from(
		{ length: 2000 },
		(_, i) => `- text: ${"あ".repeat(30)} ${i}`,
	);
	const r = boundSnapshot(lines.join("\n"));
	expect(r.truncated).toBe(true);
	expect(r.reasons).toEqual(["bytes"]);
	expect(new TextEncoder().encode(r.text).length).toBeLessThanOrEqual(
		SNAPSHOT_MAX_BYTES,
	);
	for (const line of r.text.split("\n")) expect(line).toMatch(/ \d+$/);
});

test("a node's continuation lines stay with it", () => {
	const r = boundSnapshot(
		"- paragraph [ref=e1]:\n    wrapped text\n- button [ref=e2]",
		{ bytes: 40, depth: 12, refs: 200 },
	);
	expect(r.text).toBe("- paragraph [ref=e1]:\n    wrapped text");
	expect(r.refs).toEqual(["e1"]);
	expect(r.reasons).toEqual(["bytes"]);
});

test("nodes deeper than the limit are left out with their subtree", () => {
	const deep = Array.from(
		{ length: 14 },
		(_, d) => `${"  ".repeat(d)}- generic [ref=e${d}]`,
	);
	const r = boundSnapshot([...deep, "- button [ref=e99]"].join("\n"));
	expect(r.reasons).toEqual(["depth"]);
	expect(r.refs).toContain("e11");
	expect(r.refs).not.toContain("e12");
	expect(r.refs).toContain("e99");
});
