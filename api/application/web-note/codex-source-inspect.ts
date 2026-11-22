import {
	mkdir,
	mkdtemp,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexTurn } from "../../../packages/coding-runner/src/codex-turn";
import {
	codexRuntime,
	createCodexHome,
	disabledFeatures,
} from "../../domains/inference";
import type { InspectSource } from "../../domains/web-note";
import { sourceReportSchema, sourceResult } from "./source-report";
import { copySourceSnapshot, resolveSourceCommit } from "./source-snapshot";
import { copySourceWorktree } from "./source-worktree";
import { sourceExcerpt } from "./source-excerpt";

const prefix = "eumenes-source-inspect-";
const permission = "eumenes-source";

function permissions(directory: string) {
	return [
		`default_permissions="${permission}"`,
		`permissions.${permission}.filesystem={":minimal"="read",${JSON.stringify(directory)}="read"}`,
		`permissions.${permission}.network.enabled=false`,
	];
}

async function verifyPermissions(
	command: string,
	env: Record<string, string>,
	directory: string,
	outside: string,
	signal: AbortSignal,
) {
	const probe = Bun.spawn(
		[
			command,
			"sandbox",
			"-P",
			permission,
			"-C",
			directory,
			...permissions(directory).flatMap((value) => ["-c", value]),
			"--",
			"/bin/sh",
			"-c",
			[
				'/bin/cat "$1" >/dev/null',
				'! /bin/cat "$2" >/dev/null 2>&1',
				'! /usr/bin/touch "$3" 2>/dev/null',
				'/usr/bin/nc -zv -G 1 127.0.0.1 9 2>&1 | /usr/bin/grep -Fq "Operation not permitted"',
			].join(" && "),
			"source-permission-check",
			join(directory, "read-check"),
			outside,
			join(directory, "write-check"),
		],
		{
			cwd: directory,
			env: { ...env, LC_ALL: "C" },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			signal,
		},
	);
	if ((await probe.exited) !== 0)
		throw new Error("inspect_source_isolation_unavailable");
	signal.throwIfAborted();
}

async function recoverDirectories(root: string) {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const match = /^eumenes-source-inspect-([1-9][0-9]*)-[A-Za-z0-9]+$/u.exec(
			entry.name,
		);
		if (!entry.isDirectory() || !match) continue;
		try {
			process.kill(Number(match[1]), 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH")
				await rm(join(root, entry.name), {
					recursive: true,
					force: true,
				}).catch(() => {});
		}
	}
}

export async function createCodexSourceInspect(
	environment: Readonly<Record<string, string | undefined>>,
	executable: string,
	repository: string,
	run = runCodexTurn,
): Promise<InspectSource | undefined> {
	const runtime = codexRuntime(environment, executable);
	if (!runtime || process.platform !== "darwin") return;
	const personalHome =
		runtime.env.CODEX_HOME ??
		(runtime.env.HOME ? join(runtime.env.HOME, ".codex") : null);
	const root = await realpath(tmpdir()).catch(() => null);
	if (!root) return;
	await recoverDirectories(root).catch(() => {});
	const prepare = () => mkdtemp(join(root, `${prefix}${process.pid}-`));

	// Probe the effective profile before making the capability selectable.
	const probe = await prepare().catch(() => null);
	if (!probe) return;
	try {
		const directory = join(probe, "source");
		const outside = join(probe, "denied");
		await mkdir(directory);
		await Promise.all([
			writeFile(join(directory, "read-check"), ""),
			writeFile(outside, ""),
		]);
		await verifyPermissions(
			runtime.command,
			runtime.env,
			directory,
			outside,
			AbortSignal.timeout(3000),
		);
		await resolveSourceCommit(repository, AbortSignal.timeout(3000));
	} catch {
		return;
	} finally {
		await rm(probe, { recursive: true, force: true }).catch(() => {});
	}

	return {
		resolveCommit: (signal) => resolveSourceCommit(repository, signal),
		async inspect({ commit, prompt, signal }) {
			const temporary = await prepare();
			try {
				const directory = join(temporary, "workspace");
				const sources = join(directory, "source");
				const baseline = join(directory, "before");
				const launcher = join(temporary, "codex");
				const home = createCodexHome(
					join(temporary, "codex-home"),
					personalHome ? join(personalHome, "auth.json") : null,
				);
				await home.ready();
				// The SDK's configuration API cannot pass these CLI flags. The launcher adds them
				// before the SDK's options without evaluating any of the prompt or arguments.
				await writeFile(
					launcher,
					'#!/bin/sh\n[ "$1" = "exec" ] || exit 64\nshift\nexec "$EUMENES_INSPECT_CODEX" exec --ephemeral --ignore-user-config --ignore-rules "$@"\n',
					{ mode: 0o700, flag: "wx" },
				);
				const previous = await copySourceSnapshot(
					repository,
					baseline,
					commit,
					signal,
				);
				const { current, removed } = await copySourceWorktree(
					repository,
					sources,
					previous,
					signal,
				);
				const lineCounts = new Map(current);
				for (const path of removed) lineCounts.set(path, previous.get(path)!);
				const turn = await run({
					command: launcher,
					env: {
						...runtime.env,
						CODEX_HOME: home.path,
						EUMENES_INSPECT_CODEX: runtime.command,
					},
					reasoning: "low",
					webSearch: "disabled",
					inspection: { directory, outputSchema: sourceReportSchema },
					config: {
						features: {
							...disabledFeatures,
							code_mode_host: true,
							shell_tool: true,
							shell_snapshot: false,
							hooks: false,
							request_permissions_tool: false,
							skip_host_skill_discovery: true,
						},
						project_doc_max_bytes: 0,
						history: { persistence: "none" },
						allow_login_shell: false,
						shell_environment_policy: {
							inherit: "none",
							set: { PATH: "/usr/bin:/bin" },
						},
					},
					configOverrides: [...permissions(directory), "mcp_servers={}"],
					prompt: `${prompt}\n\n現在のコードは source/、比較用の元コードは before/ にあります。根拠の行番号は現在のコードを使い、削除されたファイルだけ元コードを使います。path は source/ や before/ を含めないリポジトリ相対パスです。symbol は根拠が属する関数や型の名前です。該当しなければ null にします。depth は依頼に応じて small・medium・large を選び、指定がなければ medium とします。概要はパス、ハッシュ、コード抜粋を含めない短い日本語にします。`,
					signal,
				});
				if (turn.searches)
					throw new Error("inspect_source_unexpected_web_search");
				return {
					result: await sourceResult(
						turn.text,
						lineCounts,
						({ path, startLine, endLine }) =>
							sourceExcerpt(
								baseline,
								sources,
								path,
								previous.has(path),
								current.has(path),
								startLine,
								endLine,
								signal,
							),
						commit,
					),
					usage: turn.usage,
				};
			} finally {
				await rm(temporary, { recursive: true, force: true });
			}
		},
	};
}
