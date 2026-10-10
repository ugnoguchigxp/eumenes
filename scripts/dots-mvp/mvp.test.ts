import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { startServer } from "./server";
import { startBridge } from "./bridge";
import { Store } from "./store";
import { EVENT, QUEUE, VERSION, subscriptionSchema } from "./contracts";
import {
	deliverNext,
	publicHttpsPost,
	pinnedLookup,
	type WebhookPost,
} from "./webhook";

const owner = "script-owner";
const callback = "https://receiver.example.com/events";
const secret = () => `whsec_${randomBytes(32).toString("base64")}`;
test("TLS address pinning honors both Node DNS lookup contracts", () => {
	const address = { address: "93.184.216.34", family: 4 };
	const lookup = pinnedLookup(address);
	lookup("receiver.example.com", { all: true }, (error, result, family) => {
		expect(error).toBeNull();
		expect(result).toEqual([address]);
		expect(family).toBeUndefined();
	});
	lookup("receiver.example.com", { all: false }, (error, result, family) => {
		expect(error).toBeNull();
		expect(result).toBe(address.address);
		expect(family).toBe(4);
	});
});
function directory() {
	return mkdtempSync(tmpdir() + "/dots-mvp-test-");
}
function params(key = secret()) {
	return {
		name: EVENT,
		arguments: { queue_id: QUEUE },
		delivery: { mode: "webhook", url: callback, secret: key },
		cursor: null,
	};
}
async function rpc(
	url: string,
	token: string,
	method: string,
	input: Record<string, unknown> = {},
) {
	const response = await fetch(url + "/mcp", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": VERSION,
			"Mcp-Method": method,
			...(method === "tools/call" ? { "Mcp-Name": String(input.name) } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: randomUUID(),
			method,
			params: {
				...input,
				_meta: {
					"io.modelcontextprotocol/protocolVersion": VERSION,
					"io.modelcontextprotocol/clientCapabilities": {},
					"io.modelcontextprotocol/clientInfo": {
						name: "fixture",
						version: "1",
					},
				},
			},
		}),
	});
	return {
		status: response.status,
		data: (await response.json()) as {
			result?: Record<string, any>;
			error?: { code: number };
		},
	};
}
test("MCP 2.0 discovery, signed verification, event, real tool contracts, CLI wait and replay", async () => {
	const dir = directory();
	const key = secret();
	const delivered: string[] = [];
	const post: WebhookPost = async (_url, body, headers) => {
		const event = new Webhook(key).verify(body, headers) as Record<
			string,
			unknown
		>;
		if (event.type === "verification")
			return {
				status: 200,
				body: JSON.stringify({ challenge: event.challenge }),
				retryAfter: null,
			};
		delivered.push(body);
		return { status: 202, body: "", retryAfter: null };
	};
	let app = startServer({ directory: dir, port: 0, post, worker: false });
	try {
		expect((await fetch(app.url + "/mcp", { method: "POST" })).status).toBe(
			401,
		);
		const discovery = await rpc(
			app.url,
			app.store.secrets.admin,
			"server/discover",
		);
		expect(discovery.status).toBe(200);
		expect(discovery.data.result?.supportedVersions).toEqual([VERSION]);
		expect(discovery.data.result?.capabilities.events).toEqual({});
		expect(
			(await rpc(app.url, app.store.secrets.admin, "events/list")).data.result
				?.events[0].name,
		).toBe(EVENT);
		expect(
			(
				await rpc(app.url, app.store.secrets.admin, "tools/list")
			).data.result?.tools.map((x: any) => x.name),
		).toEqual(["list_pending_requests", "get_request", "submit_answer"]);
		const subscribe = await rpc(
			app.url,
			app.store.secrets.admin,
			"events/subscribe",
			params(key),
		);
		expect(subscribe.data.error).toBeUndefined();
		const subscriptionId = subscribe.data.result?.id;
		expect(
			(
				await rpc(
					app.url,
					app.store.secrets.admin,
					"events/subscribe",
					params(key),
				)
			).data.result?.id,
		).toBe(subscriptionId);
		const id = randomUUID();
		const input = {
			requestId: id,
			text: "任意の依頼本文：冬の朝をテーマに短い詩を作ってください。",
			deadlineMs: 600000,
		};
		const request = app.store.send(owner, input);
		expect(app.store.pending("another-owner")).toEqual([]);
		const pending = await rpc(app.url, app.store.secrets.admin, "tools/call", {
			name: "list_pending_requests",
			arguments: { queue_id: QUEUE },
		});
		expect(pending.data.result?.structuredContent.requests).toEqual([
			{ requestId: id, requestVersion: 1 },
		]);
		expect(app.store.send(owner, input)).toEqual(request);
		expect(() =>
			app.store.send(owner, { ...input, text: "different" }),
		).toThrow("request_id_conflict");
		await deliverNext(app.store, post);
		expect(delivered).toHaveLength(1);
		expect(JSON.parse(delivered[0]!).data).toEqual({
			request_id: id,
			request_version: 1,
			queue_id: QUEUE,
		});
		expect(app.store.get(id).state).toBe("pending");
		const read = await rpc(app.url, app.store.secrets.admin, "tools/call", {
			name: "get_request",
			arguments: { requestId: id, requestVersion: 1 },
		});
		expect(read.data.result?.structuredContent.request.text).toBe(input.text);
		const wait = fetch(app.url + `/local/requests/${id}/wait?timeoutMs=2000`, {
			headers: { Authorization: `Bearer ${app.store.secrets.admin}` },
		}).then((r) => r.text());
		const answer = {
			requestId: id,
			requestVersion: 1,
			outcome: "answered",
			text: "冬の朝、霜を踏む音が静かな道に響く。",
		};
		const saved = await rpc(app.url, app.store.secrets.admin, "tools/call", {
			name: "submit_answer",
			arguments: answer,
		});
		expect(saved.data.result?.isError).not.toBe(true);
		expect(app.store.pending(owner)).toEqual([]);
		expect(await wait).toContain(answer.text);
		expect(
			(
				await rpc(app.url, app.store.secrets.admin, "tools/call", {
					name: "submit_answer",
					arguments: answer,
				})
			).data.result?.structuredContent.receipt,
		).toEqual(saved.data.result?.structuredContent.receipt);
		expect(
			(
				await rpc(app.url, app.store.secrets.admin, "tools/call", {
					name: "submit_answer",
					arguments: { ...answer, text: "different" },
				})
			).data.result?.isError,
		).toBe(true);
		const raw = readFileSync(dir + "/state.sqlite");
		expect(raw.includes(Buffer.from(key))).toBe(false);
		expect(statSync(dir + "/admin.token").mode & 0o777).toBe(0o600);
		await app.close();
		app = startServer({ directory: dir, port: 0, post, worker: false });
		expect(app.store.get(id).answer?.text).toBe(answer.text);
		expect(app.store.active(owner)?.id).toBe(subscriptionId);
		const stop = params(key);
		const { secret: _, ...delivery } = stop.delivery;
		expect(
			(
				await rpc(app.url, app.store.secrets.admin, "events/unsubscribe", {
					name: EVENT,
					arguments: stop.arguments,
					delivery,
				})
			).data.result,
		).toBeDefined();
		expect(() =>
			app.store.send(owner, { ...input, requestId: randomUUID() }),
		).toThrow("not_subscribed");
	} finally {
		await app.close();
		rmSync(dir, { recursive: true });
	}
});
test("challenge failure never creates an active subscription; invalid arguments never POST", async () => {
	const dir = directory();
	let calls = 0;
	const app = startServer({
		directory: dir,
		port: 0,
		worker: false,
		post: async () => {
			calls++;
			return { status: 200, body: '{"challenge":"wrong"}', retryAfter: null };
		},
	});
	try {
		expect(
			(
				await rpc(
					app.url,
					app.store.secrets.admin,
					"events/subscribe",
					params(),
				)
			).data.error?.code,
		).toBe(-32015);
		expect(app.store.active(owner)).toBeNull();
		expect(
			(
				await rpc(app.url, app.store.secrets.admin, "events/subscribe", {
					...params(),
					arguments: { queue_id: "other" },
				})
			).data.error?.code,
		).toBe(-32602);
		expect(calls).toBe(1);
		for (const value of [
			"whsec_abc",
			"whsec_" + randomBytes(23).toString("base64"),
			"whsec_" + randomBytes(65).toString("base64"),
		])
			expect(subscriptionSchema.safeParse(params(value)).success).toBe(false);
	} finally {
		await app.close();
		rmSync(dir, { recursive: true });
	}
});
test("delivery retries preserve bytes and ID; 410/413 stop; expired and cancelled writes fail", async () => {
	const dir = directory();
	let time = Date.now();
	const store = new Store(dir, () => time);
	const key = secret();
	try {
		store.saveSubscription({ owner, url: callback, secret: key }, time);
		const id = randomUUID();
		store.send(owner, {
			requestId: id,
			text: "Generic request",
			deadlineMs: 600000,
		});
		const bodies: string[] = [];
		const timestamps: string[] = [];
		const post: WebhookPost = async (_u, b, h) => {
			bodies.push(b);
			timestamps.push(h["webhook-timestamp"]!);
			new Webhook(key).verify(b, h);
			return {
				status: bodies.length === 1 ? 503 : 202,
				body: "",
				retryAfter: "1",
			};
		};
		await deliverNext(store, post, time);
		time += 2000;
		await deliverNext(store, post, time);
		expect(bodies[1]).toBe(bodies[0]);
		expect(timestamps[1]).not.toBe(timestamps[0]);
		expect(store.get(id).delivery.state).toBe("accepted");
		for (const status of [410, 413]) {
			const requestId = randomUUID();
			store.send(owner, {
				requestId,
				text: "Another arbitrary request",
				deadlineMs: 1000,
			});
			await deliverNext(
				store,
				async () => ({ status, body: "", retryAfter: null }),
				time,
			);
			expect(store.get(requestId).delivery.state).toBe("failed");
		}
		const cancelled = randomUUID();
		store.send(owner, {
			requestId: cancelled,
			text: "取消する依頼",
			deadlineMs: 1000,
		});
		store.cancel(cancelled);
		expect(store.pending(owner).some((r) => r.requestId === cancelled)).toBe(
			false,
		);
		expect(() =>
			store.answer(owner, {
				requestId: cancelled,
				outcome: "answered",
				text: "late",
			}),
		).toThrow("request_cancelled");
		time += 1001;
		expect(() => store.read(owner, id.replace(/./g, "0"))).toThrow(
			"request_not_found",
		);
		const expired = randomUUID();
		store.send(owner, {
			requestId: expired,
			text: "期限切れ",
			deadlineMs: 1000,
		});
		time += 1000;
		expect(store.pending(owner).some((r) => r.requestId === expired)).toBe(
			false,
		);
		expect(() =>
			store.answer(owner, {
				requestId: expired,
				outcome: "answered",
				text: "late",
			}),
		).toThrow("request_expired");
		expect(() => new Store(dir)).toThrow("writer_already_running");
	} finally {
		store.close();
		rmSync(dir, { recursive: true });
	}
});
test("public delivery blocks private addresses and bridge exposes only capability MCP", async () => {
	for (const url of [
		"http://example.com",
		"https://127.0.0.1",
		"https://[::1]",
		"https://169.254.169.254",
		"https://u:p@example.com",
	])
		await expect(
			publicHttpsPost(url, "{}", {}, AbortSignal.timeout(1000)),
		).rejects.toThrow();
	const dir = directory();
	const app = startServer({ directory: dir, port: 0, worker: false });
	const bridge = startBridge(dir, app.url, 0);
	try {
		expect((await fetch(bridge.url + "/local/status")).status).toBe(404);
		expect((await fetch(bridge.url + "/mcp/wrong")).status).toBe(404);
		expect(
			(
				await fetch(bridge.url + bridge.path, {
					headers: { Origin: "https://evil.example" },
				})
			).status,
		).toBe(404);
		const response = await fetch(bridge.url + bridge.path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-11-25",
					capabilities: {},
					clientInfo: { name: "legacy-smoke", version: "1" },
				},
			}),
		});
		expect(response.status).toBe(200);
	} finally {
		bridge.server.stop(true);
		await app.close();
		rmSync(dir, { recursive: true });
	}
});
