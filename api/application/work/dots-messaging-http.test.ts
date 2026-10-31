import { afterEach, expect, test } from "bun:test";
import { reportSchema, messageReplyInput } from "../../domains/dots";
import { createApp } from "../app";
import { registerDots } from "./dots-http";
import { dotsFixture } from "./dots-fixture";
import { createDotsMessages } from "./dots-messages";
import { createContinuityService } from "../../domains/continuity";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of clean.splice(0)) await f();
});
async function setup() {
	const f = await dotsFixture();
	clean.push(f.close);
	const messages = createDotsMessages({
		store: f.store,
		conversation: f.conversation,
		continuity: createContinuityService(f.store),
		commands: f.dots.commands,
		events: f.events,
	});
	const admin = "admin-" + "a".repeat(64),
		app = createApp({
			token: admin,
			origin: "http://localhost",
			modules: [
				{
					mount: (app) =>
						registerDots(app, f.dots, f.events, undefined, messages),
				},
			],
		});
	const api = async (
		path: string,
		body?: unknown,
		method = body ? "POST" : "GET",
	) => {
		const r = await app.request("http://localhost" + path, {
			method,
			headers: {
				authorization: `Bearer ${admin}`,
				"content-type": "application/json",
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		});
		return { status: r.status, body: await r.json() };
	};
	async function rpc(method: string, params: Record<string, unknown> = {}) {
		const version = "2026-07-28";
		const r = await app.request("http://localhost/mcp/dots/dots", {
			method: "POST",
			headers: {
				authorization: `Bearer ${f.connection.localToken}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": version,
				"Mcp-Method": method,
				...(method === "tools/call" ? { "Mcp-Name": String(params.name) } : {}),
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				method,
				params: {
					...params,
					_meta: {
						"io.modelcontextprotocol/protocolVersion": version,
						"io.modelcontextprotocol/clientCapabilities": {},
						"io.modelcontextprotocol/clientInfo": {
							name: "test",
							version: "1",
						},
					},
				},
			}),
		});
		const raw = await r.text();
		return JSON.parse(
			raw.startsWith("event:") || raw.startsWith("data:")
				? raw
						.split("\n")
						.find((x) => x.startsWith("data:"))!
						.slice(5)
				: raw,
		);
	}
	return { ...f, messages, app, api, rpc };
}
test("authenticated API and real MCP envelopes complete three session-free exchanges and summarize", async () => {
	const f = await setup();
	expect((await f.app.request("/api/dots/configuration")).status).toBe(401);
	expect(
		(
			await f.api(
				"/api/dots/connections/dots/messaging",
				{ expectedRevision: 0, enabled: true },
				"PUT",
			)
		).status,
	).toBe(200);
	expect((await f.rpc("server/discover")).result.capabilities.events).toEqual(
		{},
	);
	expect(
		(await f.rpc("tools/list")).result.tools.some(
			(t: { name: string }) => t.name === "submit_message_reply",
		),
	).toBe(true);
	const sub = await f.rpc("events/subscribe", {
		name: "command.available",
		arguments: { queue_id: "eumenes-dots" },
		delivery: {
			mode: "webhook",
			url: "https://receiver.example/callback",
			secret: "whsec_" + Buffer.alloc(32, 7).toString("base64"),
		},
	});
	expect(sub.result.id).toStartWith("sub_");
	const thread = (
		await f.api("/api/dots/message-conversations", {
			requestId: crypto.randomUUID(),
			connectionRef: "dots",
			conversationId: "http-message-chat",
		})
	).body;
	for (let i = 1; i <= 3; i++) {
		const msg = (
			await f.api(`/api/dots/message-conversations/${thread.id}/messages`, {
				requestId: crypto.randomUUID(),
				text: `入力${i}`,
			})
		).body;
		const call = (name: string, args: unknown) =>
			f.rpc("tools/call", { name, arguments: args });
		const command = (await call("get_command", { commandId: msg.commandId }))
			.result.structuredContent;
		expect(command.kind).toBe("message");
		expect(command.taskId).toBeUndefined();
		const leaseId = crypto.randomUUID();
		expect(
			(await call("claim_command", { commandId: msg.commandId, leaseId }))
				.result.isError,
		).not.toBe(true);
		const reply = {
			replyId: crypto.randomUUID(),
			commandId: msg.commandId,
			messageId: msg.id,
			leaseId,
			epoch: command.authorityEpoch,
			outcome: "answered",
			replyText: `返答${i}`,
			summary: `累積要約${i}`,
			coveredMessageIds: [command.snapshot.sourceMessageId],
			limitations: [],
		};
		const saved = await call("submit_message_reply", reply);
		expect(saved.result.structuredContent.state).toBe("answered");
		expect(
			(await call("submit_message_reply", reply)).result.structuredContent,
		).toEqual(saved.result.structuredContent);
	}
	const view = await f.api(`/api/dots/message-conversations/${thread.id}`);
	expect(view.body.items).toHaveLength(3);
	expect(view.body.items[2].reply.summary).toBe("累積要約3");
	expect(f.tasks.list().items).toHaveLength(0);
});

test("message replies and task reports cannot cross their command contracts", async () => {
	const f = await setup();
	await f.messages.configure("dots", { expectedRevision: 0, enabled: true });
	await f.events.subscribe("dots", {
		name: "command.available",
		arguments: { queue_id: "eumenes-dots" },
		delivery: {
			mode: "webhook",
			url: "https://receiver.example/callback",
			secret: "whsec_" + Buffer.alloc(32, 7).toString("base64"),
		},
	});
	const thread = await f.messages.open({
		requestId: crypto.randomUUID(),
		connectionRef: "dots",
		conversationId: "isolated",
	});
	const m = await f.messages.send(thread.id, {
		requestId: crypto.randomUUID(),
		text: "明示したメッセージ",
	});
	const task = await f.tasks.create(f.input()),
		command = f.command(task.taskId);
	const wrongReport = {
		reportId: crypto.randomUUID(),
		commandId: m.commandId,
		taskId: task.taskId,
		authorityEpoch: m.epoch,
		executionGeneration: 1,
		sourceSequence: 1,
		kind: "accepted",
		summary: "受領",
	};
	reportSchema.parse(wrongReport);
	expect(
		(await f.rpc("tools/call", { name: "report_task", arguments: wrongReport }))
			.result.isError,
	).toBe(true);
	const wrongReply = {
		replyId: crypto.randomUUID(),
		commandId: command.commandId,
		messageId: m.id,
		leaseId: crypto.randomUUID(),
		epoch: m.epoch,
		outcome: "answered",
		replyText: "返答",
		summary: "要約",
		coveredMessageIds: [],
		limitations: [],
	};
	messageReplyInput.parse(wrongReply);
	expect(
		(
			await f.rpc("tools/call", {
				name: "submit_message_reply",
				arguments: wrongReply,
			})
		).result.isError,
	).toBe(true);
	expect(f.messages.view(thread.id).items[0]?.state).toBe("pending");
});
