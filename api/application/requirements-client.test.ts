import { test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { harness } from "./toolchain.fixture";
import { createClient } from "../../client";
import { loadEvaluationCases } from "./llm-native-evaluation.fixture";
test("requirements API client and CLI keep CAS and enable/disable state through authenticated HTTP", async () => {
	const h = await harness();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: h.app.fetch,
	});
	const client = createClient(
		`http://127.0.0.1:${server.port}`,
		"fixture-token-for-toolchain-browser",
	);
	try {
		const { profiles } = loadEvaluationCases(
			new URL("./testdata/llm-native/cases.json", import.meta.url).pathname,
		);
		const profile = profiles.values().next().value!;
		const file = join(h.dir, "profile.json");
		writeFileSync(file, JSON.stringify(profile));
		const run = async (args: string[]) => {
			const proc = Bun.spawn(
				[process.execPath, "cli/index.ts", "requirements", ...args, "--json"],
				{
					env: {
						...process.env,
						EUMENES_URL: `http://127.0.0.1:${server.port}`,
						EUMENES_API_TOKEN: "fixture-token-for-toolchain-browser",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const text = await new Response(proc.stdout).text();
			const error = await new Response(proc.stderr).text();
			return { code: await proc.exited, text, error };
		};
		const imported = await run(["import", "criteria", file, "new"]);
		expect(imported.code).toBe(0);
		const dto = JSON.parse(imported.text);
		expect(dto.revision).toBe(1);
		expect((await client.requirementProfile("criteria")).hash).toBe(dto.hash);
		expect((await run(["show", "criteria"])).code).toBe(0);
		const list = await run(["list"]);
		expect(list.code, list.error).toBe(0);
		expect(JSON.parse(list.text).items).toHaveLength(1);
		const disabled = JSON.parse(
			(await run(["disable", "criteria", dto.stateToken])).text,
		);
		expect(disabled.enabled).toBe(false);
		const conflict = await run(["enable", "criteria", dto.stateToken]);
		expect(conflict.code).toBe(3);
		const enabled = await client.setRequirementProfileState("criteria", {
			expectedStateToken: disabled.stateToken,
			enabled: true,
		});
		expect(enabled.generation).toBe(2);
		const idempotent = await client.putRequirementProfile("criteria", {
			expectedStateToken: enabled.stateToken,
			data: profile,
		});
		expect(idempotent.revision).toBe(1);
	} finally {
		server.stop(true);
		await h.close();
	}
});
