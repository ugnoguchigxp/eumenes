import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceGit as git } from "../coding";
import { projects, template } from "./projects";
import { collect } from "./runtime/project";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { force: true, recursive: true });
});
function workspace() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "works-project-")));
	directories.push(root);
	return root;
}
function init(root: string) {
	git(root, ["init", "--initial-branch=main", "--template="]);
	git(root, ["add", "."]);
	git(root, [
		"-c",
		"user.name=Works test",
		"-c",
		"user.email=works@example.invalid",
		"commit",
		"-m",
		"Fixture",
	]);
}
test("collects bounded sources, ignores dotenv, and rejects outside links", () => {
	const root = workspace();
	const project = join(root, "project");
	template(project, "Project", "1.0");
	const initial = collect(project);
	writeFileSync(join(project, "src", ".env"), "TEST_PRIVATE_FIXTURE=yes");
	expect(collect(project).digest).toBe(initial.digest);
	writeFileSync(join(project, "assets", "static.txt"), "fixture");
	expect(collect(project).digest).not.toBe(initial.digest);
	const outside = join(root, "outside.txt");
	writeFileSync(outside, "fixture");
	symlinkSync(outside, join(project, "assets", "outside.txt"));
	expect(() => collect(project)).toThrow("prototype_link_forbidden");
});
test("rejects nested registrations, preserves the Git history on move, and invalidates a stale row", () => {
	const root = workspace();
	const core = join(root, "core");
	const data = join(root, "data");
	const works = join(root, "works");
	for (const dir of [core, data, works]) mkdirSync(dir);
	writeFileSync(join(core, "README.md"), "Core");
	init(core);
	const work = join(works, "prototype");
	template(work, "Project", "1.0");
	init(work);
	const service = projects({ core, data, works, setup() {} });
	const row = service.register(work);
	expect(() => service.register(work)).toThrow("prototype_git_overlap");
	expect(() => service.register(join(work, "src"))).toThrow(
		"prototype_git_root_required",
	);
	expect(() => service.register(core)).toThrow("prototype_git_overlap");
	const another = join(works, "separate");
	template(another, "Other project", "1.0");
	init(another);
	expect(() => service.move(row.id, another)).toThrow();
	const moved = join(works, "relocated");
	renameSync(work, moved);
	const next = service.move(row.id, moved);
	expect(next.id).toBe(row.id);
	expect(next.generation).toBe(2);
	expect(next.anchor).toBe(row.anchor);
	expect(() => service.assertCurrent(row)).toThrow(
		"prototype_registration_changed",
	);
	const before = git(moved, ["status", "--porcelain"]);
	service.remove(row.id);
	expect(git(moved, ["status", "--porcelain"])).toBe(before);
	expect(service.list()).toHaveLength(0);
});

test("new dependency releases must have a verified registry archive, be seven days old, and need no install script", async () => {
	const { verifyDependencyVersion } = await import("./dependencies");
	const name = "works-sample";
	const version = "1.0.0";
	const dist = {
		tarball: "https://registry.npmjs.org/works-sample/-/works-sample-1.0.0.tgz",
		integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
	};
	const metadata = (ageMs: number, item = { dist }) => ({
		time: { [version]: new Date(Date.now() - ageMs).toISOString() },
		versions: { [version]: item },
	});
	const days = (n: number) => n * 86_400_000;
	expect(verifyDependencyVersion(name, version, metadata(days(8)))).toEqual(
		dist,
	);
	expect(() =>
		verifyDependencyVersion(name, version, metadata(days(6))),
	).toThrow("prototype_dependency_too_recent");
	const usesScript = { dist, scripts: { postinstall: "not executed" } };
	expect(() =>
		verifyDependencyVersion(name, version, metadata(days(8), usesScript)),
	).toThrow("prototype_dependency_requires_install_script");
	const usesNonRegistry = {
		dist: { ...dist, tarball: "https://example.invalid/archive" },
	};
	expect(() =>
		verifyDependencyVersion(name, version, metadata(days(8), usesNonRegistry)),
	).toThrow("prototype_dependency_unsupported_source");
});
