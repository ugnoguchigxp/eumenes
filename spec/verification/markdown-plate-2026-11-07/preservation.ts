import { mkdir, writeFile } from "node:fs/promises";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMath from "remark-math";
import { fixtures } from "./fixtures";
import { roundTrip } from "./plate";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter).use(remarkMath);
// Resolve reference syntax to its meaning, while retaining title/URL/alt and linebreaks.
function canonical(text: string) {
	const tree = parser.parse(text);
	const definitions = new Map<string, any>();
	function collect(node: any) {
		if (node.type === "definition") definitions.set(node.identifier, node);
		for (const child of node.children ?? []) collect(child);
	}
	collect(tree);
	function clean(node: any): any {
		if (Array.isArray(node)) return node.filter(n => n?.type !== "definition").map(clean);
		if (!node || typeof node !== "object") return node;
		if (["linkReference", "imageReference"].includes(node.type)) {
			const definition = definitions.get(node.identifier);
			if (definition) return clean({ type: node.type === "linkReference" ? "link" : "image", url: definition.url, title: definition.title, ...(node.type === "imageReference" ? { alt: node.alt } : { children: node.children }) });
		}
		return Object.fromEntries(Object.entries(node).filter(([key]) => !["position"].includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, clean(value)]));
	}
	return clean(tree);
}
const directory = `${import.meta.dir}/results`;
const configuration = process.argv.includes("--classic") ? "classic" : process.argv.includes("--flat") ? "flat" : "kit";
await mkdir(directory, { recursive: true });
const results = [];
for (const fixture of fixtures) {
	try {
		const first = roundTrip(fixture.text, configuration), second = roundTrip(first.markdown, configuration);
		const before = canonical(fixture.text), after = canonical(first.markdown);
		const result = { id: fixture.id, group: fixture.group, byteEqual: fixture.text === first.markdown, astEqual: JSON.stringify(before) === JSON.stringify(after), stableSecondRound: first.markdown === second.markdown, input: fixture.text, output: first.markdown, before, after, value: first.value };
		results.push(result);
		console.log(JSON.stringify({ id: result.id, group: result.group, byteEqual: result.byteEqual, astEqual: result.astEqual, stableSecondRound: result.stableSecondRound }));
	} catch (error) {
		results.push({ id: fixture.id, group: fixture.group, astEqual: false, error: error instanceof Error ? error.message : "unknown" });
	}
}
await writeFile(`${directory}/preservation-${configuration}.json`, JSON.stringify(results, null, 2) + "\n");
const summary = { total: results.length, core: results.filter(r => r.group === "core").length, coreFailures: results.filter(r => r.group === "core" && !r.astEqual).map(r => r.id), extendedFailures: results.filter(r => r.group === "extended" && !r.astEqual).map(r => r.id) };
await writeFile(`${directory}/preservation-${configuration}-summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
if (summary.coreFailures.length) process.exitCode = 1;
