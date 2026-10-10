import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { Store } from "./store";
import { mcpHandler } from "./mcp";
import { publicHttpsPost, deliverNext, type WebhookPost } from "./webhook";
import { ContractError, sendSchema } from "./contracts";

export function equalSecret(a: string, b: string) {
	return (
		Buffer.byteLength(a) === Buffer.byteLength(b) &&
		timingSafeEqual(Buffer.from(a), Buffer.from(b))
	);
}
export async function boundedJson(req: Request) {
	if (!req.body) throw new ContractError("missing_body", 400);
	const reader = req.body.getReader();
	const parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > 65536) {
			await reader.cancel();
			throw new ContractError("body_too_large", 413);
		}
		parts.push(value);
	}
	try {
		return JSON.parse(Buffer.concat(parts).toString());
	} catch {
		throw new ContractError("invalid_json", 400);
	}
}
export function startServer(options: {
	directory: string;
	port?: number;
	privateTunnel?: boolean;
	post?: WebhookPost;
	worker?: boolean;
}) {
	const store = new Store(options.directory);
	const owner = "script-owner";
	const post = options.post ?? publicHttpsPost;
	const mcp = mcpHandler(store, owner, post);
	let busy = false;
	let closed = false;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 8797,
		maxRequestBodySize: 65536,
		idleTimeout: 150,
		async fetch(req) {
			const url = new URL(req.url);
			try {
				// Host and Origin defenses apply before both local operator and tunneled MCP routes.
				if (!["127.0.0.1", "localhost"].includes(url.hostname))
					return new Response("Invalid host", { status: 403 });
				const origin = req.headers.get("origin");
				if (origin && origin !== url.origin)
					return new Response("Invalid origin", { status: 403 });
				if (url.pathname === "/mcp") {
					if (
						!options.privateTunnel &&
						!equalSecret(
							req.headers.get("authorization") ?? "",
							`Bearer ${store.secrets.admin}`,
						)
					)
						return new Response("Authentication required", { status: 401 });
					store.audit("mcp.received");
					return await mcp.fetch(req);
				}
				if (
					!equalSecret(
						req.headers.get("authorization") ?? "",
						`Bearer ${store.secrets.admin}`,
					)
				)
					return new Response("Unauthorized", { status: 401 });
				if (url.pathname === "/local/status" && req.method === "GET")
					return Response.json(store.status(owner));
				if (url.pathname === "/local/requests" && req.method === "POST")
					return Response.json(
						store.send(owner, sendSchema.parse(await boundedJson(req))),
					);
				const match =
					/^\/local\/requests\/([0-9a-f-]+)(?:\/(wait|cancel))?$/.exec(
						url.pathname,
					);
				if (!match) return new Response("Not found", { status: 404 });
				const id = z.uuid().parse(match[1]);
				const action = match[2];
				if (action === "cancel" && req.method === "POST")
					return Response.json(store.cancel(id));
				if (action === "wait" && req.method === "GET") {
					const timeout = z.coerce
						.number()
						.int()
						.min(1)
						.max(120000)
						.parse(url.searchParams.get("timeoutMs") ?? 120000);
					const start = Date.now();
					let cancelled = false;
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							const send = () => {
								if (cancelled || closed) return;
								try {
									const snapshot = store.get(id);
									controller.enqueue(
										Buffer.from(`data: ${JSON.stringify(snapshot)}\n\n`),
									);
									if (
										snapshot.state !== "pending" ||
										Date.now() - start >= timeout
									) {
										cancelled = true;
										controller.close();
										return;
									}
									setTimeout(send, 500);
								} catch {
									cancelled = true;
									controller.close();
								}
							};
							send();
						},
						cancel() {
							cancelled = true;
						},
					});
					return new Response(stream, {
						headers: {
							"Content-Type": "text/event-stream",
							"Cache-Control": "no-store",
						},
					});
				}
				if (!action && req.method === "GET")
					return Response.json(store.get(id));
				return new Response("Method not allowed", { status: 405 });
			} catch (e) {
				if (e instanceof ContractError)
					return Response.json({ error: e.code }, { status: e.status });
				if (e instanceof z.ZodError)
					return Response.json({ error: "invalid_input" }, { status: 400 });
				store.audit("server.error");
				return Response.json({ error: "internal_error" }, { status: 500 });
			}
		},
	});
	const interval =
		options.worker === false
			? null
			: setInterval(async () => {
					if (busy || closed) return;
					busy = true;
					try {
						await deliverNext(store, post);
					} catch {
						store.audit("worker.error");
					} finally {
						busy = false;
					}
				}, 250);
	return {
		server,
		store,
		url: `http://127.0.0.1:${server.port}`,
		async close() {
			closed = true;
			if (interval) clearInterval(interval);
			await server.stop(true);
			while (busy) await Bun.sleep(10);
			store.close();
		},
	};
}
