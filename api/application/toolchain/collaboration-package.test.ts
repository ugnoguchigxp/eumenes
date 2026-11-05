import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
	coreContractVersion,
	supportedStateSchemaVersions,
} from "eumenes-collaboration";

const root = resolve(import.meta.dir, "../../..");
const hash = (body: Uint8Array) =>
	createHash("sha256").update(body).digest("hex");

test("the installed collaboration entry and all shipped resources match the reviewed archive", async () => {
	const archive = join(
		root,
		"vendor/collaboration/eumenes-collaboration-0.2.0-b407ecd8372b.tgz",
	);
	expect(hash(new Uint8Array(await Bun.file(archive).arrayBuffer()))).toBe(
		"52a7041f47cfafa148db132144d82a0f436c19bb9de4aedca6761b1e846fabbd",
	);
	const entry = Bun.resolveSync("eumenes-collaboration", root);
	expect(entry.startsWith(join(root, "node_modules") + "/")).toBe(true);
	const installed = dirname(dirname(entry));
	const manifest = await Bun.file(join(installed, "manifest.json")).json();
	expect(manifest.sourceCommit).toBe(
		"b407ecd8372b2718f05c23a2340e0483833a0296",
	);
	expect(manifest.sourceTreeDirty).toBe(false);
	expect(coreContractVersion).toBe(1);
	expect(supportedStateSchemaVersions).toContain(1);
	for (const [path, expected] of Object.entries(manifest.files)) {
		if (typeof expected !== "string") throw new Error("manifest_hash_invalid");
		if (path === "bun.lock" || path === "s11tnext.config.toml") continue;
		expect(
			hash(new Uint8Array(await Bun.file(join(installed, path)).arrayBuffer())),
		).toBe(expected);
	}
});
