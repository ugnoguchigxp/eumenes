// P0 fixture for source collection and a shared, per-work debounced watcher.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import {
	lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
	rmSync, symlinkSync, watch, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const sourceLimits = { files: 1024, perFile: 16 * 1024 ** 2, total: 64 * 1024 ** 2 };

function ignored(name: string) {
	return name.startsWith(".env") || [".git", ".eumenes", "dist", "node_modules"].includes(name);
}

function collect(root: string, fixedVersion: string, limits = sourceLimits) {
	const filenames: string[] = [];
	let bytes = 0;
	function visit(file: string) {
		const info = lstatSync(file);
		if (info.isSymbolicLink()) throw new Error("symbolic_link_outside_fixture_scope");
		if (info.isDirectory()) {
			for (const child of readdirSync(file).sort()) {
				if (!ignored(child)) visit(join(file, child));
			}
			return;
		}
		if (!info.isFile() || info.size > limits.perFile || filenames.length >= limits.files ||
			bytes + info.size > limits.total)
			throw new Error("snapshot_limit_exceeded");
		bytes += info.size;
		filenames.push(file);
	}
	for (const entry of ["prototype.json", "src", "assets"]) visit(join(root, entry));
	filenames.sort();
	const hash = createHash("sha256");
	function field(value: Buffer) {
		const length = Buffer.alloc(8);
		length.writeBigUInt64BE(BigInt(value.byteLength));
		hash.update(length).update(value);
	}
	field(Buffer.from(fixedVersion));
	for (const file of filenames) {
		field(Buffer.from(relative(root, file)));
		field(readFileSync(file));
	}
	return { paths: filenames.map((file) => relative(root, file)), digest: hash.digest("hex") };
}

const temp = realpathSync(mkdtempSync(join(tmpdir(), "works-source-")));
const first = join(temp, "a");
const second = join(temp, "b");
const protectedFile = join(temp, "external.txt");
const watchers = new Map<string, ReturnType<typeof watch>>();
const timers = new Map<string, NodeJS.Timeout>();
try {
	for (const work of [first, second]) {
		mkdirSync(join(work, "src"), { recursive: true });
		mkdirSync(join(work, "assets"));
		writeFileSync(join(work, "prototype.json"), "{}");
		writeFileSync(join(work, "src", "main.ts"), "export const value = 1;");
		writeFileSync(join(work, "src", ".env"), "fixture ignored");
	}
	writeFileSync(protectedFile, "outside fixture");
	const indirect = join(first, "assets", "escaped");
	symlinkSync(protectedFile, indirect);
	assert.throws(() => collect(first, "1.0"), /symbolic_link/);
	rmSync(indirect);
	const tooLarge = join(first, "assets", "large.txt");
	writeFileSync(tooLarge, Buffer.alloc(sourceLimits.perFile + 1));
	assert.throws(() => collect(first, "1.0"), /snapshot_limit/);
	rmSync(tooLarge);
	assert.throws(() => collect(first, "1.0", { ...sourceLimits, files: 1 }), /snapshot_limit/);
	assert.throws(() => collect(first, "1.0", { ...sourceLimits, total: 3 }), /snapshot_limit/);
	const before = collect(first, "1.0");
	assert.deepEqual(before.paths, ["prototype.json", "src/main.ts"]);
	assert.notEqual(collect(first, "1.1").digest, before.digest);

	const settled: { work: string; digest: string }[] = [];
	const changed = Promise.withResolvers<void>();
	function open(work: string) {
		watchers.set(work, watch(work, { recursive: true }, (_, name) => {
			if (typeof name !== "string" || name.split(sep).some(ignored)) return;
			clearTimeout(timers.get(work));
			timers.set(work, setTimeout(() => {
				timers.delete(work);
				settled.push({ work, digest: collect(work, "1.0").digest });
				changed.resolve();
			}, 100));
		}));
	}
	function close(work: string) {
		watchers.get(work)?.close();
		watchers.delete(work);
		clearTimeout(timers.get(work));
		timers.delete(work);
	}
	open(first);
	open(second);
	writeFileSync(join(first, "src", "main.ts"), "export const value = 2;");
	writeFileSync(join(first, "src", "main.ts"), "export const value = 3;");
	const signal = AbortSignal.timeout(3_000);
	await Promise.race([
		changed.promise,
		new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
	]);
	await Bun.sleep(150);
	assert.equal(settled.length, 1);
	assert.deepEqual(settled[0], { work: first, digest: collect(first, "1.0").digest });
	assert.notEqual(settled[0]?.digest, before.digest);
	close(first);
	close(second);
	assert.equal(watchers.size + timers.size, 0);
	console.log(JSON.stringify({
		ignoredFilesExcluded: true,
		outsideLinkAndOversizedInputRejected: true,
		fileCountAndTotalLimitRejected: true,
		compiledInputIdentityIncludesFixedVersion: true,
		consecutiveWritesCoalesced: true,
		unmodifiedWorkNotRefreshed: true,
		watchHandlesReleased: true,
	}, null, 2));
} finally {
	for (const watcher of watchers.values()) watcher.close();
	for (const timer of timers.values()) clearTimeout(timer);
	rmSync(temp, { recursive: true, force: true });
}
