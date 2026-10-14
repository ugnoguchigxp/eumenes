import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [record, mode] = process.argv.slice(2);
if (!record || !mode || !["resume", "git", "push", "repeat"].includes(mode))
	throw new Error("probe_arguments_missing");
const output = resolve(record);
const fixture = JSON.parse(
	await readFile(join(output, "fixture.json"), "utf8"),
);
const previous = JSON.parse(await readFile(join(output, "work.json"), "utf8"));
const workspace: string = fixture.workspace;
const count = mode === "repeat" ? 4 : 1;
if (mode === "push") {
	const remote = join(fixture.root, "remote.git");
	const init = Bun.spawn(["git", "init", "--bare", remote], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (await init.exited) throw new Error("fixture_remote_init_failed");
	const connect = Bun.spawn(
		["git", "-C", workspace, "remote", "add", "origin", remote],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (await connect.exited) throw new Error("fixture_remote_connect_failed");
}
for (let n = 0; n < count; n++) {
	const step = join(fixture.root, `${mode}-${n}`);
	await mkdir(step);
	await writeFile(join(step, "previous.json"), JSON.stringify(previous));
	const prompt =
		mode === "resume"
			? "Continue the earlier task. Without reading AGENTS.md again, return its marker from our previous turn and explain what was fixed. Run OPENSSL_CONF=/dev/null node sum.test.js. Do not commit or push."
			: mode === "push"
				? "This isolated fixture authorizes pushing the already created HEAD to its local bare origin only. Run git push origin HEAD:refs/heads/main once. Do not create another commit. Report the actual result and the project marker."
				: mode === "git"
					? "This isolated fixture authorizes one local commit of sum.js only. Run git add sum.js and git commit -m 'Fix addition'. Do not push. Verify the HEAD and report the actual success or refusal, using the project's marker."
					: "Read AGENTS.md, run OPENSSL_CONF=/dev/null node sum.test.js, and report the actual result with the marker. Do not edit, commit, push, use subagents or access other chats.";
	await writeFile(join(step, "input.txt"), prompt);
	const p = Bun.spawn(
		[
			process.execPath,
			fileURLToPath(new URL("./turn.ts", import.meta.url)),
			step,
			workspace,
			mode === "repeat" ? "work" : mode,
		],
		{ stdout: "inherit", stderr: "pipe" },
	);
	const exitCode = await p.exited;
	const result = JSON.parse(await readFile(join(step, "result.json"), "utf8"));
	const processReceipt = JSON.parse(
		await readFile(join(step, "process.json"), "utf8"),
	);
	const report = JSON.parse(result.finalResponse || "{}");
	const checks = {
		marker: report.marker === fixture.marker,
		completed: result.events.some(
			(e: { type: string }) => e.type === "turn.completed",
		),
		sameThread:
			!["resume", "git", "push"].includes(mode) ||
			result.threadId === previous.threadId,
		closed:
			processReceipt.state === "closed" &&
			processReceipt.stopConfirmed === true,
	};
	await writeFile(
		join(output, `${mode}-${n}.json`),
		JSON.stringify(
			{ ...result, checks, exitCode, process: processReceipt },
			null,
			2,
		),
		{ mode: 0o600 },
	);
	console.log(JSON.stringify({ mode, n, exitCode, checks }));
	if (exitCode || Object.values(checks).some((v) => !v)) {
		process.exitCode = 1;
		break;
	}
}
