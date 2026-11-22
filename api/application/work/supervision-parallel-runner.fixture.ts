import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { serveClaudeRunner } from "../../domains/coding/test/claude-server.fixture";

/** This fixture uses the existing Claude OAuth login and a fresh runner state directory. */
export async function serveSupervisionTrialRunner(
	directory: string,
	checkout: string,
) {
	const binary = Bun.which("claude");
	if (!binary || !existsSync(binary))
		throw new Error("parallel_claude_cli_missing");
	const executable = realpathSync(binary);
	const cwd = realpathSync(checkout);
	const env = {
		HOME: homedir(),
		USER: userInfo().username,
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		SHELL: process.env.SHELL ?? "/bin/zsh",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	};
	const status = spawnSync(executable, ["auth", "status", "--json"], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 5_000,
		stdio: ["ignore", "pipe", "ignore"],
	});
	if (status.status !== 0) throw new Error("parallel_claude_oauth_unavailable");
	const auth = JSON.parse(status.stdout) as {
		loggedIn?: boolean;
		authMethod?: string;
		email?: string;
	};
	if (auth.loggedIn !== true || auth.authMethod !== "claude.ai" || !auth.email)
		throw new Error("parallel_claude_oauth_required");
	return serveClaudeRunner(directory, cwd, (spec) => ({
		cwd,
		executable,
		env,
		instruction: spec.instruction,
		projectInstructions:
			"This is a disposable local test repository. Carry out only the explicitly requested operation using the supplied tools. Never invoke tools outside the authorization or ask for wider permissions.",
		deadline: spec.deadline,
		maxTurns: spec.maxTurns,
		tools: ["Read", "Glob", "Grep", "Bash", "Edit", "Write"],
		authorize: (tool) =>
			["Read", "Glob", "Grep", "Bash", "Edit", "Write"].includes(tool),
		validateAccount: (account) =>
			account.apiProvider === "firstParty" && account.email === auth.email,
	}));
}
