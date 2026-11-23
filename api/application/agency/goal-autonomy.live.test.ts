import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	closeSync,
	cpSync,
	existsSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
	GoalAttempt,
	GoalProgress,
	GoalReportV1,
} from "eumenes-agency/agenda/runtime";
import type { Settings } from "../../domains/settings";
import { readApiToken } from "../../infrastructure/auth-config";
import { serveSupervisionTrialRunner } from "../work/supervision-parallel-runner.fixture";
import { checkReadme } from "../../../spec/verification/goal-autonomy-2026-11-23/check-readme";

const live = process.env.EUMENES_GOAL_AUTONOMY_LIVE === "1";
const project = resolve(import.meta.dir, "../../..");
const fixture = join(project, "spec/verification/goal-autonomy-2026-11-23");
const utterance =
	"「このサンプルの README に載った手順をそのまま実行すると、件数3・合計12の JSON が得られる」を目標に登録して進めてください。まず今の手順を実行して結果を残してください。この試験用の作業場所で、同梱資料の参照、README の編集、サンプルと検査の実行を許可します。";
type Audit = {
	rows: Array<GoalProgress & { attempts: GoalAttempt[] }>;
	reports: { state: string; report: GoalReportV1 }[];
	mockWork: number;
	workers: { id: string; dispatchId: string; goalId: string }[];
	runnerReady: boolean;
	children: {
		id: string;
		parentId: string;
		executionId: string | null;
		runnerState: string | null;
		executions: number;
		evidence: string | null;
	}[];
};

async function until<T>(
	label: string,
	read: () => T | undefined | Promise<T | undefined>,
	timeout: number,
) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(300);
	}
	throw new Error("goal_acceptance_timeout:" + label);
}
async function json<T>(url: string, token: string, body?: unknown): Promise<T> {
	const response = await fetch(url, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Authorization: "Bearer " + token,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(12_000),
	});
	if (!response.ok) {
		const error = (await response.json().catch(() => ({}))) as {
			error?: string;
			issues?: { code: string; path: string[] }[];
		};
		throw new Error(
			"goal_acceptance_http:" +
				new URL(url).pathname +
				":" +
				response.status +
				":" +
				error.error +
				(error.issues
					?.map(({ code, path }) => code + "@" + path.join("."))
					.join(",") ?? ""),
		);
	}
	return response.json() as Promise<T>;
}
async function selectedInference() {
	const token = readApiToken(
		process.env,
		join(project, "data/eumenes.sqlite3"),
	);
	const endpoint = "http://127.0.0.1:" + (process.env.EUMENES_PORT ?? "8787");
	const settings = await json<Settings>(endpoint + "/api/settings", token);
	const active = settings.resources.find(
		({ id }) => id === settings.routes.llm.fallbackId,
	);
	const connection = settings.connections.find(
		({ id }) => id === active?.connectionId,
	);
	if (!active || connection?.kind !== "codex-sdk" || !connection.enabled)
		throw new Error("goal_acceptance_selected_codex_unavailable");
	return {
		model: active.model,
		contextWindow: active.contextWindow,
		baseUrl: connection.baseUrl,
		effort: settings.general.reasoningEffort,
	};
}
function seed(root: string) {
	cpSync(join(fixture, "workspace"), root, { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	git("init", "-q");
	git("add", ".");
	git(
		"-c",
		"user.name=Goal Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"fixed baseline",
	);
	return git;
}
async function backend(
	dir: string,
	root: string,
	socket: string,
	token: string,
) {
	const id = crypto.randomUUID();
	const ready = join(dir, id + ".port");
	const log = join(dir, id + ".log");
	const workspace = {
		ref: "isolated-sample",
		root,
		readablePaths: ["README.md", "sample.mjs"],
		writablePaths: ["README.md"],
		checks: [
			{
				ref: "published-invocation",
				description:
					"現状の掲載コマンドをそのまま一度実行して、終了コードと標準エラーを確認する。",
				command: process.execPath,
				args: ["sample.mjs", "--style", "json"],
				cwd: root,
			},
			{
				ref: "independent-verification",
				description:
					"現在の文書のコマンドを別の場所で再実行し、固定の期待JSONを検査する。",
				command: process.execPath,
				args: [join(fixture, "check-readme.ts"), root],
				cwd: root,
				acceptance: true,
			},
		],
	};
	const stream = openSync(log, "w", 0o600);
	const processHandle = Bun.spawn(
		[
			process.execPath,
			"--no-env-file",
			join(import.meta.dir, "goal-autonomy-backend.fixture.ts"),
			ready,
		],
		{
			cwd: project,
			stdin: "ignore",
			stdout: stream,
			stderr: stream,
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				HOME: process.env.HOME ?? "",
				USER: process.env.USER ?? "",
				SHELL: process.env.SHELL ?? "/bin/zsh",
				LANG: process.env.LANG ?? "en_US.UTF-8",
				EUMENES_API_TOKEN: token,
				EUMENES_DB: join(dir, "test.sqlite"),
				EUMENES_LOG_FILE: "-",
				EUMENES_CLAUDE_WORK_RUNNER_SOCKET: socket,
				EUMENES_GOAL_WORKSPACES: JSON.stringify([workspace]),
			},
		},
	);
	closeSync(stream);
	const close = async () => {
		if (processHandle.exitCode !== null) return;
		processHandle.kill("SIGTERM");
		const timer = setTimeout(() => {
			if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
		}, 12_000);
		try {
			await processHandle.exited;
		} finally {
			clearTimeout(timer);
		}
	};
	try {
		const port = await until(
			"backend_start",
			() => {
				if (processHandle.exitCode !== null)
					throw new Error(
						"goal_acceptance_backend_exit:" + processHandle.exitCode,
					);
				return existsSync(ready)
					? Number(readFileSync(ready, "utf8"))
					: undefined;
			},
			25_000,
		);
		const request = <T>(path: string, body?: unknown) =>
			json<T>("http://127.0.0.1:" + port + path, token, body);
		return {
			pid: processHandle.pid,
			request,
			close,
			audit: () => request<Audit>("/api/goal-acceptance-observation"),
		};
	} catch (error) {
		await close();
		throw new Error("goal_acceptance_backend_unavailable:" + log, {
			cause: error,
		});
	}
}
async function setup(
	request: Awaited<ReturnType<typeof backend>>["request"],
	model: Awaited<ReturnType<typeof selectedInference>>,
) {
	const settings = await request<Settings>("/api/settings");
	const connectionId = crypto.randomUUID();
	const resourceId = crypto.randomUUID();
	await request("/api/settings/apply", {
		requestId: crypto.randomUUID(),
		expectedRevision: settings.revision,
		keys: [],
		settings: {
			...settings,
			connections: [
				...settings.connections,
				{
					id: connectionId,
					kind: "codex-sdk",
					name: "隔離試験の推論",
					baseUrl: model.baseUrl,
					enabled: true,
					epoch: 0,
					envRef: null,
				},
			],
			resources: [
				...settings.resources,
				{
					id: resourceId,
					connectionId,
					purpose: "llm",
					model: model.model,
					contextWindow: model.contextWindow,
					voice: null,
				},
			],
			routes: {
				...settings.routes,
				llm: {
					...settings.routes.llm,
					mode: "cloud-only",
					cloudAllowed: true,
					fallbackId: resourceId,
				},
			},
			general: { ...settings.general, reasoningEffort: model.effort },
		},
	});
	return resourceId;
}

test.skipIf(!live)(
	"a registered goal changes method after real failure, resumes the accepted repair after restart and reports independently verified output once",
	async () => {
		const dir = realpathSync(mkdtempSync("/tmp/eum-goal-live-"));
		const root = join(dir, "checkout");
		const git = seed(root);
		const baseline = git("rev-parse", "HEAD");
		const model = await selectedInference();
		const runner = await serveSupervisionTrialRunner(join(dir, "runner"), root);
		const token = crypto.randomUUID();
		let app: Awaited<ReturnType<typeof backend>> | undefined;
		let success = false;
		try {
			app = await backend(dir, root, runner.socket, token);
			expect((await app.audit()).runnerReady).toBe(true);
			const resourceId = await setup(app.request, model);
			const conversationId = "goal-autonomy-live";
			const run = await app.request<{ id: string }>("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId,
				text: utterance,
			});
			await until(
				"utterance",
				async () => {
					const state = await app!.request<{ status: string }>(
						"/api/runs/" + run.id,
					);
					if (state.status === "failed")
						throw new Error("goal_acceptance_conversation_failed");
					return state.status === "completed" ? true : undefined;
				},
				150_000,
			);
			const failed = await until(
				"first_real_failed_attempt",
				async () => {
					const row = (await app!.audit()).rows[0];
					return row?.attempts.find(
						({ outcome, observed }) =>
							outcome === "failed" &&
							/終了コード 2\b/.test(observed ?? "") &&
							/標準エラー Unknown option/.test(observed ?? ""),
					);
				},
				180_000,
			);
			expect(failed.ownerWorkId).toBeTruthy();
			console.log(
				JSON.stringify({
					checkpoint: "first_real_failed_attempt",
					id: failed.id,
					ownerWorkId: failed.ownerWorkId,
					observed: failed.observed,
				}),
			);
			const { repair, child } = await until(
				"accepted_repair",
				async () => {
					const audit = await app!.audit();
					const repair = audit.rows[0]?.attempts.find(
						(attempt) =>
							attempt.id !== failed.id &&
							attempt.step.capabilityRef.endsWith(":edit") &&
							attempt.ownerWorkId !== null &&
							attempt.outcome === "running",
					);
					const child =
						repair &&
						audit.children.find(
							(item) =>
								item.parentId === repair.ownerWorkId &&
								item.executionId !== null &&
								item.runnerState === "running",
						);
					return repair && child ? { repair, child } : undefined;
				},
				420_000,
			);
			console.log(
				JSON.stringify({
					checkpoint: "accepted_repair",
					dispatchId: repair.dispatchId,
					ownerWorkId: repair.ownerWorkId,
					child: { ...child, evidence: undefined },
				}),
			);
			const priorPid = app.pid;
			await app.close();
			app = await backend(dir, root, runner.socket, token);
			expect(app.pid).not.toBe(priorPid);
			const finished = await until(
				"completed_and_delivered",
				async () => {
					const result = await app!.audit();
					return result.rows[0]?.phase === "completed" &&
						result.reports[0]?.state === "delivered"
						? result
						: undefined;
				},
				300_000,
			);
			const result = checkReadme(root);
			expect(result).toMatchObject({ passed: true, exitCode: 0 });
			expect(JSON.parse("stdout" in result ? result.stdout : "{}")).toEqual({
				count: 3,
				total: 12,
			});
			expect(git("diff", "--name-only", baseline)).toBe("README.md");
			expect(git("ls-files", "--others", "--exclude-standard")).toBe("");
			expect(finished.mockWork).toBe(0);
			expect(finished.reports).toHaveLength(1);
			expect(
				finished.workers.filter(
					({ dispatchId }) => dispatchId === repair.dispatchId,
				),
			).toEqual([expect.objectContaining({ id: repair.ownerWorkId })]);
			expect(
				new Set(finished.workers.map(({ dispatchId }) => dispatchId)).size,
			).toBe(finished.workers.length);
			const repairChildren = finished.children.filter(
				({ parentId }) => parentId === repair.ownerWorkId,
			);
			expect(repairChildren).toEqual([
				expect.objectContaining({
					id: child.id,
					executionId: child.executionId,
					executions: 1,
				}),
			]);
			const edited = (
				JSON.parse(repairChildren[0]?.evidence ?? "[]") as {
					kind: string;
					ref: string;
					path?: string;
					executionId: string;
				}[]
			).find(
				({ kind, path, executionId }) =>
					kind === "edit" &&
					path === join(root, "README.md") &&
					executionId === child.executionId,
			);
			expect(edited).toBeDefined();
			const accepted = finished.rows[0]!.attempts.find(
				({ id }) => id === repair.id,
			);
			expect(accepted).toMatchObject({
				ownerWorkId: repair.ownerWorkId,
				outcome: "succeeded",
			});
			expect(accepted?.evidenceRefs).toContain(edited!.ref);
			expect(
				finished.rows[0]!.state.evidence.some(({ ref }) => ref === edited!.ref),
			).toBe(true);
			const conversation = await app.request<{
				messages: { id: string; role: string }[];
			}>("/api/conversations/" + conversationId);
			expect(
				conversation.messages.filter(({ role }) => role === "user"),
			).toHaveLength(1);
			expect(
				conversation.messages.filter(
					({ id }) =>
						id === "agency-goal-report:" + finished.reports[0]!.report.id,
				),
			).toHaveLength(1);
			const manifest = await Bun.file(
				join(project, "vendor/agency/manifest.json"),
			).json();
			console.log(
				JSON.stringify({
					agencySha: manifest.sha256,
					resourceId,
					goalId: finished.rows[0]!.goalId,
					goalRevision: finished.rows[0]!.goalRevision,
					attempts: finished.rows[0]!.attempts.map(
						({ id, dispatchId, ownerWorkId, ownerRevision, outcome }) => ({
							id,
							dispatchId,
							ownerWorkId,
							ownerRevision,
							outcome,
						}),
					),
					backendProcesses: [priorPid, app.pid],
					repairExecution: {
						...child,
						evidence: undefined,
						editEvidence: edited?.ref,
					},
					verification: result,
					criteria: finished.reports[0]!.report.criteria,
					proof: finished.reports[0]!.report.evidence.map(
						({ ref, summary, version, digest }) => ({
							ref,
							summary,
							version,
							digest,
						}),
					),
					reportId: finished.reports[0]!.report.id,
				}),
			);
			success = true;
		} finally {
			await app?.close();
			await runner.close();
			if (success) rmSync(dir, { recursive: true, force: true });
			else console.error("goal acceptance evidence " + dir);
		}
	},
	1_100_000,
);
