import { expect, test } from "bun:test";
import {
	SNAPSHOT_MAX_BYTES,
	SNAPSHOT_MAX_DEPTH,
	SNAPSHOT_MAX_REFS,
} from "../contracts";
import { boundSnapshot, compactSnapshot } from "../service/observation";

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

test("collection compaction keeps deeply wrapped links actionable within the existing limits", () => {
	const wrappers = Array.from(
		{ length: 14 },
		(_, i) => `${"  ".repeat(i)}- generic [ref=e${i}]:`,
	);
	const link = `${"  ".repeat(14)}- link "entry" [ref=e99]:\n${"  ".repeat(15)}- /url: /entry`;
	const raw = [...wrappers, link, '- button "Next" [ref=e100]'].join("\n");
	expect(boundSnapshot(raw).refs).not.toContain("e99");
	const compact = compactSnapshot(raw);
	expect(compact).toBe(
		'- link "entry" [ref=e99]:\n  - /url: /entry\n- button "Next" [ref=e100]',
	);
	expect(boundSnapshot(compact)).toMatchObject({
		refs: ["e99", "e100"],
		truncated: false,
	});
	// Structurally meaningful groups still obey depth 12; compaction does not raise the limits.
	const groups = Array.from(
		{ length: 14 },
		(_, i) => `${"  ".repeat(i)}- group "part" [ref=e${i}]:`,
	).join("\n");
	expect(boundSnapshot(compactSnapshot(groups)).refs).not.toContain("e12");
});

test("compaction preserves named, stateful, interactive and text-bearing generic nodes", () => {
	const raw =
		'- generic "label" [ref=e1]:\n  - text: content\n- generic [ref=e2] [cursor=pointer]:\n  - text: action\n- generic [expanded] [ref=e3]:\n  - text: state\n- generic [ref=e4]:\n    continuation\nplain continuation';
	expect(compactSnapshot(raw)).toBe(raw);
	const wrapped =
		"- generic [ref=e0]:\n  - paragraph [ref=e5]:\nplain continuation";
	expect(compactSnapshot(wrapped)).toBe(
		"- paragraph [ref=e5]:\nplain continuation",
	);
});
