import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeDaemonClient, claudeRunnerClient } from "../../domains/coding";
import type { Config } from "../../infrastructure/config";
import { sha256Hex } from "../../infrastructure/digest";

const defaults = {
	socket: claudeRunnerClient,
	daemon: claudeDaemonClient,
	installed: () => Boolean(Bun.which("claude")),
};

export async function buildClaudeRunners(
	config: Pick<Config, "dbPath" | "env">,
	checkout: string,
	goalWorkspaces: readonly { ref: string; root: string }[],
	factories = defaults,
) {
	const socket = config.env.EUMENES_CLAUDE_WORK_RUNNER_SOCKET;
	const workspaceRoot = realpathSync(checkout);
	type Client = ReturnType<typeof claudeRunnerClient>;
	let connect: (workspace: string) => Client;
	const available = new Map<string, Client>();
	if (socket) connect = (workspace) => factories.socket(socket, workspace);
	else {
		if (
			config.env.EUMENES_CLAUDE_WORK_RUNNER_AUTOSTART === "0" ||
			config.dbPath === ":memory:" ||
			!factories.installed()
		)
			return { claudeRunner: undefined, goalClaudeRunners: available };
		const dataRoot = realpathSync(dirname(config.dbPath));
		connect = (workspace) => {
			const name =
				workspace === workspaceRoot
					? "claude-code-runner"
					: `claude-goal-${sha256Hex(workspace).slice(0, 16)}`;
			const protectedPaths = [
				dataRoot,
				...[...new Set([workspaceRoot, workspace])].flatMap((root) => [
					join(root, ".env"),
					join(root, ".env.local"),
				]),
			];
			return factories.daemon({
				root: join(dataRoot, name),
				workspace,
				protectedPaths,
			});
		};
	}
	const claudeRunner = connect(workspaceRoot);
	const runners = new Map([[workspaceRoot, claudeRunner]]);
	for (const { ref, root } of goalWorkspaces) {
		const canonical = realpathSync(root);
		const runner = runners.get(canonical) ?? connect(canonical);
		runners.set(canonical, runner);
		available.set(ref, runner);
	}
	await Promise.all([...runners.values()].map((runner) => runner.probe()));
	return { claudeRunner, goalClaudeRunners: available };
}
