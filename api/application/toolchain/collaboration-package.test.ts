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
		"vendor/collaboration/eumenes-collaboration-0.4.0-ce0d56eedc6a.tgz",
	);
	expect(hash(new Uint8Array(await Bun.file(archive).arrayBuffer()))).toBe(
		"ce0d56eedc6ada0e67e8aff39daba2ae29caddb4e328c1041620135d2a12450c",
	);
	const entry = Bun.resolveSync("eumenes-collaboration", root);
	expect(entry.startsWith(join(root, "node_modules") + "/")).toBe(true);
	const installed = dirname(dirname(entry));
	const manifest = await Bun.file(join(installed, "manifest.json")).json();
	expect(manifest.sourceCommit).toBeNull();
	expect(manifest.sourceBaseCommit).toBe(
		"b03426226ef5ef6ead47c216a309bb48c2a420df",
	);
	expect(manifest.sourceTreeDirty).toBe(true);
	expect(manifest.sourceTreeDigest).toBe(
		"5240d54d9a68246cda2cf1fbd4edf08d9d00e95aadc858072b341e84eaf4a56c",
	);
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
