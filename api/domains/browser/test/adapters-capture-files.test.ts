import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCaptureFiles } from "../adapters/capture-files";

const roots: string[] = [];
function setup() {
	const root = mkdtempSync(join(tmpdir(), "eumenes-browser-files-"));
	roots.push(root);
	const directory = join(root, "captures");
	return { root, directory, files: createCaptureFiles({ directory }) };
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

const bytes = (...values: number[]) => new Uint8Array(values);

test("write, adopt, read and remove follow the capture id only", async () => {
	const { directory, files } = setup();
	const temp = await files.writeTemp("cap_01-A", bytes(1, 2, 3));
	expect(temp).toBe("cap_01-A.tmp");
	expect(await files.listTemp()).toEqual(["cap_01-A.tmp"]);
	expect(Array.from(await files.read(temp))).toEqual([1, 2, 3]);
	const ref = await files.adopt(temp, "cap_01-A");
	expect(ref).toBe("cap_01-A.webp");
	expect(await files.listTemp()).toEqual([]);
	expect(await files.listAdopted()).toEqual(["cap_01-A.webp"]);
	expect(readdirSync(directory)).toEqual(["cap_01-A.webp"]);
	expect(Array.from(await files.read(ref))).toEqual([1, 2, 3]);
	await files.remove(ref);
	await files.remove(ref);
	expect(readdirSync(directory)).toEqual([]);
});

test("unadopted temp files are listed, and listing before any write is empty", async () => {
	const { files } = setup();
	expect(await files.listTemp()).toEqual([]);
	await files.writeTemp("a1", bytes(1));
	await files.writeTemp("b2", bytes(2));
	const adopted = await files.writeTemp("c3", bytes(3));
	await files.adopt(adopted, "c3");
	expect((await files.listTemp()).sort()).toEqual(["a1.tmp", "b2.tmp"]);
});

test("traversal and foreign names are impossible in ids and refs", async () => {
	const { root, directory, files } = setup();
	writeFileSync(join(root, "outside.webp"), "secret");
	for (const id of [
		"../outside",
		"a/b",
		"..",
		".",
		"",
		"a.b",
		"a\\b",
		"a\0b",
		"-x",
		" a",
		"x".repeat(129),
	])
		await expect(files.writeTemp(id, bytes(1))).rejects.toThrow(
			"capture_ref_invalid",
		);
	for (const ref of [
		"../outside.webp",
		"a/b.webp",
		"/etc/passwd",
		"x.png",
		"x",
		".tmp",
		"..%2f.webp",
		"a.webp/",
		"a.tmp.webp",
	]) {
		await expect(files.read(ref)).rejects.toThrow("capture_ref_invalid");
		await expect(files.remove(ref)).rejects.toThrow("capture_ref_invalid");
	}
	expect(existsSync(join(root, "outside.webp"))).toBe(true);
	expect(existsSync(directory)).toBe(false);
});

test("adopt only renames the temp file of the same capture id", async () => {
	const { directory, files } = setup();
	const temp = await files.writeTemp("one", bytes(1));
	await files.writeTemp("two", bytes(2));
	await expect(files.adopt(temp, "two")).rejects.toThrow("capture_ref_invalid");
	await expect(files.adopt("one.webp", "one")).rejects.toThrow(
		"capture_ref_invalid",
	);
	await expect(files.adopt("../one.tmp", "one")).rejects.toThrow(
		"capture_ref_invalid",
	);
	await expect(files.adopt("two.tmp", "../two")).rejects.toThrow(
		"capture_ref_invalid",
	);
	expect(readdirSync(directory).sort()).toEqual(["one.tmp", "two.tmp"]);
});

test("files are private to the owner and unrelated names in the directory are ignored", async () => {
	const { directory, files } = setup();
	const temp = await files.writeTemp("p1", bytes(1));
	writeFileSync(join(directory, "notes.txt"), "x");
	symlinkSync("/etc/hosts", join(directory, "link.webp"));
	expect(await files.listTemp()).toEqual(["p1.tmp"]);
	expect(statSync(join(directory, temp)).mode & 0o777).toBe(0o600);
	expect(statSync(directory).mode & 0o777).toBe(0o700);
});
