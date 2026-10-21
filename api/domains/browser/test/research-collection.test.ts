import { expect, test } from "bun:test";
import { ResearchCollection } from "../service/research-collection";
import type { Observation } from "../contracts";

const observation = (url = "https://example.org/results"): Observation => ({
	observationRef: crypto.randomUUID(),
	tabRef: crypto.randomUUID(),
	generation: 1,
	url,
	title: "結果",
	text: '- link "入門" [ref=e1]:\n  - /url: /watch/1\n- paragraph: 静的な説明',
	truncated: false,
	reasons: [],
	refCount: 1,
});
test("collect returns actual observed hrefs and non-actionable text across arbitrary sites", () => {
	for (const domain of [
		"youtube.com",
		"x.com",
		"instagram.com",
		"ja.wikipedia.org",
		"unknown.example",
	]) {
		const collection = new ResearchCollection();
		const seen = collection.observe(
			"task",
			observation(`https://${domain}/results`),
		);
		expect(seen.blocks).toHaveLength(2);
		expect(seen.links).toEqual([
			{ blockRef: "b1", title: "入門", url: `https://${domain}/watch/1` },
		]);
		const page = collection.collect(
			"task",
			{
				observationRef: seen.observationRef,
				blockRefs: ["b1", "b2"],
				linkBlockRefs: ["b1"],
				purpose: "candidates",
			},
			0,
		);
		expect(page.links[0]?.url).toBe(`https://${domain}/watch/1`);
		expect(page.text).toContain("静的な説明");
		expect(collection.read("task")).toHaveLength(0);
		collection.accept("task", page);
		expect(collection.read("task")).toHaveLength(1);
	}
});
test("the link inventory preserves observed item and collection links without classifying them", () => {
	const c = new ResearchCollection();
	const seen = c.observe("t", {
		...observation(),
		text: '- link "一覧" [ref=e1]:\n  - /url: /results\n- link "入門 A" [ref=e2]:\n  - /url: /entry/a\n- link "入門 B" [ref=e3]:\n  - /url: https://another.example/entry/b\n- link "unsafe" [ref=e4]:\n  - /url: javascript:alert(1)\n- link "credential" [ref=e5]:\n  - /url: https://user:secret@example.org/entry',
	});
	expect(seen.links).toEqual([
		{ blockRef: "b1", title: "一覧", url: "https://example.org/results" },
		{ blockRef: "b2", title: "入門 A", url: "https://example.org/entry/a" },
		{ blockRef: "b3", title: "入門 B", url: "https://another.example/entry/b" },
	]);
	const page = c.collect(
		"t",
		{
			observationRef: seen.observationRef,
			blockRefs: ["b2", "b3"],
			linkBlockRefs: ["b2", "b3"],
			purpose: "candidates",
		},
		0,
	);
	expect(page.links.map(({ title, url }) => ({ title, url }))).toEqual(
		seen.links!.slice(1).map(({ title, url }) => ({ title, url })),
	);
	for (const ref of ["b4", "b5"])
		expect(() =>
			c.collect(
				"t",
				{
					observationRef: seen.observationRef,
					blockRefs: [ref],
					linkBlockRefs: [ref],
					purpose: "candidates",
				},
				0,
			),
		).toThrow("observed_link_invalid");
	// An empty link selection is the observed current URL, never inferred individual item URLs.
	expect(
		c.collect(
			"t",
			{
				observationRef: seen.observationRef,
				blockRefs: ["b2"],
				linkBlockRefs: [],
				purpose: "candidates",
			},
			0,
		).links[0]!.url,
	).toBe(seen.url);
});
test("stale, invented, oversized and excess selections are refused without loss of accepted pages", () => {
	const c = new ResearchCollection(),
		seen = c.observe("t", observation());
	const args = {
		observationRef: seen.observationRef,
		blockRefs: ["b1"],
		linkBlockRefs: ["b1"],
		purpose: "candidates",
	};
	for (const patch of [
		{ observationRef: crypto.randomUUID() },
		{ blockRefs: ["b99"] },
		{ blockRefs: ["b1", "b1"] },
		{ linkBlockRefs: ["b2"] },
		{ text: "invented" },
	])
		expect(() => c.collect("t", { ...args, ...patch }, 0)).toThrow();
	c.accept("t", c.collect("t", args, 0));
	c.accept("t", c.collect("t", args, 0));
	expect(() => c.collect("t", args, 0)).toThrow("collection_capacity");
	c.clear("t");
	expect(c.read("t")).toEqual([]);
	const big = c.observe("t", {
		...observation(),
		text: "- paragraph: " + "あ".repeat(3000),
	});
	expect(() =>
		c.collect(
			"t",
			{
				...args,
				observationRef: big.observationRef,
				purpose: "facts",
				linkBlockRefs: [],
			},
			0,
		),
	).toThrow("collection_capacity");
});
test("guard attempts remain bounded even when no collection was accepted", () => {
	const c = new ResearchCollection();
	c.beginReview("t");
	c.beginReview("t");
	expect(() => c.beginReview("t")).toThrow("collection_review_budget");
	c.clear("t");
	expect(() => c.beginReview("t")).not.toThrow();
});

test("ARIA annotations are not link labels and quoted labels retain their actual text", () => {
	const seen = new ResearchCollection().observe("t", {
		...observation(),
		text: '- link [aria-hidden] [ref=e1] [cursor=pointer]:\n  - /url: /thumbnail\n- link "[Alpha] 入門" [ref=e2]:\n  - /url: /entry',
	});
	expect(seen.links).toEqual([
		{ blockRef: "b1", title: "", url: "https://example.org/thumbnail" },
		{ blockRef: "b2", title: "[Alpha] 入門", url: "https://example.org/entry" },
	]);
});
