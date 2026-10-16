import { expect, test } from "bun:test";
import {
	compare,
	initialScripts,
	RATCHET_NOTICE,
	TOLERANCE,
} from "./bundle-budget";

const html = `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-AAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/react-BBB.js">
<link rel="modulepreload" crossorigin href="/assets/query-CCC.js">
<link rel="stylesheet" crossorigin href="/assets/index-DDD.css">
</head><body></body></html>`;

test("the initial scripts are the module entry and its modulepreload chunks", () => {
	expect(initialScripts(html)).toEqual({
		entry: "assets/index-AAA.js",
		preloaded: ["assets/react-BBB.js", "assets/query-CCC.js"],
	});
});

test("an index.html without exactly one module entry is rejected", () => {
	expect(() => initialScripts("<html></html>")).toThrow();
	expect(() =>
		initialScripts(
			'<script type="module" src="/a.js"></script><script type="module" src="/b.js"></script>',
		),
	).toThrow();
});

test("growth within the tolerance passes and growth beyond it fails", () => {
	const baseline = { entryGzip: 100_000, initialGzip: 250_000 };
	expect(
		compare(
			{
				entryGzip: Math.floor(100_000 * (1 + TOLERANCE)),
				initialGzip: 250_000,
			},
			baseline,
		).failures,
	).toEqual([]);
	const over = compare({ entryGzip: 103_000, initialGzip: 260_000 }, baseline);
	expect(over.failures).toHaveLength(2);
});

test("a build that shrinks well below the baseline asks to ratchet", () => {
	const baseline = { entryGzip: 100_000, initialGzip: 250_000 };
	const shrunk = compare(
		{
			entryGzip: Math.floor(100_000 * (1 - RATCHET_NOTICE)) - 1,
			initialGzip: 250_000,
		},
		baseline,
	);
	expect(shrunk.failures).toEqual([]);
	expect(shrunk.notices).toHaveLength(1);
});
