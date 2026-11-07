import { readFileSync, writeFileSync } from "node:fs";
import { loadInteractRelease } from "../api/application/browser/interact-release";
const release = loadInteractRelease();
const target = new URL(
	"../api/domains/browser/contexts/interact/skill.context.toml",
	import.meta.url,
);
const expected = `# Generated from the pinned eumenes-interact release; edit the upstream Skill, then synchronize.\n# sha256: ${release.manifest.skillSha256}\ntext = '''\n${release.body}\n'''\n`;
if (process.argv.includes("--check")) {
	if (readFileSync(target, "utf8") !== expected)
		throw new Error("interact_skill_generation_stale");
} else writeFileSync(target, expected);
console.log("interact Skill matches the pinned distribution");

const bundlePath = new URL(
	"../api/domains/capabilities/bundles/browser-interact.bundle.json",
	import.meta.url,
);
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const operator = bundle.definitions.find(
	(d: { kind: string; id: string; revision: number }) =>
		d.kind === "skill" &&
		d.id === "browser.interact.operator" &&
		d.revision === 2,
);
if (!operator) throw new Error("interact_operator_skill_missing");
if (process.argv.includes("--check")) {
	if (operator.body !== release.body)
		throw new Error("interact_skill_generation_stale");
} else {
	operator.body = release.body;
	writeFileSync(bundlePath, JSON.stringify(bundle, null, "\t") + "\n");
}
