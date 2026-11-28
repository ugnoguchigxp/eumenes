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
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { claudeInputDigest } from "./claude-input-digest";
import type {
	ClaudeCheck,
	ClaudeEvidence,
	ClaudeStart,
} from "./claude-contracts";
import { digest, lock, readPrivate } from "./storage";

type DelegatedStart = ClaudeStart & {
	supervised: NonNullable<ClaudeStart["supervised"]>;
};
type ToolEvidence = Omit<ClaudeEvidence, "ref" | "executionId">;
type ToolRequest = {
	input: Record<string, unknown>;
	fact: Omit<ToolEvidence, "text" | "passed">;
	statusPath?: string;
	stderrPath?: string;
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
export function createCheckSandbox(
	workspace: string,
	id: string,
	options?: {
		writablePaths?: readonly string[];
		protectedPaths?: readonly string[];
		path?: string;
		works?: {
			runtime: string;
			readable: readonly string[];
			executable: string;
		};
	},
) {
	if (process.platform !== "darwin" || !existsSync(sandboxExecutable))
		throw new Error(verificationUnavailable);
	const tempRoot = realpathSync(tmpdir());
	if (
		options?.writablePaths?.length &&
		(workspace === tempRoot || !contained(tempRoot, realpathSync(workspace)))
	)
		throw new Error(verificationUnavailable);
	const writable = (options?.writablePaths ?? []).map(resolvePath);
	if (
		writable.some((path) => path === workspace || !contained(workspace, path))
	)
		throw new Error(verificationUnavailable);
	const temporary = mkdtempSync(join(tempRoot, `claude-check-${id}-`));
	if (contained(workspace, temporary) || contained(temporary, workspace)) {
		rmSync(temporary, { recursive: true, force: true });
		throw new Error(verificationUnavailable);
	}
	const files = join(temporary, "files");
	mkdirSync(files, { mode: 0o700 });
	const works = options?.works;
	const literal = (value: string) => `(literal ${JSON.stringify(value)})`;
	const subpath = (value: string) => `(subpath ${JSON.stringify(value)})`;
	const worksRules = works
		? [
				"(deny file-read-data)",
				`(allow file-read-data ${["/", workspace, "/usr/bin/true", "/usr/bin/env", works.executable].map(literal).join(" ")} ${["/System", "/usr/lib", "/private/preboot", files, works.runtime, ...works.readable].map(subpath).join(" ")})`,
				`(deny file-read-data (regex #"/\\.env[^/]*($|/)") (regex #"/\\.git($|/)"))`,
				"(deny process-exec)",
				`(allow process-exec ${["/usr/bin/true", "/usr/bin/env", works.executable].map(literal).join(" ")})`,
			]
		: [];
	const profile = [
		"(version 1)",
		"(allow default)",
		...worksRules,
		"(deny network*)",
		"(deny file-write*)",
		'(allow file-write-data (literal "/dev/null"))',
		`(allow file-write* (subpath ${JSON.stringify(files)}))`,
		...writable.map(
			(path) => `(allow file-write* (subpath ${JSON.stringify(path)}))`,
		),
		...(options?.protectedPaths ?? []).map(
			(path) =>
				`(deny file-read* (subpath ${JSON.stringify(resolvePath(path))}))`,
		),
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
			`PATH=${options?.path ?? "/usr/bin:/bin"}`,
			`HOME=${files}`,
			`TMPDIR=${files}`,
			`XDG_CACHE_HOME=${files}`,
			...(works ? ["EUMENES_WORKS_CHECK=1"] : []),
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
			const stderrPath = statusPath + ".stderr";
			return {
				statusPath,
				stderrPath,
				command: `umask 077; if { ${check}; } 2> ${shellQuote(stderrPath)}; then eum_claude_check_exit_code=0; else eum_claude_check_exit_code=$?; fi; /bin/cat ${shellQuote(stderrPath)} >&2; printf '%s\\n' "$eum_claude_check_exit_code" > ${shellQuote(statusPath)}; exit "$eum_claude_check_exit_code"`,
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
	const works =
		authorization.worksRuntime && resolvePath(authorization.worksRuntime);
	const digestInputs = (exclude?: string) =>
		claudeInputDigest(readable, exclude, !!works);
	const executable = works ? realpathSync(process.execPath) : "";
	if (
		works &&
		(contained(workspace, works) ||
			contained(works, workspace) ||
			authorization.checks.some(
				(check) =>
					check.cwd !== workspace ||
					realpathSync(check.executable) !== executable ||
					check.args.length !== 9 ||
					check.args[0] !== "--no-env-file" ||
					check.args[1] !== "--no-install" ||
					check.args[2] !== "--no-macros" ||
					check.args[3] !== `--config=${join(works, "bunfig.toml")}` ||
					check.args[4] !== `--cwd=${works}` ||
					check.args[5] !== join(works, "check.ts") ||
					!["typecheck", "build"].includes(check.args[6]!) ||
					!/^\d+\.\d+$/.test(check.args[7]!) ||
					check.args[8] !== workspace,
			))
	)
		throw new Error(verificationUnavailable);
	let currentDigest = digestInputs();
	const baseline = priorInputDigest ?? authorization.baselineInputDigest;
	if (
		(baseline && currentDigest !== baseline) ||
		(mode !== "read" && !currentDigest)
	)
		throw new Error(workspaceInputsChanged);
	let commands = new Map<string, { check: ClaudeCheck; wrapped: string }>();
	const sandbox = authorization.checks.length
		? createCheckSandbox(
				workspace,
				spec.id,
				works ? { works: { runtime: works, readable, executable } } : undefined,
			)
		: undefined;
	let unpin: (() => void) | undefined;
	if (sandbox) {
		try {
			if (works) unpin = pinCheckRuntime(works, authorization.checks);
			commands = new Map(
				authorization.checks.map((check) => [
					claudeCheckRequest(check),
					{ check, wrapped: sandbox.command(check) },
				]),
			);
		} catch (error) {
			try {
				sandbox.cleanup();
			} finally {
				unpin?.();
			}
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
			const inputDigest = digestInputs();
			if (!inputDigest || inputDigest !== currentDigest) return;
			const witnessed = sandbox.withExitStatus(command.wrapped);
			return {
				input: {
					command: witnessed.command,
					timeout: Math.max(1, Math.min(600_000, spec.deadline - Date.now())),
				},
				statusPath: witnessed.statusPath,
				stderrPath: witnessed.stderrPath,
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
		if (works && search) return;
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
		const inRuntime =
			!edit && !!works && contained(works, path) && /\.d\.[cm]?ts$/.test(path);
		if (
			!inRuntime &&
			(!contained(workspace, path) ||
				contained(join(workspace, ".git"), path) ||
				(!!works &&
					relative(workspace, path)
						.split("/")
						.some(
							(name) =>
								name.startsWith(".") ||
								name === "node_modules" ||
								name === "dist",
						)) ||
				!(edit ? writable : readable).some((parent) => contained(parent, path)))
		)
			return;
		const inputDigest = digestInputs();
		let editGuard: ToolRequest["editGuard"];
		if (edit) {
			if (!inputDigest || inputDigest !== currentDigest) return;
			const unrelatedDigest = digestInputs(path);
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
		{ fact, statusPath, stderrPath, editGuard }: ToolRequest,
		output: unknown,
		success: boolean,
	): ToolEvidence | undefined {
		if (fact.kind === "check") {
			const after = digestInputs();
			const result =
				output && typeof output === "object"
					? (output as Record<string, unknown>)
					: {};
			let exitCode: number | undefined;
			let stderr: string | undefined;
			try {
				const status = statusPath ? readPrivate(statusPath) : "";
				if (/^[0-9]{1,3}\n$/.test(status) && Number(status) <= 255)
					exitCode = Number(status);
				if (stderrPath) stderr = readPrivate(stderrPath).slice(0, 1024);
			} catch {}
			const passed =
				success &&
				exitCode === 0 &&
				!result.interrupted &&
				!result.backgroundTaskId &&
				!result.backgroundedByUser &&
				!result.timedOutAfterMs &&
				!!fact.inputDigest &&
				fact.inputDigest === after;
			return {
				...fact,
				passed,
				...(exitCode === undefined ? {} : { exitCode }),
				...(stderr === undefined ? {} : { stderr }),
				text: JSON.stringify(output ?? "").slice(0, 1_024),
			};
		}
		if (!success) return;
		const after = digestInputs();
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
				editGuard.unrelatedDigest !== digestInputs(fact.path)
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

	function editConflict(
		tool: string,
		input: Record<string, unknown>,
	): ToolEvidence | undefined {
		if (
			!works ||
			mode !== "edit" ||
			(tool !== "Write" && tool !== "Edit") ||
			typeof input.file_path !== "string"
		)
			return;
		try {
			const path = resolvePath(resolve(workspace, input.file_path));
			if (
				!writable.some((parent) => contained(parent, path)) ||
				relative(workspace, path)
					.split("/")
					.some(
						(name) =>
							name.startsWith(".") ||
							name === "node_modules" ||
							name === "dist",
					) ||
				digestInputs() === currentDigest
			)
				return;
			const proposal =
				tool === "Edit"
					? { before: input.old_string, after: input.new_string }
					: { replacement: input.content };
			return {
				kind: "edit_conflict",
				targetRevision,
				path,
				text: `workspace_inputs_changed: unapplied edit to ${relative(workspace, path)}\n${JSON.stringify(proposal)}`.slice(
					0,
					1_024,
				),
			};
		} catch {
			return;
		}
	}

	return {
		toolRequest,
		toolEvidence,
		editConflict,
		inputDigest: () => currentDigest,
		commands: [...commands.keys()],
		readablePaths: [...new Set(readable)],
		writablePaths: writable,
		cleanup: sandbox
			? () => {
					try {
						sandbox.cleanup();
					} finally {
						unpin?.();
						unpin = undefined;
					}
				}
			: undefined,
	};
}

function pinCheckRuntime(runtime: string, checks: readonly ClaudeCheck[]) {
	const parent = dirname(runtime);
	const version = basename(runtime);
	if (
		basename(parent) !== "releases" ||
		!/^[1-9]\d*\.\d+$/.test(version) ||
		checks.some((check) => check.args[7] !== version)
	)
		throw new Error(verificationUnavailable);
	const path = join(dirname(parent), "locks", version);
	if (!existsSync(path)) throw new Error(verificationUnavailable);
	try {
		return lock(path, "shared");
	} catch {
		throw new Error(verificationUnavailable);
	}
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
