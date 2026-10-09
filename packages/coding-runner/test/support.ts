import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	chmodSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest, atomicWrite } from "../src/storage";
import { git } from "../src/workspace";
import { executionSpecSchema } from "../src/contracts";
import type { RunnerConfig } from "../src/config";

export function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "coding-runner-")));
	const source = join(root, "source");
	mkdirSync(source);
	git(source, ["init", "-q"]);
	git(source, ["config", "user.name", "Fixture"]);
	git(source, ["config", "user.email", "fixture@example.invalid"]);
	writeFileSync(join(source, "source.txt"), "base\n");
	git(source, ["add", "source.txt"]);
	git(source, ["commit", "-qm", "base"]);
	const baseSha = git(source, ["rev-parse", "HEAD"]).trim();
	const workspace = join(root, "workspace");
	git(source, ["worktree", "add", "-qb", "codex/fixture", workspace, baseSha]);
	const program = `#!/usr/bin/python3
import sys,json,time,os,subprocess
mode=sys.stdin.read().strip()
history=os.path.join(os.environ['CODEX_HOME'],'fixture-session.json')
if 'resume' in sys.argv:
 requested=sys.argv[sys.argv.index('resume')+1]
 if not os.path.isfile(history) or json.load(open(history))['id']!=requested: sys.exit(2)
else:
 json.dump({'id':'0199a213-81c0-7800-8aa1-bbab2a035a53'},open(history,'w'))
def event(v):
 b=(json.dumps(v,ensure_ascii=False)+'\\n').encode()
 for i in range(0,len(b),3):
  sys.stdout.buffer.write(b[i:i+3]);sys.stdout.buffer.flush()
event({'type':'thread.started','thread_id':'0199a213-81c0-7800-8aa1-bbab2a035a53'})
if mode=='failed': event({'type':'turn.failed','error':{'message':'private error'}});sys.exit(1)
elif mode=='long': time.sleep(30)
elif mode=='partial': sys.stdout.write('{"type":');sys.stdout.flush()
elif mode=='flood': sys.stdout.write('x'*4096+'\\n');sys.stdout.flush();time.sleep(30)
elif mode=='background': subprocess.Popen(['/bin/sleep','30'])
elif mode=='edit': open('source.txt','w').write('fixture edit\\n')
elif mode=='bom': event({'type':'item.completed','item':{'type':'agent_message','text':'\uFEFF日本語'}})
elif mode=='env': event({'type':'item.completed','item':{'type':'agent_message','text':','.join(k for k in os.environ if 'TOKEN' in k or 'KEY' in k or k=='SSH_AUTH_SOCK')}})
else:
 event({'type':'item.completed','item':{'type':'reasoning','text':'private reasoning'}})
 event({'type':'item.completed','item':{'type':'agent_message','text':'実装しました。 sk-testsecret12345'}})
event({'type':'turn.completed','usage':{'input_tokens':999}})
if mode=='nonzero': sys.exit(1)
`;
	const cli = join(root, "fixture-cli");
	writeFileSync(cli, program);
	chmodSync(cli, 0o700);
	const repositoryStat = statSync(join(source, ".git"));
	const config: RunnerConfig = {
		spoolRoot: join(root, "spool"),
		codexExecutable: cli,
		codexDigest: digest(program),
		mode: "fixture",
		workspaces: [
			{
				id: "fixture",
				path: workspace,
				commonGitDir: realpathSync(join(source, ".git")),
				repositoryIdentity: {
					dev: repositoryStat.dev,
					ino: repositoryStat.ino,
				},
				branch: "codex/fixture",
				baseSha,
				remotes: [],
			},
		],
		fixtureLimits: {
			leaseMs: 10000,
			graceMs: 100,
			maxLineBytes: 1024,
			maxRunBytes: 32768,
		},
	};
	const configPath = join(root, "config.json");
	atomicWrite(configPath, config);
	const spec = (instruction = "normal") =>
		executionSpecSchema.parse({
			version: "eumenes-coding/1",
			executionId: crypto.randomUUID(),
			operationId: crypto.randomUUID(),
			taskId: "task",
			workspaceId: "fixture",
			generation: 1,
			authorityEpoch: 1,
			kind: "implement",
			instruction,
			sessionId: null,
			deadlineAt: Date.now() + 30000,
			operations: ["read", "edit"],
			network: "none",
			previousExecutionId: null,
		});
	return {
		root,
		source,
		workspace,
		config,
		configPath,
		spec,
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}
export async function until<T>(
	operation: () => Promise<T> | T,
	accept: (value: T) => boolean,
	timeoutMs = 6000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value: T;
	do {
		value = await operation();
		if (accept(value)) return value;
		await Bun.sleep(25);
	} while (Date.now() < deadline);
	throw new Error("fixture_timeout");
}
