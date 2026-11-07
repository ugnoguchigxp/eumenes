import { expect, test } from "bun:test";
import sharp from "sharp";
import { cloudRequest, type CloudEnv } from "../service/cloud";
import { cloudImages } from "../service/cloud-images";
import { inputImages } from "./image-input.fixture";
import type { Connection, Resource } from "../../settings";
import type { Messages, ConnectionModels } from "../contracts";
import type { RequestRow } from "../repository";
import { createImageInput } from "../service/image-input";

const connection: Connection = {
	id: "c",
	name: "fixture",
	baseUrl: "https://example.invalid/v1",
	enabled: true,
	epoch: 0,
	envRef: null,
};
const resource: Resource = {
	id: "r",
	connectionId: "c",
	purpose: "llm",
	model: "fixture-model",
	voice: null,
	contextWindow: 8192,
};
const catalog = (
	inputModalities?: Array<"text" | "image">,
): ConnectionModels => ({
	models: [
		{
			id: resource.model,
			displayName: "fixture",
			contextWindow: 8192,
			...(inputModalities ? { inputModalities } : {}),
		},
	],
	account: { auth: "api-key", subscriptionType: null },
});
const models = { list: async () => catalog(["text", "image"]) };
async function input(): Promise<Messages> {
	const images = await inputImages();
	return [
		{ role: "system", content: "instructions" },
		{ role: "user", content: "compare", images },
	];
}
const row = { purpose: "llm", contextPolicy: "exact" } as RequestRow;

test("cloud HTTP sends ordered native image parts, converts BMP pixels, and omits internal fields", async () => {
	const messages = await input();
	let sent:
		{ messages: Array<{ content: unknown; images?: unknown }> } | undefined;
	const env = {
		models,
		settings: { credential: () => "fixture-key" },
		store: {
			write: async (work: (db: unknown) => unknown) =>
				work({ query: () => ({ run: () => {} }) }),
		},
		fetch: async (_url: unknown, init?: RequestInit) => {
			sent = JSON.parse(String(init?.body));
			return Response.json({ choices: [{ message: { content: "answer" } }] });
		},
	} as unknown as CloudEnv;
	expect(
		await cloudRequest(
			env,
			row,
			messages,
			connection,
			resource,
			AbortSignal.timeout(5000),
			"a",
		),
	).toBe("answer");
	const content = sent!.messages[1]!.content as Array<{
		type: string;
		image_url?: { url: string };
	}>;
	expect(content.map((p) => p.type)).toEqual([
		"text",
		"image_url",
		"image_url",
		"image_url",
	]);
	expect(content.slice(1).map((p) => p.image_url!.url.split(";")[0])).toEqual([
		"data:image/jpeg",
		"data:image/png",
		"data:image/png",
	]);
	expect(sent!.messages.every((m) => m.images === undefined)).toBe(true);
	const png = Buffer.from(content[3]!.image_url!.url.split(",")[1]!, "base64");
	const pixels = await sharp(png).removeAlpha().raw().toBuffer();
	expect([...pixels.subarray(0, 3)]).toEqual([224, 32, 32]);
});

test("unknown and text-only capabilities stop before HTTP or agent calls", async () => {
	const messages = await input();
	for (const kind of [
		"openai-compatible",
		"codex-sdk",
		"claude-agent-sdk",
	] as const) {
		for (const modalities of [undefined, ["text"] as const]) {
			let calls = 0;
			const env = {
				models: {
					list: async () => catalog(modalities ? [...modalities] : undefined),
				},
				settings: { credential: () => "fixture" },
				fetch: async () => {
					calls++;
				},
				agents: {
					run: async () => {
						calls++;
					},
				},
			} as unknown as CloudEnv;
			await expect(
				cloudRequest(
					env,
					row,
					messages,
					{ ...connection, kind },
					resource,
					AbortSignal.timeout(5000),
					"a",
				),
			).rejects.toThrow(
				modalities ? "image_not_supported" : "image_capability_unknown",
			);
			expect(calls).toBe(0);
		}
	}
});

test("an image request keeps every message even above the estimate, with tools and schema", async () => {
	const messages = await input();
	messages.splice(
		1,
		0,
		{ role: "user", content: "old".repeat(10000) },
		{ role: "assistant", content: "kept" },
	);
	let received: Messages | undefined;
	const env = {
		models,
		settings: { credential: () => null },
		store: { write: async () => {} },
		agents: {
			run: async (call: { messages: Messages }) => {
				received = call.messages;
				return { text: "ok" };
			},
		},
	} as unknown as CloudEnv;
	await cloudRequest(
		env,
		row,
		messages,
		{ ...connection, kind: "codex-sdk" },
		resource,
		AbortSignal.timeout(5000),
		"a",
	);
	expect(received).toHaveLength(4);
	expect(received![1]!.content).toBe(messages[1]!.content);
	expect(received![3]!.images).toHaveLength(3);
});

test("invalid role and empty bytes never reach model discovery", async () => {
	let calls = 0;
	const lookup = {
		list: async () => {
			calls++;
			return catalog(["text", "image"]);
		},
	};
	const messages = await input();
	await expect(
		cloudImages(
			[{ ...messages[1]!, role: "assistant" }],
			connection,
			resource,
			lookup,
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("image_role_unsupported");
	await expect(
		cloudImages(
			[
				{
					...messages[1]!,
					images: [{ ...messages[1]!.images![0]!, bytes: new Uint8Array() }],
				},
			],
			connection,
			resource,
			lookup,
			AbortSignal.timeout(5000),
		),
	).rejects.toThrow("image_invalid");
	expect(calls).toBe(0);
});

test("cloud-only image inspection never creates or connects a LARM port", async () => {
	let local = 0;
	const settings = {
		revision: 1,
		connections: [{ ...connection, kind: "codex-sdk" }],
		resources: [resource],
		routes: {
			llm: { mode: "cloud-only", cloudAllowed: true, fallbackId: resource.id },
		},
	};
	const inspect = createImageInput(
		{ get: () => settings } as never,
		() => {
			local++;
			throw new Error("unexpected");
		},
		models,
	);
	expect(await inspect(AbortSignal.timeout(5000))).toEqual({
		revision: 1,
		primary: { source: "codex-sdk", status: "supported" },
	});
	expect(local).toBe(0);
});
