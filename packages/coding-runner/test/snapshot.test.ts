import { afterEach, expect, test } from "bun:test";
import {
	appendFileSync,
	closeSync,
	ftruncateSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, snapshotWorkspace } from "../src/workspace";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "snapshot-")));
	roots.push(root);
	const path = join(root, "work");
	mkdirSync(path);
	git(path, ["init", "-q", "-b", "main"]);
	git(path, ["config", "user.name", "Fixture"]);
	git(path, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(path, "source.txt"), "base\n");
	git(path, ["add", "source.txt"]);
	git(path, ["commit", "-qm", "base"]);
	const baseSha = git(path, ["rev-parse", "HEAD"]).trim();
	return {
		path,
		snapshot: () => snapshotWorkspace({ id: "fixture", path, baseSha }),
	};
}

test("files hidden through .git/info/exclude fail the snapshot, while .gitignore ones do not", () => {
	const f = fixture();
	writeFileSync(join(f.path, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(f.path, "ignored.txt"), "by gitignore\n");
	expect(f.snapshot().files.some((x) => x.path === "ignored.txt")).toBe(false);
	writeFileSync(join(f.path, "secret.txt"), "hidden\n");
	appendFileSync(join(f.path, ".git/info/exclude"), "secret.txt\n");
	expect(() => f.snapshot()).toThrow("runner_hidden_files");
});

test("a clean or smudge filter attribute is forbidden", () => {
	const f = fixture();
	writeFileSync(join(f.path, ".gitattributes"), "*.txt filter=evil\n");
	expect(() => f.snapshot()).toThrow("runner_git_filter_forbidden");
	rmSync(join(f.path, ".gitattributes"));
	mkdirSync(join(f.path, "nested"));
	writeFileSync(join(f.path, "nested/.gitattributes"), "*.txt filter=evil\n");
	expect(() => f.snapshot()).toThrow("runner_git_filter_forbidden");
});

test("snapshot rejects an oversized sparse file before loading its contents", () => {
	const f = fixture();
	const fd = openSync(join(f.path, "large"), "w");
	try {
		ftruncateSync(fd, 65 * 1024 * 1024);
	} finally {
		closeSync(fd);
	}
	expect(() => f.snapshot()).toThrow("runner_snapshot_limit");
});
