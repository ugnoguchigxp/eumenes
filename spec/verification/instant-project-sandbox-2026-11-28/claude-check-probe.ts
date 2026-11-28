// Read-only composition probe for the existing registered Claude verification helper.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeStart } from "../../../packages/coding-runner/src/claude-contracts";
import { claudeCheckRequest, createCheckSandbox, supervisedTools } from "../../../packages/coding-runner/src/claude-supervised-tools";

const temp = realpathSync(mkdtempSync(join(tmpdir(), "works-check-probe-")));
const workspace = join(temp, "work");
const outside = join(temp, "fixed-env.d.ts");
mkdirSync(workspace);
writeFileSync(outside, "export type Fixture = string;");
const source = join(workspace, "settings.txt");
writeFileSync(source, "fixture");
const profile = "(version 1) (allow default) (deny file-read-data) (deny file-write*) (deny network*)";
const fixture = `
import { dlopen, FFIType } from 'bun:ffi';
const { sandbox_init } = dlopen('/usr/lib/libsandbox.1.dylib', {
  sandbox_init: { args: [FFIType.cstring, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
}).symbols;
const applied = sandbox_init(Buffer.from(${JSON.stringify(profile + "\0")}), 0n, null) === 0;
console.log(JSON.stringify({ applied }));
if (!applied) process.exitCode = 1;
`;
const args = ["--no-env-file", "--no-install", "-e", fixture];
const executable = realpathSync(process.execPath);
const child = (argv: string[]) => Bun.spawnSync(argv, {
	cwd: workspace,
	env: { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace },
});
try {
	const check = { cwd: workspace, executable: "/usr/bin/true", args: [] };
	const deadline = Date.now() + 60_000;
	const approval = claudeStart.parse({
		id: crypto.randomUUID(), workId: crypto.randomUUID(), generation: 0,
		instruction: "fixture", priorExecutionId: null, deadline, maxTurns: 1, readOnly: false,
		supervised: {
			lease: { ownerRef: "fixture", executorId: "fixture", epoch: "1", slot: "edit" },
			authorization: {
				workspaceRef: "fixture", mode: "edit", targetRevision: "fixture",
				deadline, readablePaths: [source], writablePaths: [source], checks: [check],
			},
		},
	});
	if (!approval.supervised) throw new Error("fixture_supervision_missing");
	const supervised = { ...approval, supervised: approval.supervised };
	const guard = supervisedTools(supervised, workspace);
	try {
		assert.ok(guard.toolRequest("Bash", { command: claudeCheckRequest(check) }));
		assert.equal(guard.toolRequest("Bash", { command: "bun install" }), undefined);
		assert.equal(guard.toolRequest("Bash", { command: "git commit -m fixture" }), undefined);
		assert.equal(guard.toolRequest("Read", { file_path: outside }), undefined);
		assert.equal(guard.toolRequest("Write", { file_path: outside, content: "fixture" }), undefined);
	} finally {
		guard.cleanup?.();
	}
	assert.throws(() => supervisedTools({
		...supervised,
		supervised: { ...supervised.supervised, authorization: {
			...supervised.supervised.authorization,
			readablePaths: [source, outside],
		} },
	}, workspace), /claude_scope_invalid/);

	const direct = child([executable, ...args]);
	if (direct.exitCode !== 0) throw new Error("standalone_control_failed");
	const sandbox = createCheckSandbox(workspace, crypto.randomUUID());
	try {
		const wrapped = child(["/bin/sh", "-c", sandbox.command({ cwd: workspace, executable, args })]);
		const applied = JSON.parse(wrapped.stdout.toString()).applied;
		console.log(JSON.stringify({
			standaloneProfileApplied: true,
			registeredCheckAllowed: true,
			unregisteredShellAndWorkspaceEscapeDenied: true,
			externalReadScopeCurrentlyRejected: true,
			profileAppliedUnderClaudeCheck: applied,
			exit: wrapped.exitCode,
			sandboxOperationNotPermitted: wrapped.stderr.toString().includes("Operation not permitted"),
		}, null, 2));
	} finally {
		sandbox.cleanup();
	}
} finally {
	rmSync(temp, { recursive: true, force: true });
}
