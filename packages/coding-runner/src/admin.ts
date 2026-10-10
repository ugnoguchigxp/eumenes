// Administrator-only maintenance. Deliberately not an MCP tool: the sandboxed agent must not reach it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { readReceipt } from "./core";
import { optionalJson } from "./storage";
import {
	assertNoGitFilters,
	describeIntegrityChange,
	recordGitIntegrity,
	type IntegrityChange,
} from "./workspace";

const usage =
	"使い方: bun src/admin.ts git-integrity <config.json> <workspaceId> [--rebaseline] [--json] [--fixture]";

/** True when an execution may still be using the workspace. Unreadable state counts as busy. */
function workspaceBusy(
	config: ReturnType<typeof loadConfig>,
	workspaceId: string,
) {
	const workspaces = join(config.spoolRoot, "workspaces");
	if (existsSync(join(workspaces, `${workspaceId}.git.json`))) return true;
	try {
		const held = optionalJson<{ executionId: string }>(
			join(workspaces, `${workspaceId}.json`),
		);
		if (!held) return false;
		const receipt = readReceipt(config, held.executionId);
		return !(
			receipt.childrenStopped && ["exited", "stopped"].includes(receipt.state)
		);
	} catch {
		return true;
	}
}
function describe(change: IntegrityChange) {
	const list = (label: string, names: string[]) =>
		names.length ? [`  hook ${label}: ${names.join(", ")}`] : [];
	return [
		change.recorded ? "記録済みの状態と比較しました。" : "記録がありません。",
		`  .git/config: ${change.config === "changed" ? "変更あり" : "変更なし"}`,
		`  config.worktree: ${change.worktreeConfig === "changed" ? "変更あり" : "変更なし"}`,
		...list("追加", change.hooks.added),
		...list("削除", change.hooks.removed),
		...list("変更", change.hooks.changed),
	].join("\n");
}
/** Exit codes: 0 ok, 1 failure, 2 usage, 3 workspace busy, 4 filter forbidden. */
export function runAdmin(argv: string[]): { code: number; out: string } {
	const flags = new Set(argv.filter((a) => a.startsWith("--")));
	const [command, configPath, workspaceId] = argv.filter(
		(a) => !a.startsWith("--"),
	);
	const json = flags.has("--json");
	const finish = (
		code: number,
		text: string,
		data: Record<string, unknown>,
	) => ({ code, out: json ? JSON.stringify({ code, ...data }) : text });
	if (command !== "git-integrity" || !configPath || !workspaceId)
		return finish(2, usage, { error: "usage" });
	try {
		const config = loadConfig(configPath, flags.has("--fixture"));
		const change = describeIntegrityChange(config, workspaceId);
		const shown = describe(change);
		if (!flags.has("--rebaseline"))
			return finish(0, shown, { change, rebaselined: false });
		if (workspaceBusy(config, workspaceId))
			return finish(
				3,
				`${shown}\n実行中の execution があるため再基準化しません (runner_workspace_busy)。`,
				{ change, error: "runner_workspace_busy" },
			);
		try {
			assertNoGitFilters(config, workspaceId);
		} catch {
			return finish(
				4,
				`${shown}\nfilter 属性があるため再基準化しません (runner_git_filter_forbidden)。`,
				{ change, error: "runner_git_filter_forbidden" },
			);
		}
		recordGitIntegrity(config, workspaceId);
		return finish(0, `${shown}\n再基準化しました。`, {
			change,
			rebaselined: true,
		});
	} catch (error) {
		const code = error instanceof Error ? error.message : "runner_admin_failed";
		const safe = /^[a-z][a-z0-9_]{0,63}$/.test(code)
			? code
			: "runner_admin_failed";
		return finish(1, `失敗しました (${safe})。`, { error: safe });
	}
}
if (import.meta.main) {
	const result = runAdmin(process.argv.slice(2));
	console.log(result.out);
	process.exit(result.code);
}
