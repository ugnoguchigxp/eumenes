import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupervisionScope } from "../../domains/development-supervision";
import {
	markWorkspaceUnknownInTransaction,
	migrations as workspaceMigrations,
	reserveWorkspaceInTransaction,
} from "../../domains/kanban";
import { supervisionWorkspace } from "./supervision-workspace";

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const close of cleanup.splice(0)) close();
});
function fixture() {
	const root = realpathSync(
		mkdtempSync(join(tmpdir(), "eumenes-supervision-scope-")),
	);
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], {
			stdio: "pipe",
			encoding: "utf8",
		}).trim();
	git("init", "-q");
	const target = join(root, "sum.ts"),
		other = join(root, "notes.txt");
	writeFileSync(target, "export const sum = () => 0;\n");
	writeFileSync(other, "original\n");
	git("add", "sum.ts", "notes.txt");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@localhost",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"baseline",
	);
	writeFileSync(other, "user draft\n");
	const targetRevision = git("rev-parse", "HEAD");
	const workspace = supervisionWorkspace(root);
	const scope: SupervisionScope = {
		workspaceRef: "eumenes",
		mode: "edit",
		targetRevision,
		deadline: Date.now() + 60_000,
		readablePaths: ["sum.ts"],
		writablePaths: ["sum.ts"],
		checks: [{ executable: process.execPath, args: ["test"], cwd: "." }],
	};
	return { root, git, target, other, scope, workspace };
}
test("captures the actual checkout and keeps a user's separate staged or unstaged edits attributable", async () => {
	const { git, workspace, target, other, scope } = fixture();
	const signal = new AbortController().signal;
	const before = await workspace.capture(scope, signal);
	writeFileSync(target, "export const sum = (a:number,b:number) => a+b;\n");
	const after = await workspace.capture(scope, signal, before);
	expect(after).toMatchObject({
		targetRevision: before.targetRevision,
		preserved: true,
		snapshotId: before.snapshotId,
	});
	expect(after.inputDigest).not.toBe(before.inputDigest);
	git("add", "notes.txt");
	expect((await workspace.capture(scope, signal, before)).preserved).toBe(
		false,
	);
	git("reset", "--", "notes.txt");
	writeFileSync(other, "different draft\n");
	expect((await workspace.capture(scope, signal, before)).preserved).toBe(
		false,
	);
});
test("static reading tolerates an independent edit and rejects stale inputs, outside paths and broad write grants", async () => {
	const { root, workspace, target, other, scope } = fixture();
	const signal = new AbortController().signal;
	const read: SupervisionScope = {
		...scope,
		mode: "read",
		checks: [],
		writablePaths: [],
	};
	const before = await workspace.capture(read, signal);
	writeFileSync(other, "parallel edit\n");
	expect((await workspace.capture(read, signal, before)).preserved).toBe(true);
	writeFileSync(target, "changed\n");
	expect((await workspace.capture(read, signal, before)).preserved).toBe(false);
	symlinkSync(tmpdir(), join(root, "outside"));
	for (const path of [
		".",
		".git/config",
		"outside/uncreated",
		"../different-repo",
	]) {
		expect(
			workspace.resolveScope!({ ...scope, writablePaths: [path] }),
		).toBeNull();
	}
	expect(
		workspace.resolveScope!({
			...scope,
			checks: [{ executable: "/bin/sh", args: [], cwd: root }],
		}),
	).toBeNull();
});
test("a pre-existing change in an editable file is held before a writer can overwrite it", async () => {
	const { target, scope, workspace } = fixture();
	writeFileSync(target, "user draft in the target itself\n");
	const before = await workspace.capture(scope, new AbortController().signal);
	expect(before.preserved).toBe(false);
});
test("a holder-specific release and an unconfirmed sibling are reported independently", () => {
	const { workspace, scope } = fixture();
	const db = new Database(":memory:");
	cleanup.push(() => db.close());
	for (const migration of workspaceMigrations) db.exec(migration.sql);
	const guard = {
		workspaceRef: scope.workspaceRef,
		ownerRef: "claude-code-work:reader",
		executorId: "claude-code-task",
		epoch: "reader",
		mode: "read" as const,
		state: "held" as const,
	};
	expect(reserveWorkspaceInTransaction(db, guard)).toBe(true);
	expect(workspace.inspectInTransaction(db, scope)).toMatchObject({
		released: true,
	});
	expect(
		workspace.inspectInTransaction(db, { ...scope, mode: "read" }),
	).toMatchObject({ reason: "読取り枠待ち" });
	expect(markWorkspaceUnknownInTransaction(db, guard)).toBe(true);
	expect(workspace.inspectInTransaction(db, scope)).toMatchObject({
		released: true,
		reason: "他タスクの停止未確認",
		blockerRef: guard.ownerRef,
	});
	expect(workspace.inspectInTransaction(db, scope, "reader")).toMatchObject({
		released: false,
		reason: "自分の停止未確認",
	});
});
