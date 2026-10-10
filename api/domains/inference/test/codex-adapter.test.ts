import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexResearch } from "..";

const messages = [
	{ role: "system" as const, content: "OUTPUT_SCHEMA={}" },
	{ role: "user" as const, content: "資料を調べて" },
];
async function fixture(body: string) {
	const dir = await mkdtemp(join(tmpdir(), "eumenes-codex-fixture-"));
	const record = join(dir, "record.json");
	const command = join(dir, "codex");
	await writeFile(
		command,
		`#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nconst input = await Bun.stdin.text();\nwriteFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), pid: process.pid, input }));\n${body}`,
		{ mode: 0o700 },
	);
	return {
		dir,
		record,
		command,
		close: () => rm(dir, { recursive: true, force: true }),
	};
}

test("Codex adapter fixes Luna, sends only supplied context, disables native tools and omits product secrets", async () => {
	const f = await fixture('console.log(JSON.stringify({ action: "finish" }));');
	try {
		const adapter = createCodexResearch(
			{
				HOME: f.dir,
				PATH: "",
				LARM_API_TOKEN: "secret-larm",
				EUMENES_API_TOKEN: "secret-product",
			},
			f.command,
		)!;
		expect(adapter.model).toBe("gpt-6-luna");
		expect(await adapter.execute(messages, AbortSignal.timeout(3000))).toBe(
			'{"action":"finish"}',
		);
		const record = JSON.parse(await readFile(f.record, "utf8"));
		expect(record.argv).toContain("gpt-6-luna");
		for (const flag of [
			"--ephemeral",
			"--ignore-user-config",
			"--ignore-rules",
			"read-only",
			'web_search="disabled"',
			"features.shell_tool=false",
			"features.multi_agent=false",
			"mcp_servers={}",
		])
			expect(record.argv).toContain(flag);
		expect(JSON.parse(record.input)).toEqual({ messages });
		expect(record.env.LARM_API_TOKEN).toBeUndefined();
		expect(record.env.EUMENES_API_TOKEN).toBeUndefined();
		expect(record.cwd).not.toBe(process.cwd());
		await expect(stat(record.cwd)).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("Codex adapter kills its process on cancellation and discards partial answers", async () => {
	const f = await fixture(
		'process.on("SIGTERM", () => {}); console.log("partial"); setInterval(() => {}, 100);',
	);
	try {
		const adapter = createCodexResearch({ HOME: f.dir, PATH: "" }, f.command)!;
		const abort = new AbortController();
		const work = adapter.execute(messages, abort.signal);
		// Wait for the fixture's spawn receipt rather than depending on a startup duration.
		for (let i = 0; i < 200 && !(await Bun.file(f.record).exists()); i++)
			await Bun.sleep(5);
		const record = JSON.parse(await readFile(f.record, "utf8"));
		abort.abort(new Error("cancelled"));
		await expect(work).rejects.toThrow("cancelled");
		expect(() => process.kill(record.pid, 0)).toThrow();
		await expect(stat(record.cwd)).rejects.toThrow();
	} finally {
		await f.close();
	}
});

test("Codex adapter reports fixed error codes and rejects oversized output", async () => {
	for (const body of [
		'console.error("secret provider response"); process.exit(1);',
		'console.log("x".repeat(65537));',
	]) {
		const f = await fixture(body);
		try {
			const adapter = createCodexResearch(
				{ HOME: f.dir, PATH: "" },
				f.command,
			)!;
			await expect(
				adapter.execute(messages, AbortSignal.timeout(3000)),
			).rejects.toThrow(
				body.includes("repeat")
					? "codex_research_output_limit"
					: "codex_research_failed",
			);
		} finally {
			await f.close();
		}
	}
	expect(
		createCodexResearch({ PATH: "" }, "/does/not/exist/codex"),
	).toBeUndefined();
});
