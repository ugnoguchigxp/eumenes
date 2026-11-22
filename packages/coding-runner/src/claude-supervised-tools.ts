import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { claudeInputDigest } from "./claude-input-digest";
import type {
	ClaudeCheck,
	ClaudeEvidence,
	ClaudeStart,
} from "./claude-contracts";
import { digest, readPrivate } from "./storage";

type DelegatedStart = ClaudeStart & {
	supervised: NonNullable<ClaudeStart["supervised"]>;
};
type ToolEvidence = Omit<ClaudeEvidence, "ref" | "executionId">;
type ToolRequest = {
	input: Record<string, unknown>;
	fact: Omit<ToolEvidence, "text" | "passed">;
	statusPath?: string;
	editGuard?: { unrelatedDigest: string; contentDigest: string };
};

export const verificationUnavailable = "verification_isolation_unavailable";
export const workspaceInputsChanged = "workspace_inputs_changed";
const sandboxExecutable = "/usr/bin/sandbox-exec";

const contained = (parent: string, path: string) => {
	const rel = relative(parent, path);
	return (
		rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../"))
	);
};

const shellQuote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
const shellCommand = (argv: string[]) => argv.map(shellQuote).join(" ");
export const claudeCheckRequest = ({ executable, args, cwd }: ClaudeCheck) =>
	`cd -- ${shellQuote(cwd)} && ${shellCommand([executable, ...args])}`;

function resolvePath(path: string): string {
	try {
		lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return resolve(resolvePath(parent), relative(parent, path));
	}
	return realpathSync(path);
}

/** Checkouts, runner receipts, and all other filesystem paths remain read-only. */
export function createCheckSandbox(workspace: string, id: string) {
	if (process.platform !== "darwin" || !existsSync(sandboxExecutable))
		throw new Error(verificationUnavailable);
	const temporary = mkdtempSync(
		join(realpathSync(tmpdir()), `claude-check-${id}-`),
	);
	if (contained(workspace, temporary) || contained(temporary, workspace)) {
		rmSync(temporary, { recursive: true, force: true });
		throw new Error(verificationUnavailable);
	}
	const files = join(temporary, "files");
	mkdirSync(files, { mode: 0o700 });
	const profile = [
		"(version 1)",
		"(allow default)",
		"(deny network*)",
		"(deny file-write*)",
		`(allow file-write* (subpath ${JSON.stringify(files)}))`,
		"(deny file-link)",
	].join(" ");
	try {
		execFileSync(sandboxExecutable, ["-p", profile, "/usr/bin/true"], {
			timeout: 2_000,
			stdio: "ignore",
		});
	} catch {
		rmSync(temporary, { recursive: true, force: true });
		throw new Error(verificationUnavailable);
	}

	const command = (check: ClaudeCheck) => {
		const cwd = realpathSync(check.cwd);
		const executable = realpathSync(check.executable);
		if (
			!contained(workspace, cwd) ||
			!lstatSync(cwd).isDirectory() ||
			!lstatSync(executable).isFile()
		)
			throw new Error("claude_check_scope_invalid");
		return `cd -- ${shellQuote(cwd)} && ${shellCommand([
			sandboxExecutable,
			"-p",
			profile,
			"/usr/bin/env",
			"-i",
			"PATH=/usr/bin:/bin",
			`HOME=${files}`,
			`TMPDIR=${files}`,
			`XDG_CACHE_HOME=${files}`,
			executable,
			...check.args,
		])}`;
	};
	return {
		command,
		cleanup: () => rmSync(temporary, { recursive: true, force: true }),
		withExitStatus(check: string) {
			// Only the parent wrapper can write the exit-status file. The tested process
			// and its descendants run inside the sandbox, with writes confined to files/.
			const statusPath = join(temporary, `${crypto.randomUUID()}.status`);
			return {
				statusPath,
				command: `if ${check}; then eum_claude_check_exit_code=0; else eum_claude_check_exit_code=$?; fi; (umask 077; printf '%s\\n' "$eum_claude_check_exit_code" > ${shellQuote(statusPath)}); exit "$eum_claude_check_exit_code"`,
			};
		},
	};
}

export function supervisedTools(
	spec: DelegatedStart,
	workspace: string,
	priorInputDigest?: string,
) {
	const { authorization } = spec.supervised;
	const { mode, targetRevision } = authorization;
	const writable = authorization.writablePaths.map(resolvePath);
	const readable = [
		...authorization.readablePaths.map(resolvePath),
		...writable,
	];
	if (
		readable.some(
			(path) =>
				!contained(workspace, path) || contained(join(workspace, ".git"), path),
		) ||
		writable.some((path) => contained(path, join(workspace, ".git")))
	)
		throw new Error("claude_scope_invalid");
	let currentDigest = claudeInputDigest(readable);
	const baseline = priorInputDigest ?? authorization.baselineInputDigest;
	if (
		(baseline && currentDigest !== baseline) ||
		(mode !== "read" && !currentDigest)
	)
		throw new Error(workspaceInputsChanged);
	let commands = new Map<string, { check: ClaudeCheck; wrapped: string }>();
	const sandbox = authorization.checks.length
		? createCheckSandbox(workspace, spec.id)
		: undefined;
	if (sandbox) {
		try {
			commands = new Map(
				authorization.checks.map((check) => [
					claudeCheckRequest(check),
					{ check, wrapped: sandbox.command(check) },
				]),
			);
		} catch (error) {
			sandbox.cleanup();
			throw error;
		}
	}
	function toolRequest(
		tool: string,
		input: Record<string, unknown>,
	): ToolRequest | undefined {
		if (tool === "Bash") {
			const command =
				typeof input.command === "string"
					? commands.get(input.command)
					: undefined;
			if (
				!sandbox ||
				!command ||
				input.dangerouslyDisableSandbox ||
				input.run_in_background
			)
				return;
			const inputDigest = claudeInputDigest(readable);
			if (!inputDigest || inputDigest !== currentDigest) return;
			const witnessed = sandbox.withExitStatus(command.wrapped);
			return {
				input: {
					command: witnessed.command,
					timeout: Math.max(1, Math.min(600_000, spec.deadline - Date.now())),
				},
				statusPath: witnessed.statusPath,
				fact: {
					kind: "check",
					check: command.check,
					targetRevision,
					inputDigest,
				},
			};
		}
		const edit = tool === "Write" || tool === "Edit";
		const search = tool === "Glob" || tool === "Grep";
		if ((!edit && !search && tool !== "Read") || (edit && mode !== "edit"))
			return;
		const rawPath = search ? (input.path ?? workspace) : input.file_path;
		if (typeof rawPath !== "string") return;
		if (
			tool === "Glob" &&
			(typeof input.pattern !== "string" ||
				isAbsolute(input.pattern) ||
				input.pattern.split("/").includes(".."))
		)
			return;
		let path: string;
		try {
			path = resolvePath(resolve(workspace, rawPath));
			if (edit && existsSync(path) && lstatSync(path).nlink !== 1) return;
		} catch {
			return;
		}
		if (
			!contained(workspace, path) ||
			contained(join(workspace, ".git"), path) ||
			!(edit ? writable : readable).some((parent) => contained(parent, path))
		)
			return;
		const inputDigest = claudeInputDigest(readable);
		let editGuard: ToolRequest["editGuard"];
		if (edit) {
			if (!inputDigest || inputDigest !== currentDigest) return;
			const unrelatedDigest = claudeInputDigest(readable, path);
			const contentDigest = editedContentDigest(tool, input, path);
			if (!unrelatedDigest || !contentDigest) return;
			editGuard = { unrelatedDigest, contentDigest };
		}
		return {
			input: { ...input, [search ? "path" : "file_path"]: path },
			fact: { kind: edit ? "edit" : "read", path, targetRevision, inputDigest },
			editGuard,
		};
	}

	function toolEvidence(
		{ fact, statusPath, editGuard }: ToolRequest,
		output: unknown,
		success: boolean,
	): ToolEvidence | undefined {
		if (fact.kind === "check") {
			const after = claudeInputDigest(readable);
			const result =
				output && typeof output === "object"
					? (output as Record<string, unknown>)
					: {};
			let exitedZero = false;
			try {
				exitedZero = !!statusPath && readPrivate(statusPath) === "0\n";
			} catch {}
			const passed =
				success &&
				exitedZero &&
				!result.interrupted &&
				!result.backgroundTaskId &&
				!result.backgroundedByUser &&
				!result.timedOutAfterMs &&
				!!fact.inputDigest &&
				fact.inputDigest === after;
			return {
				...fact,
				passed,
				text: JSON.stringify(output ?? "").slice(0, 1_024),
			};
		}
		if (!success) return;
		const after = claudeInputDigest(readable);
		if (
			!after ||
			(fact.kind === "read" && after !== fact.inputDigest) ||
			(fact.kind === "edit" && after === fact.inputDigest)
		)
			return;
		if (fact.kind === "edit") {
			if (
				!fact.path ||
				!editGuard ||
				editGuard.unrelatedDigest !== claudeInputDigest(readable, fact.path)
			)
				return;
			try {
				if (editGuard.contentDigest !== digest(readFileSync(fact.path))) return;
			} catch {
				return;
			}
			currentDigest = after;
		}
		return {
			...fact,
			inputDigest: after,
			text: JSON.stringify(output ?? "").slice(0, 1_024),
		};
	}

	return {
		toolRequest,
		toolEvidence,
		inputDigest: () => currentDigest,
		commands: [...commands.keys()],
		cleanup: sandbox?.cleanup,
	};
}

function editedContentDigest(
	tool: string,
	input: Record<string, unknown>,
	path: string,
) {
	if (tool === "Write" && typeof input.content === "string")
		return digest(input.content);
	if (
		tool !== "Edit" ||
		typeof input.old_string !== "string" ||
		!input.old_string ||
		typeof input.new_string !== "string"
	)
		return;
	try {
		const before = readFileSync(path, "utf8");
		if (!before.includes(input.old_string)) return;
		const after = input.replace_all
			? before.replaceAll(input.old_string, () => input.new_string as string)
			: before.replace(input.old_string, () => input.new_string as string);
		return digest(after);
	} catch {
		return;
	}
}
