import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudAgents } from "../adapters/cloud-agents";
import { createConnectionModels } from "../service/connection-models";
import type { Connection } from "../../settings";
import { inputImages } from "./image-input.fixture";

/** A protocol fixture, never an installed Codex process or a real provider. */
test("Codex model discovery creates no thread; image turns send native items after same-session capability check", async () => {
	const dir = await mkdtemp(join(tmpdir(), "codex-images-"));
	const command = join(dir, "fixture");
	const record = join(dir, "requests");
	const capability = join(dir, "capability");
	const behavior = join(dir, "behavior");
	await writeFile(behavior, "answer");
	await writeFile(capability, JSON.stringify(["text", "image"]));
	await writeFile(
		command,
		`#!${process.execPath}
import {createInterface} from "node:readline";
import {appendFileSync,readFileSync} from "node:fs";
const out = m => process.stdout.write(JSON.stringify(m)+"\\n");
createInterface({input:process.stdin}).on("line", line => {
const m=JSON.parse(line); appendFileSync(${JSON.stringify(record)},line+"\\n");
if(m.method==="initialize")out({id:m.id,result:{}});
if(m.method==="model/list")out({id:m.id,result:{data:[{model:"fixture-model",displayName:"fixture",...(JSON.parse(readFileSync(${JSON.stringify(capability)},"utf8"))===null?{}:{inputModalities:JSON.parse(readFileSync(${JSON.stringify(capability)},"utf8"))})}],nextCursor:null}});
if(m.method==="config/read")out({id:m.id,result:{config:{}}});
if(m.method==="thread/start")out({id:m.id,result:{thread:{id:"t"}}});
if(m.method==="turn/start"){out({id:m.id,result:{turn:{id:"u"}}});out({method:"item/started",params:{threadId:"t",item:{type:"userMessage",id:"user",content:m.params.input}}});out({method:"item/completed",params:{threadId:"t",item:{type:"userMessage",id:"user",content:m.params.input}}});out({method:"item/completed",params:{threadId:"t",item:{type:"agentMessage",text:readFileSync(${JSON.stringify(behavior)},"utf8")==="answer"?"answer":"x".repeat(2*1024*1024)}}});out({method:"turn/completed",params:{threadId:"t",turn:{id:"u",status:"completed"}}});}
});
`,
		{ mode: 0o700 },
	);
	try {
		const connection: Connection = {
			id: "c",
			name: "fixture",
			kind: "codex-sdk",
			baseUrl: "https://example.invalid",
			enabled: true,
			epoch: 0,
			envRef: null,
		};
		const models = createConnectionModels(
			{
				get: () => ({ connections: [connection] }),
				credential: () => null,
			} as never,
			{ PATH: "" },
			{ codexExecutable: command },
		);
		expect(
			(await models.list("c", AbortSignal.timeout(5000)))!.models[0]!
				.inputModalities,
		).toEqual(["text", "image"]);
		const read = () =>
			readFile(record, "utf8").then((text) =>
				text
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			);
		expect((await read()).some((m) => m.method === "thread/start")).toBe(false);
		const image = (await inputImages())[1]!;
		const result = await createCloudAgents(
			{ PATH: "" },
			{ codexExecutable: command },
		).run({
			kind: "codex-sdk",
			model: "fixture-model",
			baseUrl: connection.baseUrl,
			credential: null,
			messages: [
				{ role: "system", content: "instructions" },
				{ role: "user", content: "", images: [image, image] },
			],
			signal: AbortSignal.timeout(5000),
			outputSchema: { type: "object" },
		});
		expect(result.text).toBe("answer");
		const sent = (await read()).find((m) => m.method === "turn/start").params;
		expect(sent.input.map((item: { type: string }) => item.type)).toEqual([
			"text",
			"image",
			"image",
		]);
		expect(sent.input[0].text).toContain('"images":[1,2]');
		expect(sent.input[0].text).not.toContain("base64");
		expect(sent.input[1].url).toBe(
			`data:image/png;base64,${Buffer.from(image.bytes).toString("base64")}`,
		);
		expect(sent.outputSchema).toEqual({ type: "object" });
		for (const [modalities, code] of [
			[["text"], "image_not_supported"],
			[null, "image_capability_unknown"],
		] as const) {
			// Omitted capabilities must stay unknown; the fixture never starts another turn.
			await writeFile(capability, JSON.stringify(modalities));
			await expect(
				createCloudAgents({ PATH: "" }, { codexExecutable: command }).run({
					kind: "codex-sdk",
					model: "fixture-model",
					baseUrl: connection.baseUrl,
					credential: null,
					messages: [{ role: "user", content: "", images: [image] }],
					signal: AbortSignal.timeout(5000),
				}),
			).rejects.toThrow(code);
			expect(
				(await read()).filter((m) => m.method === "turn/start"),
			).toHaveLength(1);
		}
		await writeFile(capability, JSON.stringify(["text", "image"]));
		const bytes = await sharp(randomBytes(1024 * 768 * 3), {
			raw: { width: 1024, height: 768, channels: 3 },
		})
			.png()
			.toBuffer();
		expect(bytes.length).toBeGreaterThan(2 * 1024 * 1024);
		const largeResult = await createCloudAgents(
			{ PATH: "" },
			{ codexExecutable: command },
		).run({
			kind: "codex-sdk",
			model: "fixture-model",
			baseUrl: connection.baseUrl,
			credential: null,
			messages: [
				{
					role: "user",
					content: "large image",
					images: [{ mime: "image/png", bytes, width: 1024, height: 768 }],
				},
			],
			signal: AbortSignal.timeout(5000),
		});
		expect(largeResult.text).toBe("answer");
		await writeFile(behavior, "oversized-answer");
		await expect(
			createCloudAgents({ PATH: "" }, { codexExecutable: command }).run({
				kind: "codex-sdk",
				model: "fixture-model",
				baseUrl: connection.baseUrl,
				credential: null,
				messages: [
					{
						role: "user",
						content: "large image",
						images: [{ mime: "image/png", bytes, width: 1024, height: 768 }],
					},
				],
				signal: AbortSignal.timeout(5000),
			}),
		).rejects.toThrow("cloud_agent_output_limit");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
