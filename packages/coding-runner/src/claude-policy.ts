import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ClaudeDaemonConfig, ClaudeStart } from "./claude-contracts";
import type { ClaudeEngineInput } from "./claude-engine";

type Prepare = (
	spec: ClaudeStart,
	sessionId?: string,
) => Omit<ClaudeEngineInput, "onSession" | "onEvidence" | "ask">;

const ENV_ALLOWLIST = [
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PATH",
	"TMPDIR",
	"TZ",
	"LANG",
	"SSH_AUTH_SOCK",
	"__CF_USER_TEXT_ENCODING",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
] as const;

export function defaultClaudeEnv(
	source: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ENV_ALLOWLIST) {
		const value = source[key];
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(source)) {
		if (key.startsWith("LC_") && value !== undefined) env[key] = value;
	}
	env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
	return env;
}

export function resolveClaudeExecutable(configured?: string): string | null {
	const candidate = configured ?? Bun.which("claude");
	if (!candidate || !existsSync(candidate)) return null;
	try {
		return realpathSync(candidate);
	} catch {
		return null;
	}
}

export type ClaudeAuthStatus = {
	loggedIn: boolean;
	authMethod?: string;
	email?: string;
};

export function readClaudeAuthStatus(
	executable: string,
	cwd: string,
	env: Record<string, string>,
): ClaudeAuthStatus | null {
	try {
		const result = spawnSync(executable, ["auth", "status", "--json"], {
			cwd,
			env,
			encoding: "utf8",
			timeout: 5_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status !== 0 || !result.stdout.trim()) return null;
		const parsed = JSON.parse(result.stdout) as ClaudeAuthStatus;
		return parsed?.loggedIn === true ? parsed : null;
	} catch {
		return null;
	}
}

function contained(parent: string, target: string): boolean {
	const rel = relative(parent, target);
	return (
		rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
	);
}

function resolveMaybeMissing(target: string): string {
	try {
		lstatSync(target);
		return realpathSync(target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(target);
		if (parent === target) throw error;
		return resolve(resolveMaybeMissing(parent), relative(parent, target));
	}
}

function resolveToolPath(
	workspace: string,
	tool: string,
	input: Record<string, unknown>,
): string | null {
	const raw =
		tool === "Glob" || tool === "Grep"
			? (input.path ?? workspace)
			: input.file_path;
	if (typeof raw !== "string" || !raw.trim()) return null;
	try {
		return resolveMaybeMissing(resolve(workspace, raw));
	} catch {
		return null;
	}
}

function isProtected(target: string, protectedPaths: readonly string[]) {
	return protectedPaths.some(
		(entry) => contained(entry, target) || contained(target, entry),
	);
}

/** Mechanical authorization boundary for ordinary conversation-initiated Claude Code work. */
export function evaluateOrdinaryToolAuthorization(
	tool: string,
	input: Record<string, unknown>,
	options: {
		workspace: string;
		protectedPaths: readonly string[];
		readOnly: boolean;
	},
): boolean | "ask" {
	const { workspace, protectedPaths, readOnly } = options;
	const gitDir = join(workspace, ".git");
	if (tool === "Read" || tool === "Glob" || tool === "Grep") {
		const target = resolveToolPath(workspace, tool, input);
		if (!target || isProtected(target, protectedPaths)) return false;
		if (contained(workspace, target)) return true;
		return "ask";
	}
	if (tool === "Edit" || tool === "Write") {
		if (readOnly) return false;
		const target = resolveToolPath(workspace, tool, input);
		if (
			!target ||
			!contained(workspace, target) ||
			contained(gitDir, target) ||
			isProtected(target, protectedPaths)
		)
			return false;
		return true;
	}
	if (tool === "Bash") {
		if (readOnly) return false;
		const command = typeof input.command === "string" ? input.command : "";
		if (!command.trim() || input.dangerouslyDisableSandbox) return false;
		// Publishing and remote mutation remain hard-denied unless an explicit workflow allows them.
		if (/\bgit\s+push\b/i.test(command)) return false;
		// Committing or destructive git operations require explicit user confirmation via canUseTool.
		if (/\bgit\s+(commit|reset\s+--hard|clean\s+-[a-z]*f)\b/i.test(command))
			return "ask";
		return true;
	}
	return false;
}

export function createDefaultClaudePrepare(config: ClaudeDaemonConfig): {
	workspace: string;
	prepare: Prepare;
} {
	const workspace = realpathSync(config.workspace);
	const executable = resolveClaudeExecutable(config.executable);
	if (!executable) throw new Error("claude_cli_missing");
	const env = defaultClaudeEnv();
	const auth = readClaudeAuthStatus(executable, workspace, env);
	if (!auth) throw new Error("claude_auth_unavailable");
	const protectedPaths = (config.protectedPaths ?? []).flatMap((entry) => {
		try {
			return [resolveMaybeMissing(entry)];
		} catch {
			return [];
		}
	});
	const projectInstructions = [
		"You are executing a bounded task delegated by Eumenes in the registered local workspace.",
		`Workspace root: ${workspace}`,
		"Keep changes strictly within the requested scope. Preserve existing uncommitted edits unless explicitly asked to modify them.",
		"Do not run git push or publish/send external side effects. Ask the user via AskUserQuestion when a product/design choice is genuinely ambiguous.",
		"After edits, run relevant verification commands and report concrete evidence (changed files and verification results).",
	].join("\n");

	const prepare: Prepare = (spec, sessionId) => {
		const tools = spec.readOnly
			? ["Read", "Glob", "Grep"]
			: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"];
		return {
			cwd: workspace,
			executable,
			env,
			instruction: spec.instruction,
			projectInstructions,
			sessionId,
			deadline: spec.deadline,
			maxTurns: spec.maxTurns,
			tools,
			...(!spec.readOnly
				? {
						sandbox: {
							enabled: true,
							failIfUnavailable: true,
							autoAllowBashIfSandboxed: true,
							allowUnsandboxedCommands: false,
						},
					}
				: {}),
			authorize: (tool, raw) =>
				evaluateOrdinaryToolAuthorization(tool, raw, {
					workspace,
					protectedPaths,
					readOnly: spec.readOnly,
				}),
			validateAccount: (account) => {
				if (auth.email && account.email) return account.email === auth.email;
				return Boolean(account.apiProvider || account.email);
			},
		};
	};
	return { workspace, prepare };
}
