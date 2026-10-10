import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { Webhook } from "../../packages/dots-mcp/src";
import { dotsFixture } from "./dots-fixture";
import { registerDots } from "./dots-http";
const clean: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const f of clean.splice(0)) await f();
});
async function setup() {
	const f = await dotsFixture();
	clean.push(f.close);
	const app = new Hono();
	registerDots(app, f.dots, f.events, f.tasks);
	return { ...f, app };
}
const version = "2026-07-28";
async function rpc(
	app: Hono,
	token: string,
	method: string,
	params: Record<string, unknown> = {},
	url = "http://localhost/mcp/dots/dots",
) {
	const r = await app.request(
		new Request(url, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": version,
				"Mcp-Method": method,
				...(method === "tools/call"
					? { "Mcp-Name": String(params.name) }
					: method === "resources/read"
						? { "Mcp-Name": String(params.uri) }
						: {}),
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
							name: "fixture",
							version: "1",
						},
					},
				},
			}),
		}),
	);
	const body = await r.text();
	const data = JSON.parse(
		body.startsWith("event:") || body.startsWith("data:")
			? body
					.split("\n")
					.find((s) => s.startsWith("data:"))!
					.slice(5)
			: body,
	);
	return { response: r, data };
}
test("MCP discovery, immutable Skill manifest, private ownership and real call schemas", async () => {
	const f = await setup(),
		token = f.connection.localToken!;
	expect((await rpc(f.app, "x".repeat(32), "tools/list")).response.status).toBe(
		401,
	);
	expect(
		(
			await rpc(
				f.app,
				token,
				"tools/list",
				{},
				"https://public.example/mcp/dots/dots",
			)
		).response.status,
	).toBe(401);
	const discovery = await rpc(f.app, token, "server/discover");
	expect(discovery.response.status).toBe(200);
	expect(discovery.data.result.capabilities.events).toEqual({});
	const tools = await rpc(f.app, token, "tools/list");
	expect(tools.data.result.tools).toHaveLength(5);
	expect(tools.data.result.tools[0].securitySchemes[0].type).toBe("oauth2");
	const catalog = (await rpc(f.app, token, "skills/list")).data.result.skills;
	expect(catalog).toHaveLength(1);
	const skill = catalog[0],
		read = await rpc(f.app, token, "resources/read", {
			uri: skill.resources[0].uri,
		});
	expect(read.data.error).toBeUndefined();
	const resource = read.data.result.contents[0];
	expect(skill.resources[0].digest).toBe(
		"sha256:" +
			new Bun.CryptoHasher("sha256").update(resource.text).digest("hex"),
	);
	expect(resource.text).toContain(`name: ${skill.frontmatter.name}`);
	expect(
		(await rpc(f.app, token, "skills/get", { uri: skill.uri })).data.result
			.skill,
	).toEqual(skill);
	const r = await f.tasks.create(f.input()),
		c = f.command(r.taskId);
	const call = (name: string, args: unknown) =>
		rpc(f.app, token, "tools/call", { name, arguments: args });
	expect(
		(await call("get_command", { commandId: c.commandId })).data.result
			.structuredContent.taskId,
	).toBe(r.taskId);
	expect(
		(
			await call("claim_command", {
				commandId: c.commandId,
				leaseId: crypto.randomUUID(),
			})
		).data.result.isError,
	).not.toBe(true);
	expect(
		(await call("report_task", f.report(c, 1, "accepted"))).data.result
			.structuredContent.state,
	).toBe("active");
});
test("Events are signed reference envelopes; receipt does not complete a task; unsubscribe stops delivery", async () => {
	const f = await setup(),
		token = f.connection.localToken!,
		secret = "whsec_" + Buffer.alloc(32, 7).toString("base64");
	const params = {
		name: "command.available",
		arguments: { queue_id: "eumenes-dots" },
		delivery: {
			mode: "webhook",
			url: "https://receiver.example/callback",
			secret,
		},
		cursor: null,
	};
	const subscription = (await rpc(f.app, token, "events/subscribe", params))
		.data.result;
	expect(subscription.id).toStartWith("sub_");
	expect(subscription.refreshBefore).toBeString();
	const again = await rpc(f.app, token, "events/subscribe", params);
	expect(again.data.result.id).toBe(subscription.id);
	expect(
		f.deliveries.filter((d) => JSON.parse(d.body).type === "verification"),
	).toHaveLength(1);
	const r = await f.tasks.create(f.input());
	f.queue.start();
	for (
		let i = 0;
		i < 100 && !f.deliveries.some((x) => JSON.parse(x.body).eventId);
		i++
	)
		await Bun.sleep(10);
	const d = f.deliveries.find((d) => JSON.parse(d.body).eventId)!;
	expect(d).toBeDefined();
	const event = JSON.parse(d.body);
	expect(event).toMatchObject({ name: "command.available", cursor: null });
	expect(event.type).toBeUndefined();
	expect(event.data).toEqual({
		command_id: f.command(r.taskId).commandId,
		queue_id: "eumenes-dots",
	});
	expect(d.headers["webhook-id"]).toBe(event.eventId);
	expect(new Webhook(secret).verify(d.body, d.headers)).toEqual(event);
	expect(f.tasks.get(r.taskId).task.state).toBe("queued");
	expect(
		(
			await rpc(f.app, token, "events/unsubscribe", {
				...params,
				delivery: { mode: "webhook", url: params.delivery.url },
				cursor: undefined,
			})
		).data.error,
	).toBeUndefined();
	expect(f.events.status("dots").subscribed).toBe(false);
});

test("queue saturation preserves a stop and retries its reference delivery after capacity returns", async () => {
	const f = await setup(),
		token = f.connection.localToken!;
	await rpc(f.app, token, "events/subscribe", {
		name: "command.available",
		arguments: { queue_id: "eumenes-dots" },
		delivery: {
			mode: "webhook",
			url: "https://receiver.example/callback",
			secret: "whsec_" + Buffer.alloc(32, 2).toString("base64"),
		},
	});
	const r = await f.tasks.create(f.input());
	const original = f.queue.enqueueInTransaction;
	f.queue.enqueueInTransaction = () => {
		throw new Error("queue_full");
	};
	try {
		await f.tasks.stop(r.taskId, {
			requestId: crypto.randomUUID(),
			expectedRevision: f.tasks.get(r.taskId).task.revision,
			intent: "cancel",
		});
	} finally {
		f.queue.enqueueInTransaction = original;
	}
	const stop = f.command(r.taskId, "stop");
	expect(f.tasks.get(r.taskId).task.state).toBe("stopping");
	await f.events.maintenance();
	f.queue.start();
	for (
		let i = 0;
		i < 100 &&
		!f.deliveries.some(
			(d) => JSON.parse(d.body).data?.command_id === stop.commandId,
		);
		i++
	)
		await Bun.sleep(10);
	expect(
		f.deliveries.some(
			(d) => JSON.parse(d.body).data?.command_id === stop.commandId,
		),
	).toBe(true);
});
