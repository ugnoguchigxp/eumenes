import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import provenance from "../../../vendor/interact/provenance.json";

const hash = (bytes: Uint8Array | string) =>
	createHash("sha256").update(bytes).digest("hex");

/** A fixed local release, including its manifest itself; never trusts a self-edited file inventory. */
export function loadInteractRelease() {
	const root = new URL("../", import.meta.resolve("eumenes-interact"));
	const manifestBytes = readFileSync(
		new URL("distribution-manifest.json", root),
	);
	if (hash(manifestBytes) !== provenance.distributionManifestSha256)
		throw new Error("interact_distribution_mismatch");
	const manifest = JSON.parse(manifestBytes.toString()) as {
		version: string;
		commit: string;
		skillSha256: string;
		sourceTreeSha256: string;
		contractVersion: number;
		coreFormatVersion: number;
		files: Record<string, string>;
	};
	if (
		manifest.version !== provenance.version ||
		manifest.commit !== provenance.sourceCommit ||
		manifest.sourceTreeSha256 !== provenance.sourceTreeSha256 ||
		manifest.skillSha256 !== provenance.skillSha256 ||
		manifest.contractVersion !== 3 ||
		manifest.coreFormatVersion !== 1
	)
		throw new Error("interact_distribution_mismatch");
	for (const [path, digest] of Object.entries(manifest.files)) {
		const target = new URL(path, root);
		if (
			!fileURLToPath(target).startsWith(fileURLToPath(root)) ||
			hash(readFileSync(target)) !== digest
		)
			throw new Error("interact_distribution_mismatch");
	}
	const bytes = readFileSync(new URL("dist/skills/browse.md", root));
	if (hash(bytes) !== manifest.skillSha256)
		throw new Error("interact_skill_mismatch");
	return {
		manifest,
		body: bytes
			.toString()
			.replace(/^---\n[\s\S]*?\n---\n/, "")
			.trim(),
		skill: {
			ref: "skill:browser.interact.operator@2",
			digest: `sha256:${hash(bytes)}`,
		},
	};
}
