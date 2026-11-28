import { strict as assert } from "node:assert";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assignmentFixture } from "../../../api/application/toolchain/assignment.fixture";
import { candidatesOf, delegate, findToolchain, afterUtterance, toolResults } from "../../../api/application/toolchain/conversation-script.fixture";
import { prototypeExecution } from "../../../api/application/prototype/execution";
import { prototypeResource, createPrototypeService } from "../../../api/domains/prototype";
import { template } from "../../../api/domains/prototype/projects";
import { runBuild } from "../../../api/domains/prototype/runtime/build";
import { collect } from "../../../api/domains/prototype/runtime/project";
import { claudeRunnerClient, workspaceGit as git } from "../../../api/domains/coding";
import { serveClaudeRunner } from "../../../api/domains/coding/test/claude-server.fixture";
import { createDefaultClaudePrepare } from "../../../packages/coding-runner/src/claude-policy";
import { supervisedTools, claudeCheckRequest } from "../../../packages/coding-runner/src/claude-supervised-tools";
import { claudeStart } from "../../../packages/coding-runner/src/claude-contracts";
import { chromium, expect } from "@playwright/test";
import { configureLogging } from "../../../api/infrastructure/logger";
import { replyWith } from "../../../api/application/agency/always-on.fixture";
import { readWorkspaceGuards } from "../../../api/domains/kanban";
import { prepareWorksWeb } from "./web";

configureLogging({level:"error"});

const withClosure = process.argv.includes("--p2-remaining");
const withDependency = process.argv.includes("--dependency");
const withTwoWorks = process.argv.includes("--two-works");
const core = resolve(import.meta.dir, "../../..");
const temp = realpathSync(mkdtempSync("/tmp/works-p2-"));
const home = join(temp, "runtime");
const works = join(temp, "projects");
const state = join(temp, "state");
const fixtures = join(temp, "fixture");
const source = join(temp, "source");
const a = join(works, "alpha");
const b = join(works, "beta");
for (const dir of [works, state, fixtures]) mkdirSync(dir);
function exec(args: string[]) {
	const result = Bun.spawnSync(args, { cwd: core, stdout: "pipe", stderr: "pipe", timeout: 90_000 });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString();
}
const tool = (...args: string[]) => exec([process.execPath, "--no-env-file", "scripts/works-runtime.ts", ...args]);
const commit = (root: string) => {
	git(root, ["init", "--initial-branch=main", "--template="]);
	git(root, ["add", "."]);
	git(root, ["-c", "user.name=Works fixture", "-c", "user.email=works@example.invalid", "commit", "-m", "fixture"]);
};
function addCompatibilityAssets(project: string) {
	writeFileSync(join(project, "assets/sample.txt"), "Works asset\n");
	writeFileSync(join(project, "src/fixture.css"), "h1 { color: navy; }\n");
	appendFileSync(join(project, "src/main.tsx"), '\nimport "./fixture.css";\n');
}
async function until<T>(label: string, fn: () => Promise<T | null> | T | null, timeout = 90_000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value !== null) return value;
		await Bun.sleep(350);
	}
	throw new Error("timeout:" + label);
}
let server: ReturnType<typeof Bun.serve> | undefined;
let views: ReturnType<typeof createPrototypeService> | undefined;
let runner: Awaited<ReturnType<typeof serveClaudeRunner>> | undefined;
let assignment: Awaited<ReturnType<typeof assignmentFixture>> | undefined;
let fixture: NonNullable<typeof assignment>["h"] | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const ports = new Set<number>();
const measuredPids = new Set<number>();
function liveDaemonPids() {
	return exec(["/bin/ps","-axo","pid=,args="]).split("\n").flatMap(line=>{
		const match=/^\s*(\d+)\s+(.*)$/.exec(line);
		return match && match[2]?.includes("claude-cli.ts serve "+state+"/runner-") ? [Number(match[1])] : [];
	});
}
function physicalBytes(pid:number) {
	const match=/^\s*phys_footprint:\s*(\d+) B/m.exec(exec(["/usr/bin/footprint","--noCategories","-f","bytes","-p",String(pid)]));
	assert(match);return Number(match[1]);
}
let step = "setup";
try {
	tool("export", source);
	commit(source);
	git(source, ["tag", "works-v2.0"]);
	const pin = JSON.parse(tool("pin", source, "2.0"));
	tool("install", home, source, "2.0", pin.commit, pin.digest);
	template(a, "Alpha", "2.0");
	template(b, "Beta", "2.0");
	if (withDependency) addCompatibilityAssets(b);
	for (const project of [a, b]) commit(project);
	const alphaSource = join(a, "src/main.tsx");
	const originalSource = readFileSync(alphaSource, "utf8");
	const readme = join(a, "README.md");
	appendFileSync(readme, "\nUncommitted user notes.\n");
	const readmeBefore = readFileSync(readme, "utf8");
	const betaBefore = readFileSync(join(b, "src/main.tsx"), "utf8");
	const alphaHead = git(a, ["rev-parse", "HEAD"]);
	const alphaIndex = git(a, ["diff", "--cached", "--binary"]);
	const stashBefore = git(a, ["stash", "list"]);
	let web: Awaited<ReturnType<typeof prepareWorksWeb>> | undefined;
	server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch(req) {
		return web?.(req) ?? fixture!.app.fetch(req);
	} });
	const origin = "http://localhost:" + server.port;
	ports.add(server.port!);
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const previewPort = probe.port!;
	ports.add(previewPort);
	await probe.stop(true);
	views = createPrototypeService({ core, data: state, works, runtime: home, parentOrigin: origin,
		previewPort, defaultVersion: "2.0",
		inUse: (id) => fixture?.store.read(db => readWorkspaceGuards(db, "prototype:" + id).length > 0) ?? false,
	});
	const alpha = views.register(a);
	const beta = views.register(b);
	for (const [folder, label] of [["gamma", "Gamma"], ["delta", "Delta"], ["epsilon", "Epsilon"]]) {
		const project = join(works, folder);
		template(project, label, "2.0");
		if (withDependency && folder === "gamma") addCompatibilityAssets(project);
		commit(project);
		views.register(project);
	}
	assert.equal(views.list().projects.length, 5);
	const runtime = views.editTarget(alpha.id).runtime;
	async function otherBuilds() {
		const result = [];
		for (const work of [b, join(works, "gamma")]) {
			for (const mode of ["host", "standalone"] as const) {
				const scratch = mkdtempSync(join(temp, "compatibility-"));
				try {
					const target = join(scratch, "output");
					const build = await runBuild({ runtime, snapshot: collect(work), work: scratch,
						target, mode, typecheck: true, strict: true, build: true });
					assert(build.built, JSON.stringify(build.diagnostics));
					const hashes = [...new Bun.Glob("**/*").scanSync({ cwd: target })].sort()
						.map(path => [path, new Bun.CryptoHasher("sha256").update(readFileSync(join(target, path))).digest("hex")]);
					assert(hashes.some(([path]) => path === "app.css"));
					assert(hashes.some(([path]) => path.endsWith("/sample.txt")));
					result.push(hashes);
				} finally { rmSync(scratch, { recursive: true, force: true }); }
			}
		}
		return result;
	}
	const dupe = join(works, "second-alpha");
	if (withClosure) {
		template(dupe, "Alpha", "2.0"); commit(dupe); views.register(dupe);
	}
	const earlierOutputs = withDependency ? await otherBuilds() : [];
	const check = (mode: string) => ({ cwd: a, executable: realpathSync(process.execPath),
		args: ["--no-env-file", "--no-install", "--no-macros", "--config=" + join(runtime, "bunfig.toml"),
			"--cwd=" + runtime, join(runtime, "check.ts"), mode, "2.0", a] });
	const deadline = Date.now() + 160_000;
	const spec = claudeStart.parse({ id: crypto.randomUUID(), workId: crypto.randomUUID(), generation: 0,
		instruction: "Fixture", priorExecutionId: null, deadline, maxTurns: 1, readOnly: false, supervised: {
			lease: { ownerRef: "fixture", executorId: "fixture", epoch: "1", slot: "exclusive" },
			authorization: { workspaceRef: "fixture", mode: "edit", targetRevision: "1:2.0", deadline,
				worksRuntime: runtime, readablePaths: ["src","assets","README.md","prototype.json","package.json"].map(p => join(a,p)),
				writablePaths: ["src"].map(p => join(a,p)), checks: [check("typecheck"), check("build")] },
		} });
	assert(spec.supervised);
	const runChecks = (shouldPass: boolean) => {
		const guard = supervisedTools({ ...spec, id: crypto.randomUUID(), supervised: spec.supervised! }, a);
	try {
		assert(!guard.toolRequest("Read", { file_path: join(b, "src/main.tsx") }));
		assert(!guard.toolRequest("Read", { file_path: join(a, "src/.env") }));
		assert(!guard.toolRequest("Bash", { command: "bun install" }));
		assert(!guard.toolRequest("Bash", { command: "git add ." }));
		for (const mode of ["typecheck", "build"]) {
			const request = guard.toolRequest("Bash", { command: claudeCheckRequest(check(mode)) });
			assert(request);
			const ran = Bun.spawnSync(["/bin/sh", "-c", request.input.command as string], { cwd: a, stdout: "pipe", stderr: "pipe" });
			const result = guard.toolEvidence(request, {stdout: ran.stdout.toString()}, ran.exitCode === 0);
			assert.equal(result?.passed, shouldPass, ran.stdout.toString() + ran.stderr.toString());
		}
	} finally { guard.cleanup?.(); }
	};
	runChecks(true);
	try {
		appendFileSync(alphaSource, '\nconst deliberateTypeError: number = "fixture";\n');
		runChecks(false);
	} finally {
		writeFileSync(alphaSource, originalSource);
	}
	const conflict = supervisedTools({ ...spec, id: crypto.randomUUID(), supervised: spec.supervised }, a);
	try {
		assert(conflict.toolRequest("Read", { file_path: alphaSource }));
		appendFileSync(alphaSource, "\n// Codex changed this while the work was open.\n");
		const saved = readFileSync(alphaSource, "utf8");
		const edit = { file_path: alphaSource, old_string: ">Works<", new_string: ">Claude draft<" };
		assert.equal(conflict.toolRequest("Edit", edit), undefined);
		assert.match(conflict.editConflict("Edit", edit)?.text ?? "", /Claude draft/);
		assert.equal(readFileSync(alphaSource, "utf8"), saved);
	} finally {
		conflict.cleanup?.();
		writeFileSync(alphaSource, originalSource);
	}
	console.log("registered checks actually passed");
	if (process.argv.includes("--checks-only")) process.exitCode = 0;
	else {
		step = "Web build";
		web = await prepareWorksWeb({ core, temp, origin, previewPort, works: views });
		step = "claude runner lineup";
		const runnerRoot = join(temp, "runner");
		const production = prototypeExecution(views, state, [core, state], { source, home, works });
		if (!withTwoWorks) {
			const policy = createDefaultClaudePrepare({ root: runnerRoot, workspace: a, protectedPaths: [core, state, b] });
			runner = await serveClaudeRunner(runnerRoot, a, policy.prepare);
		}
		const native = runner && claudeRunnerClient(runner.socket, a);
		if(native) assert.equal(await native.probe(), true);
		const operations: Parameters<ReturnType<typeof claudeRunnerClient>["start"]>[0][] = [];
		const daemonClients = new Map<string,ReturnType<typeof production.runner>>();
		const daemonSamples: {pid:number;idleBytes:number}[]=[];
		const hostBefore = withTwoWorks ? physicalBytes(process.pid) : undefined;
		const host = { ...production, runner: (target: ReturnType<typeof views.editTarget>) => {
			assert(withTwoWorks ? [alpha.id,beta.id].includes(target.id) : target.id===alpha.id);
			const connection = native ?? production.runner(target);
			if (withTwoWorks) daemonClients.set(target.id,connection);
			return { ...connection, start: async (op: Parameters<typeof connection.start>[0]) => {
				if (!operations.some(item => item.id === op.id)) operations.push(op);
				assert.throws(() => views!.remove(target.id), /prototype_workspace_busy/);
				return connection.start(op);
			} };
		} };
		const titles = withDependency ? ["Works dependency approved"] : ["Works P2 first", withTwoWorks ? "Works P4 second" : "Works P2 revised"];
		const utterances = withClosure ? ["WorksのAlphaに型が不一致の例を追加してください。"] : withDependency ? ["WorksのAlphaでnanoidを使い、見出しを Works dependency approved に変更してください。"] : [
			"WorksのAlphaで画面の見出しを Works P2 first に修正してください。",
			withTwoWorks ? "WorksのBetaで見出しを Works P4 second に修正してください。" : "同じWorks作品でもう一度修正し、見出しを Works P2 revised に変えてください。",
		];
		let selectedRef: string | undefined;
		const delegationReceipts = new Map<number,string>();
		assignment = await assignmentFixture({
			agency: new Proxy({}, { get(_obj, key) {
				return Reflect.get(assignment?.f.host.dialoguePort ?? {}, key);
			} }),
			directory: fixtures, origin, resources: true, routeTool: "works_edit", discoveryTarget: () => "works_edit",
			works: { execution: host, resource: prototypeResource(views) },
			firstRound(_tools, question, messages) {
				const index = utterances.indexOf(question);
				if (index < 0) return;
				const receipt = toolResults(afterUtterance(messages), "delegate")[0];
				if (receipt !== undefined) {
					delegationReceipts.set(index, receipt);
					return { text: "Worksの作業を確認します。" };
				}
				const candidates = candidatesOf(messages);
				if (!candidates) return { calls: [findToolchain("Works software prototype edit")] };
				assert(candidates.some((card) => card.id === "prototype.edit"));
				return { calls: [delegate("prototype.edit", question)] };
			},
			structuredResponse(messages) {
				const raw = messages.at(-1)?.content;
				if (!raw) return;
				if (raw.includes("prototype.edit") && raw.includes("projectName")) {
					if (withTwoWorks && raw.includes(utterances[1]!))
						return { choice: "prototype.edit", inputs: { projectName: "Beta" } };
					if (raw.includes(utterances[1]!) && selectedRef)
						return { choice: "prototype.edit", refs: [selectedRef] };
					if (raw.includes(utterances[0]!))
						return { choice: "prototype.edit", inputs: { projectName: "Alpha" } };
				}
				let body;
				try { body = JSON.parse(raw); } catch { return; }
				const index = utterances.indexOf(body.request);
				if (index < 0) return;
				if (withClosure && !body.observation) return { decision: {
					action: "invoke", summary: "Add the trial type error", memo:"", instruction:
					`Read ${alphaSource} and append the exact line const remainingP2TypeFailure: number = "fixture"; to it. Keep that invalid type for the trial. Run both exact registered Works checks individually; leave the line in place after the checks and report.`
				}};
				if (withDependency) {
					const check = body.checks?.find((item: { diagnostics?: string }) => item.diagnostics?.includes("nanoid"));
					if (check) return { decision: { action: "ask_user", summary: "A required package is missing", memo: "", question: "Approve dependency?",
						dependency: { name: "nanoid", version: "5.1.5", entry: "index.browser.js", types: "index.d.ts",
							usage: "画面にランダムIDを作る", evidenceRef: check.ref } } };
					if (!body.observation) return { decision: { action: "invoke", summary: "Using the Works runtime", memo: "",
						instruction: body.memo.includes("導入されました")
							? "The host installed and selected the new fixed release. Keep the existing source and run both exact registered checks, each as a separate Bash call."
							: `Read the absolute file ${alphaSource}. Add import { nanoid } from "nanoid"; and use nanoid() as a data-works-id attribute on the h1. Set the h1 text to "Works dependency approved". Run both exact verified commands as separate Bash calls, then report the missing package. Do not ask via AskUserQuestion and do not install anything.` } };
				}
				if (!body.observation) return { decision: { action: "invoke", summary: "Editing the registered Works source", memo: "",
					instruction: `Read the absolute file ${join(withTwoWorks && index===1 ? b : a,"src/main.tsx")}. Edit its heading text to "${titles[index]}". Run both exact approved verification commands, each as a separate Bash call. Report only after both have run.` } };
				return { decision: { action: "finish", status: "completed", summary: "Edited and verified the Works project", memo: "",
					fulfilled: [titles[index]], missing: [], refs: (body.observation.evidence ?? []).map((e: {ref: string}) => e.ref).slice(-2) } };
			},
		});
		fixture = assignment.h;
		await assignment.attend("main");
		assert(fixture.store.read(db => assignment!.f.host.dialoguePort.servesRepliesInTransaction?.(db, "main")));
		assert(assignment.card("prototype.edit"));
		for (let i = 0; i < 3; i++) {
			await assignment.f.advance(5_001);
			await fixture.toolchain.claudeCode.recover();
		}
		assert.equal(operations.length, 0);
		assert.equal(readdirSync(state).filter(path => path.startsWith("runner-")).length, 0);
		browser = await chromium.launch({ channel: "chrome", args: ["--mute-audio", "--no-proxy-server"] });
		const page = await browser.newPage();
		const browserErrors: string[] = [];
		page.on("pageerror", (error) => browserErrors.push(error.name + ": " + error.message));
		for (const [i, utterance] of utterances.entries()) {
			const subject = withTwoWorks && i===1 ? beta : alpha;
			const subjectFile = join(subject.root,"src/main.tsx");
			const subjectUri = "eumenes://prototype/" + subject.id;
			step = "conversation " + (i + 1);
			const accepted = await fixture.request("/api/runs", { conversationId: "main", requestId: crypto.randomUUID(), text: utterance });
			assert.equal(accepted.status, 202);
			const run = await accepted.json() as {id: string};
			await until("admission "+i, async () => {
				const response = await fixture!.request("/api/runs/" + run.id);
				const data = await response.json() as {status: string};
				if (["failed", "cancelled"].includes(data.status)) throw new Error("conversation_" + data.status);
				return data.status === "completed" ? data : null;
			});
			const delegation = delegationReceipts.get(i);
			assert(delegation && (/delegated: true/.test(delegation) || /"delegated":true/.test(delegation)), "delegate receipt: " + delegation);
			console.log("conversation " + (i + 1) + " delegated");
			let choiceWork: string | undefined;
			if (withClosure) {
				step = "ambiguous selection";
				const waiting = await until("candidate question", async () => {
					await assignment!.f.advance(1000);
					const item = assignment!.f.host.inspect("main")?.snapshot.agent.items.find(item => item.question?.includes("second-alpha"));
					return item?.question ? item : null;
				}, 25_000);
				assert.match(waiting.question!, /作品 1 — Alpha（alpha）/);
				assert.match(waiting.question!, /作品 2 — Alpha（second-alpha）/);
				assert.equal(operations.length,0);
				const owner = fixture!.store.read(db => db.query("SELECT id FROM claude_code_work").all()) as {id:string}[];
				assert.equal(owner.length,1);
				choiceWork = owner[0]!.id;
				const text = "作品 1";
				const answer = await fixture!.dialogue.submit({ requestId: crypto.randomUUID(), conversationId: "main", text });
				await until("selection message accepted", async () => {
					const response = await fixture!.request("/api/runs/" + answer.id);
					return (await response.json()).status === "completed" ? true : null;
				}, 10_000);
				const answered = await replyWith(assignment!.f, [{
					name: "assignment", arguments: { id: waiting.id, action:"answer", text },
				}], {conversationId:"main",runId:answer.id,messageIds:[answer.inputMessageId]});
				assert(answered.seen.flat().some(item => item.role==="tool" && item.content.startsWith("answered:")));
			}
			let started = await until("claude operation "+i, async () => { await assignment!.f.advance(1000); return operations[i] ?? null; }, 25_000).catch((error)=>{
				const snapshot = assignment!.f.host.inspect("main")?.snapshot as any;
				console.log("assignment observation", Object.keys(snapshot ?? {}), (snapshot?.agent?.items ?? []).map((item: any)=>({status:item.status,delegated:!!item.delegatedTo})));
				console.log("refusals", (snapshot?.researchRefusals ?? []).map((row: any)=>row.code));
				throw error;
			});
			if (withDependency) {
				step = "dependency question";
				const before = await until("dependency prompt", async () => {
					await assignment!.f.advance(1000);
					const view = fixture!.store.read(db => fixture!.toolchain.claudeCode.worksTask.viewInTransaction(db, started.workId));
					if (view?.result) throw new Error("dependency question missing: " + view.result.summary);
					if (!view?.question) return null;
					const item = assignment!.f.host.inspect("main")?.snapshot.agent.items
						.find(item => item.question === view.question?.prompt);
					return item ? { item, question: view.question } : null;
				});
				assert(before.question.prompt.includes("nanoid@5.1.5"));
				assert.equal(git(source, ["tag", "--list"]).trim(), "works-v2.0");
				const approvalText = "承認 " + before.question.id;
				async function answer(raw: string) {
					const answer = await fixture!.dialogue.submit({ requestId: crypto.randomUUID(), conversationId: "main", text: raw });
					await until("answer saved", async () => {
						const response = await fixture!.request("/api/runs/" + answer.id);
						const { status } = await response.json() as { status: string };
						return status === "completed" ? true : null;
					}, 10_000);
					return replyWith(assignment!.f, [{ name: "assignment", arguments: { id: before.item.id, action: "answer", text: approvalText } }],
						{ conversationId: "main", runId: answer.id, messageIds: [answer.inputMessageId] });
				}
				const rejected = await answer("追加はまだ決めていません。");
				assert(rejected.seen.flat().some(m => m.role === "tool" && m.content.includes("invalid_answer")));
				assert.equal(git(source, ["tag", "--list"]).trim(), "works-v2.0");
				assert.equal(fixture!.store.read(db => fixture!.toolchain.claudeCode.worksTask.viewInTransaction(db, started.workId))?.question?.id, before.question.id);
				const accepted = await answer(approvalText);
				assert(accepted.seen.flat().some(m => m.role === "tool" && m.content.startsWith("answered:")));
				step = "dependency publication and resume";
				started = await until("approved Works release", async () => {
					await assignment!.f.advance(1000);
					const task = fixture!.store.read(db => fixture!.toolchain.claudeCode.worksTask.viewInTransaction(db, operations[0]!.workId));
					if (task?.result) throw new Error(task.result.summary);
					return operations[1] ?? null;
				}, 140_000);
				assert.equal(started.workId, operations[0]!.workId);
				assert.notEqual(started.id, operations[0]!.id);
				assert.equal(started.generation, operations[0]!.generation + 1);
				assert.equal(views.editTarget(alpha.id).environment, "2.1");
				assert.equal(views.editTarget(beta.id).environment, "2.0");
				assert(!existsSync(join(home, "releases/2.0/node_modules/nanoid")));
				assert(existsSync(join(home, "releases/2.1/node_modules/nanoid")));
				assert.deepEqual(await otherBuilds(), earlierOutputs);
				assert.deepEqual(git(source, ["diff", "--name-only", "works-v2.0", "works-v2.1"]).trim().split("\n").sort(), ["bun.lock", "package.json", "resolution.json"]);
				assert.equal(git(source, ["status", "--porcelain"]), "");
				assert.deepEqual(git(a, ["diff", "--name-only"]).trim().split("\n").sort(), ["README.md", "prototype.json", "src/main.tsx"]);
				console.log("approved dependency produced a fixed release and resumed the same work");
			}
			if (!withDependency && i === 1) {
				await page.goto(origin + "/#works/" + beta.id);
				await expect(page.getByRole("heading", { name: "Beta", exact: true })).toBeVisible();
			}
			const result = await until("claude result "+i, async () => {
				const connection = native ?? daemonClients.get(subject.id)!;
				const observed = await connection.inspect(started.id).catch(()=>null);
				return observed?.managedExecutionStopped && observed.state !== "running" ? observed : null;
			});
			assert.equal(result.state, "finished");
			if (withClosure) {
				assert.equal(started.workId, choiceWork);
				assert.equal(started.supervised!.authorization.workspaceRef, "prototype:" + alpha.id);
				const checks = result.structuredEvidence?.filter(e=> e.kind==="check" && !e.passed && e.exitCode!==0) ?? [];
				for (const command of started.supervised!.authorization.checks)
					assert(checks.some(e => JSON.stringify(e.check) === JSON.stringify(command)));
				assert(readFileSync(alphaSource,"utf8").includes('const remainingP2TypeFailure: number = "fixture";'));
				const rejected = await until("false completion rejected", () => {
					const view = fixture!.store.read(db => fixture!.toolchain.claudeCode.worksTask.viewInTransaction(db, started.workId));
					return view?.result ? view : null;
				});
				assert.equal(rejected.status,"partial");
				assert(!rejected.result?.refs.some(ref => ref.startsWith("eumenes://prototype/")));
				continue;
			}
			const proof = result.structuredEvidence?.filter((e) => e.kind === "check" && e.passed);
			for (const command of started.supervised!.authorization.checks)
				assert(proof?.some(entry => entry.exitCode === 0 &&
					JSON.stringify(entry.check) === JSON.stringify(command)),
					JSON.stringify(result.structuredEvidence?.filter(e=>e.kind==="check").map(e=>({exit:e.exitCode,stderr:e.stderr}))));
			const task = await until("adopted task "+i, () => {
				const view = fixture!.store.read(db => fixture!.toolchain.claudeCode.worksTask.viewInTransaction(db, started.workId));
				return view?.result ? view : null;
			});
			assert.equal(task.status, "completed", JSON.stringify(task.result));
			assert(task.result?.refs.includes(subjectUri));
			assert(readFileSync(subjectFile, "utf8").includes(titles[i]!));
			assert.equal(readFileSync(readme, "utf8"), readmeBefore);
			if(subject===alpha) assert.equal(readFileSync(join(b,"src/main.tsx"),"utf8"), betaBefore);
			else assert(readFileSync(alphaSource,"utf8").includes(titles[0]!));
			assert.equal(git(a, ["rev-parse", "HEAD"]), alphaHead);
			assert.equal(git(a, ["diff", "--cached", "--binary"]), alphaIndex);
			assert.equal(git(a, ["stash","list"]), stashBefore);
			assert(!existsSync(join(a,"node_modules")));
			assert(!existsSync(join(a,"bun.lock")));
			const resolution = await fixture.request("/api/resources/resolve?uri=" + encodeURIComponent(subjectUri));
			assert.equal(resolution.status, 200);
			const resolved = await resolution.json() as { resource: { targetRef: string } };
			assert.equal(resolved.resource.targetRef, subject.id);
			selectedRef = await until("conversation result ref "+i, async () => {
				await assignment!.f.advance(withDependency ? 15_000 : 1000);
				const ledger = await fixture!.request("/api/conversations/main/resources");
				const data = await ledger.json() as {resources: {uri: string; ref: string}[]; messages: {uris: string[]}[]};
				if (!withDependency && !withTwoWorks && !data.messages.some(({uris}) => uris.includes(subjectUri))) return null;
				return data.resources.find(({uri}) => uri === subjectUri)?.ref ?? null;
			}, 25_000).catch(async error => {
				const agenda = assignment!.f.host.inspect("main")?.snapshot;
				const ledger = await fixture!.request("/api/conversations/main/resources");
				const report = await ledger.json() as { resources: unknown[]; messages: unknown[] };
				console.log("ledger checkpoint", { resources: report.resources.length, messages: report.messages.length,
					notes: agenda?.notes.length, items: agenda?.agent.items.map(item => ({ status: item.status, question: Boolean(item.question) })) });
				throw error;
			});
			assert(selectedRef, "Works result needs a conversation resource reference");
			if (withDependency || withTwoWorks) {
				await page.goto(origin + "/#works/" + resolved.resource.targetRef);
			} else {
				await page.goto(origin + "/#conversation");
				try {
				await page.getByRole("button", {name: subject.name+"を表示する", exact: true}).last().click({timeout: 15_000});
			} catch (error) {
				console.log("browser checkpoint", { errors: browserErrors, title: await page.title(),
					headings: await page.getByRole("heading").allTextContents(),
					api: await page.evaluate(async () => {
						const r = await fetch("/api/conversations/main/resources");
						const body = await r.json();
						return {status:r.status, labels:body.resources?.map((item: {label: string})=>item.label), links:body.messages?.length};
					}),
				});
					throw error;
				}
			}
			await expect(page).toHaveURL(origin + "/#works/" + subject.id);
			await expect(page.frameLocator('iframe[title="'+subject.name+'"]').getByRole("heading", {name: titles[i]})).toBeVisible({timeout: 15_000});
			if(withTwoWorks) for(const pid of liveDaemonPids()) if(!measuredPids.has(pid)) {
				measuredPids.add(pid);daemonSamples.push({pid,idleBytes:physicalBytes(pid)});
			}
			await page.getByRole("link", {name: "会話に戻る"}).click();
			console.log("turn " + (i + 1) + " edits checks preview and result ref passed");
		}
		if (withClosure) {
			assert.equal(operations.length,1);
			console.log(JSON.stringify({ candidatesWereAsked:true, chosenWorkStartedOnce:true,
				actualClaudeEdit:true, failedChecks:2, falseCompletionRejected:true }));
		} else if (withTwoWorks) {
			step="two real runners release";
			assert.equal(operations.length,2);
			assert.notEqual(operations[0]!.supervised!.authorization.workspaceRef,operations[1]!.supervised!.authorization.workspaceRef);
			assert.equal(daemonSamples.length,2);
			await until("both preview frames closed",()=>views!.metrics().watchers===0 ? true : null,10000);
			await until("two real runners idle exit",async()=>{
				await fixture!.toolchain.claudeCode.recover();
				return liveDaemonPids().length===0 ? true : null;
			},75_000);
			for(let i=0;i<3;i++) {
				await assignment.f.advance(5001);await fixture.toolchain.claudeCode.recover();
				assert.equal(liveDaemonPids().length,0);
			}
			console.log(JSON.stringify({twoActualClaudeEdits:true,fourRegisteredChecks:true,daemons:daemonSamples,
				hostBytesBefore:hostBefore,hostBytesAfter:physicalBytes(process.pid),idleDaemonsAfterClose:0,viewMetricsAfterClose:views.metrics()}));
		} else {
		assert.equal(operations.length, 2);
		if (!withDependency) assert.notEqual(operations[0]!.workId, operations[1]!.workId);
		assert.equal(operations[0]!.supervised!.authorization.workspaceRef, operations[1]!.supervised!.authorization.workspaceRef);
		template(dupe, "Alpha", "2.0");
		commit(dupe);
		views.register(dupe);
		assert.throws(() => production.select({ name: "Alpha", references: [] }), /prototype_target_ambiguous/);
		assert.equal(production.select({
			name: "Beta",
			references: [{ id: alpha.id, ref: "eumenes://prototype/" + alpha.id,
				owner: "prototype", revision: new Date(alpha.generation).toISOString(),
				digest: "fixture", label: "Alpha", kind: "resource", preview: "" }],
		}).id, alpha.id);
		console.log(JSON.stringify({ turns: utterances.length, realClaudeCode: true, router: "fixed",
			...(withDependency ? { dependencyApproval: true, sameWorkResumed: true, releaseVersion: "2.1", unchangedOtherBuilds: earlierOutputs.length } : {}), workIdStable: alpha.id === views.editTarget(alpha.id).id,
			typescriptAndBuildReceipts: withDependency ? 2 : 4, typeErrorChecksFailed: 2, previews: utterances.length, refFollowup: !!selectedRef,
			secondProjectUntouched: beta.id !== alpha.id, gitStatePreserved: true, priorUncommittedEditPreserved: true,
			unregisterBlockedDuringEdit: true, registeredIdleProjects: 5,
			concurrentEditPreserved: true, ambiguousNameRejected: true }));
		}
	}
} catch (error) {
	console.error("P2 checkpoint:", step);
	throw error;
} finally {
	await browser?.close();
	await assignment?.close();
	await runner?.close();
	await views?.close();
	await server?.stop(true);
	if(withTwoWorks) for(const pid of liveDaemonPids()) process.kill(pid,"SIGTERM");
	rmSync(temp, { recursive: true, force: true });
	for (const port of ports) await assert.rejects(fetch("http://127.0.0.1:" + port));
}
