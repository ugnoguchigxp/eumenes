import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Hono } from "hono";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
	MemoryHost,
	serveHost,
	type HostConfig,
	type HostResult,
} from "eumenes-memory-host";
import type { StateItem } from "eumenes-memory";
import { registerMemory } from "../domains/memory";
import { PRINCIPAL, PROFILE_SCOPE } from "../domains/memory/contracts";
import { setupMemory, saveItem } from "../domains/memory/test/memory.fixture";

const cli = fileURLToPath(
	new URL("./cli.js", import.meta.resolve("eumenes-memory-host")),
);
const appCli = fileURLToPath(new URL("../../cli/index.ts", import.meta.url));

type Item = StateItem & { evidenceStatus: string };
async function runCli<T = HostResult>(
	path: string,
	args: string[],
	input?: unknown,
	environment: Record<string, string> = {},
) {
	const env: Record<string, string> = { ...environment };
	for (const key of [
		"PATH",
		"HOME",
		"TMPDIR",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
	]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	const child = Bun.spawn([process.execPath, path, ...args], {
		env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
	try {
		if (input !== undefined) child.stdin.write(JSON.stringify(input));
		child.stdin.end();
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(0);
		expect(stderr).toBe("");
		return JSON.parse(stdout) as T;
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
}
async function connect(profile: string) {
	const client = new Client({
		name: "installed-eumenes-memory-acceptance",
		version: "1",
	});
	await client.connect(
		new StdioClientTransport({
			command: process.execPath,
			args: [cli, "--profile", profile, "mcp"],
			stderr: "pipe",
		}),
	);
	return client;
}
async function tool(
	client: Client,
	method: string,
	args: Record<string, unknown> = {},
) {
	const result = await client.callTool({
		name: `memory_${method}`,
		arguments: args,
	});
	return result.structuredContent as HostResult;
}
function rememberProposal(
	text: string,
	key: string,
	replacesItemId: string | null = null,
) {
	return {
		decision: {
			clarification: null,
			actions: [
				{
					type: "remember",
					subject: "self",
					kind: "preference",
					semanticKey: key,
					value: { text, polarity: "affirmed" },
					quote: text,
					replacesItemId,
				},
			],
		},
		relations: [
			{
				actionIndex: 0,
				relation: replacesItemId ? "supersedes" : "new",
				relatedItemIds: replacesItemId ? [replacesItemId] : [],
			},
		],
		groups: [[0]],
	};
}
function forgetProposal(itemId: string) {
	return {
		decision: { clarification: null, actions: [{ type: "forget", itemId }] },
		relations: [
			{ actionIndex: 0, relation: "forget", relatedItemIds: [itemId] },
		],
		groups: [[0]],
	};
}

test("installed Eumenes, memory CLI and two MCP processes share curation, correction, forgetting and recovery", async () => {
	const h = await setupMemory();
	const socket = join(h.dir, "memory.sock");
	const credential = randomBytes(32).toString("hex");
	const config: HostConfig = {
		version: 1,
		principal: PRINCIPAL,
		scopeKeys: [PROFILE_SCOPE],
		socketPath: socket,
		credentials: {
			[credential]: {
				clientId: "installed-acceptance",
				scopeKeys: [PROFILE_SCOPE],
				read: true,
				write: true,
				forgetAll: true,
				confirmedWrites: true,
			},
		},
	};
	const options = {
		port: h.memory.sharedHost,
		configuration: () => config,
		resolveSource: h.memory.sharedHost.resolveSource,
	};
	let host = new MemoryHost(options);
	let transport: Awaited<ReturnType<typeof serveHost>> | undefined;
	let api: ReturnType<typeof Bun.serve> | undefined;
	const clients: Client[] = [];
	const profile = join(h.dir, "profile.json");
	writeFileSync(
		profile,
		JSON.stringify({ version: 1, socketPath: socket, credential }),
		{ mode: 0o600 },
	);
	const cliCall = (method: string, input?: unknown) =>
		runCli(
			cli,
			[
				"--profile",
				profile,
				method,
				...(input === undefined ? [] : ["--input", "-"]),
			],
			input,
		);
	try {
		await host.start();
		h.memory.registerForgetPurge((db, purge) =>
			host.invalidateDerivedInTransaction(db, {
				scopeKeys: [PROFILE_SCOPE],
				itemIds: purge.itemIds,
				forgetIds: purge.forgetIds ?? [],
			}),
		);
		transport = await serveHost(host, socket);
		const http = new Hono();
		http.use("*", async (c, next) =>
			c.req.header("authorization") === `Bearer ${credential}`
				? await next()
				: c.json({ error: "unauthorized" }, 401),
		);
		registerMemory(http, h.memory);
		api = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: http.fetch });
		const appEnvironment = {
			EUMENES_URL: api.url.toString(),
			EUMENES_API_TOKEN: credential,
			EUMENES_DB: join(h.dir, "unused.sqlite3"),
			EUMENES_KEY_DIR: join(h.dir, "unused-keys"),
		};
		expect(
			await runCli(
				appCli,
				["memory", "status", "--json"],
				undefined,
				appEnvironment,
			),
		).toMatchObject({ enabled: true, healthy: true });
		expect((await cliCall("status")).status).toBe("ready");
		const a = await connect(profile);
		clients.push(a);
		const b = await connect(profile);
		clients.push(b);
		expect(a.getServerVersion()).toEqual({
			name: "eumenes-memory",
			version: "0.1.0",
		});
		expect((await a.listTools()).tools.map((t) => t.name).sort()).toEqual([
			"memory_apply",
			"memory_context",
			"memory_operation",
			"memory_plan",
			"memory_read",
			"memory_source",
			"memory_status",
		]);
		await expect(
			a.callTool({ name: "memory_missing", arguments: {} }),
		).rejects.toThrow();

		const messageId = await h.say("user", "休日は折り紙を楽しみます");
		const appItem = await saveItem(h.store, h.memory, {
			conversationId: "c1",
			messageId,
			kind: "habit",
			semanticKey: "installed-origami",
			text: "休日は折り紙を楽しむ",
			quote: "休日は折り紙を楽しみます",
		});
		const appView = await tool(a, "context");
		expect(
			(appView["items"] as Item[]).find((x) => x.itemId === appItem.id),
		).toMatchObject({ origin: "user_confirmed", evidenceStatus: "current" });
		expect(
			((await cliCall("context"))["items"] as Item[]).some(
				(x) => x.itemId === appItem.id,
			),
		).toBe(true);
		const appRead = await tool(b, "read", {
			snapshotId: appView["snapshotId"],
			itemId: appItem.id,
		});
		expect(appRead["sources"]).toMatchObject([
			{ status: "available", source: { content: "休日は折り紙を楽しみます" } },
		]);

		const text = "平日の夜だけ薄荷茶を飲みます";
		const source = await cliCall("source", {
			scopeKey: PROFILE_SCOPE,
			submissionId: "installed-source",
			content: text,
		});
		const plan = await cliCall("plan", {
			snapshotId: appView["snapshotId"],
			scopeKey: PROFILE_SCOPE,
			proposal: rememberProposal(text, "installed-tea"),
			evidence: [
				{
					actionIndex: 0,
					sourceHandle: source["sourceHandle"],
					startByte: 0,
					endByte: Buffer.byteLength(text),
				},
			],
		});
		expect(plan.status).toBe("planned");
		const params = {
			planId: plan["planId"],
			epoch: plan["epoch"],
			operationId: "installed-save",
		};
		expect((await cliCall("apply", params)).status).toBe("completed");
		expect(
			(
				await tool(a, "operation", {
					operationId: params.operationId,
					epoch: params.epoch,
				})
			).status,
		).toBe("completed");
		const item = h.memory
			.list()
			.find((x) => x.semanticKey === "installed-tea")!;
		expect(item).toMatchObject({ text, origin: "agent_inferred" });
		const nativeList = await runCli<{ id: string }[]>(
			appCli,
			["memory", "list", "--json"],
			undefined,
			appEnvironment,
		);
		expect(nativeList.some((x) => x.id === item.id)).toBe(true);
		const view = await tool(b, "context");
		expect(
			(view["items"] as Item[]).find((x) => x.itemId === item.id)
				?.evidenceStatus,
		).toBe("current");

		const corrected = "平日の朝だけ薄荷茶を飲みます";
		const correctionSource = await tool(b, "source", {
			scopeKey: PROFILE_SCOPE,
			submissionId: "installed-correction",
			content: corrected,
		});
		const correction = await tool(b, "plan", {
			snapshotId: view["snapshotId"],
			scopeKey: PROFILE_SCOPE,
			proposal: rememberProposal(corrected, "installed-tea", item.id),
			evidence: [
				{
					actionIndex: 0,
					sourceHandle: correctionSource["sourceHandle"],
					startByte: 0,
					endByte: Buffer.byteLength(corrected),
				},
			],
		});
		expect(correction.status).toBe("planned");
		const correctionParams = {
			planId: correction["planId"],
			epoch: correction["epoch"],
			operationId: "installed-correction",
		};
		const [one, two] = await Promise.all([
			tool(a, "apply", correctionParams),
			tool(b, "apply", correctionParams),
		]);
		expect(one.status).toBe("completed");
		expect(two).toEqual(one);
		expect(
			h.memory.list(true).filter((x) => x.semanticKey === "installed-tea"),
		).toHaveLength(2);
		expect(
			h.memory.list().find((x) => x.semanticKey === "installed-tea")?.text,
		).toBe(corrected);
		expect(
			await tool(a, "read", { snapshotId: view["snapshotId"] }),
		).toMatchObject({ status: "stale", code: "SNAPSHOT_STALE" });
		await a.close();
		expect((await tool(b, "status")).status).toBe("ready");
		const reconnected = await connect(profile);
		clients.push(reconnected);
		const latest = await tool(reconnected, "context");
		const current = (latest["items"] as Item[]).find(
			(x) => x.semanticKey === "installed-tea",
		)!;
		expect(current.value.text).toBe(corrected);
		const fence = h.store.read((db) => h.memory.forgetSeqInTransaction(db));
		const forget = await cliCall("plan", {
			snapshotId: latest["snapshotId"],
			scopeKey: PROFILE_SCOPE,
			proposal: forgetProposal(current.itemId),
		});
		expect(forget.status).toBe("planned");
		expect(
			(
				await cliCall("apply", {
					planId: forget["planId"],
					epoch: forget["epoch"],
					operationId: "installed-forget",
				})
			).status,
		).toBe("completed");
		expect(
			h.memory.list(true).some((x) => x.semanticKey === "installed-tea"),
		).toBe(false);
		expect(
			h.store.read((db) => h.memory.forgetSeqInTransaction(db)),
		).toBeGreaterThan(fence);
		expect(
			await tool(b, "apply", {
				...params,
				operationId: "cannot-replay-forgotten-plan",
			}),
		).toMatchObject({ code: "PLAN_UNAVAILABLE" });

		const beforeCorrection = await tool(b, "context");
		expect(
			(
				await h.conversation.correct({
					messageId,
					text: "折り紙の発言を取り消します",
				})
			).status,
		).toBe("applied");
		expect(
			await tool(b, "read", { snapshotId: beforeCorrection["snapshotId"] }),
		).toMatchObject({ code: "SNAPSHOT_STALE" });
		const stale = await tool(b, "context");
		expect(
			(stale["items"] as Item[]).find((x) => x.itemId === appItem.id)
				?.evidenceStatus,
		).toBe("stale");
		expect(
			(
				await h.memory.forget({
					conversationId: "c1",
					itemIds: [appItem.id],
					messageIds: [messageId],
				})
			).completed,
		).toBe(true);
		expect(h.memory.blockedMessageIds([messageId]).has(messageId)).toBe(true);
		expect((await tool(b, "context"))["items"]).toEqual([]);
		const oldEpoch = host.epoch;
		for (const client of clients) await client.close();
		clients.length = 0;
		await transport.close();
		transport = undefined;
		rmSync(socket, { force: true });
		host = new MemoryHost(options);
		await host.start();
		transport = await serveHost(host, socket);
		const restored = await connect(profile);
		clients.push(restored);
		expect(host.epoch).not.toBe(oldEpoch);
		expect((await tool(restored, "context"))["items"]).toEqual([]);
		expect(
			(
				await tool(restored, "operation", {
					operationId: params.operationId,
					epoch: params.epoch,
				})
			).status,
		).toBe("completed");
		expect(
			await runCli<unknown[]>(
				appCli,
				["memory", "list", "--json"],
				undefined,
				appEnvironment,
			),
		).toEqual([]);
	} finally {
		for (const client of clients) await client.close();
		await transport?.close();
		await api?.stop(true);
		await h.close();
	}
}, 30000);
