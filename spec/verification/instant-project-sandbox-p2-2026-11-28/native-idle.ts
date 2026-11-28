import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { claudeDaemonClient, claudeRunnerClient } from "../../../api/domains/coding";

const root = realpathSync(mkdtempSync("/tmp/works-idle-"));
const workspace = join(root, "project");
const state = join(root, "runner");
mkdirSync(workspace, { mode: 0o700 });
mkdirSync(state, { mode: 0o700 });
const socket = join(state, "claude.sock");
const config = { root: state, workspace, idleMs: 60_000 };
const filename = join(state, "test-config.json");
writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
const client = claudeRunnerClient(socket, workspace);
const driver = claudeDaemonClient(config, { idleMs: 60_000 });
let proc: ReturnType<typeof Bun.spawn> | undefined;
try {
	for (let i = 0; i < 3; i++) assert.equal(await driver.probe(), false);
	assert(!existsSync(socket));
	proc = Bun.spawn([
		process.execPath, "--no-env-file",
		resolve(import.meta.dir, "../../../packages/coding-runner/src/claude-cli.ts"), "serve", filename,
	], { cwd: workspace, stdout: "ignore", stderr: "ignore" });
	const started = Date.now();
	while (!await client.probe()) {
		if (Date.now() - started > 8000) throw new Error("trial daemon did not become ready");
		await Bun.sleep(80);
	}
	const before = Date.now();
	assert.equal(await driver.retireIdle(), true);
	const outcome = await Promise.race([proc.exited, Bun.sleep(68_000).then(() => "timeout")]);
	assert.equal(outcome, 0);
	const elapsed = Date.now() - before;
	assert(elapsed >= 59_500 && elapsed < 68_000);
	for (let i = 0; i < 3; i++) {
		assert.equal(await driver.probe(), false);
		assert(!existsSync(socket));
		await Bun.sleep(100);
	}
	console.log(JSON.stringify({ configuredIdleMs: config.idleMs, elapsedMs: elapsed, listenerExited: true, restartedByProbe: false }));
} finally {
	if (proc?.exitCode === null) proc.kill("SIGTERM");
	await proc?.exited;
	rmSync(root, { recursive: true, force: true });
}
