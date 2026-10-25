import { registerDotsMessaging } from "./dots-messaging-http";
import type { DotsMessages } from "./dots-messages";
import type { Hono } from "hono";
import { parseJsonBody } from "../../infrastructure/http";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
	createHandler,
	verifyAccess,
	scopes,
	type OAuth,
} from "../../../packages/dots-mcp/src";
import {
	claimInput,
	commandRef,
	reportSchema,
	ref,
	connectionInput,
	projectInput,
	messageReplyInput,
} from "../../domains/dots";
import { dotsMcpSkill as coordinatorSkill } from "../../domains/capabilities";
import type { DotsTasks } from "./dots-tasks";
import type { createEvents } from "../../domains/dots";
import { readBounded } from "../../infrastructure/bounded-read";
import type { TasksService } from "../../domains/tasks";
import { limitConcurrency } from "../../infrastructure/concurrency";
export function registerDots(
	app: Hono,
	dots: DotsTasks,
	events: ReturnType<typeof createEvents>,
	tasks: TasksService,
	verify = verifyAccess,
	messages?: DotsMessages,
) {
	if (messages) registerDotsMessaging(app, messages);
	const json = async (req: Request) =>
		JSON.parse(
			Buffer.from(
				await readBounded(req.body, {
					limit: 65536,
					tooLarge: "payload_too_large",
					missing: "invalid_dots_input",
					signal: req.signal,
				}),
			).toString(),
		);
	app.get("/api/dots/configuration", (c) =>
		c.json({
			...dots.config.list(),
			...(messages
				? { messageConversations: messages.listConversations() }
				: {}),
			events: dots.config.list().connections.map((x) => ({
				connectionRef: x.id,
				...events.status(x.id),
				...(messages ? { messaging: messages.setting(x.id) } : {}),
			})),
		}),
	);
	app.put("/api/dots/connections", async (c) => {
		const b = await parseJsonBody(c, connectionInput, {
			code: "invalid_dots_input",
		});
		return b.ok ? c.json(await dots.config.configure(b.data)) : b.response;
	});
	app.put("/api/dots/projects", async (c) => {
		const b = await parseJsonBody(c, projectInput, {
			code: "invalid_dots_input",
		});
		return b.ok
			? c.json(await dots.config.configureProject(b.data))
			: b.response;
	});
	app.post("/api/dots/tasks/:id/schedules", async (c) => {
		const p = z.strictObject({ scheduleRef: ref }).parse(await json(c.req.raw));
		return c.json(await dots.bindSchedule(c.req.param("id"), p.scheduleRef));
	});
	app.get("/api/dots/tasks/:id/snapshot", (c) => {
		const { task: t } = tasks.get(c.req.param("id"));
		if (t.kind !== "orchestration") throw new Error("dots_not_found");
		return c.json(dots.taskSnapshot(t.grant.connectionRef, t.id));
	});
	app.get("/.well-known/oauth-protected-resource/mcp/dots/:owner", (c) => {
		const oauth = dots.config
			.list()
			.connections.find((x) => x.id === c.req.param("owner"))?.oauth;
		if (!oauth) return c.json({ error: "dots_not_found" }, 404);
		return c.json({
			resource: oauth.resource,
			authorization_servers: [oauth.issuer],
			scopes_supported: scopes,
			bearer_methods_supported: ["header"],
		});
	});
	app.on(
		["GET", "POST", "DELETE"],
		"/mcp/dots/:owner",
		limitConcurrency(4),
		async (c) => {
			const owner = c.req.param("owner"),
				connection = dots.config.list().connections.find((x) => x.id === owner);
			if (!connection) return c.json({ error: "dots_not_found" }, 404);
			const url = new URL(c.req.url),
				origin = c.req.header("origin");
			if (origin && origin !== url.origin)
				return c.json({ error: "origin_forbidden" }, 403);
			const bearer = c.req
				.header("authorization")
				?.match(/^Bearer ([^\s]{24,8192})$/)?.[1];
			let accessUntil = Date.now() + 3600000;
			try {
				if (!bearer) throw new Error("dots_permission_denied");
				if (connection.oauth) {
					const access = await verify(connection.oauth as OAuth, bearer);
					accessUntil = access.expiresAt;
				} else {
					if (
						url.protocol !== "http:" ||
						!["127.0.0.1", "localhost"].includes(url.hostname) ||
						c.req.header("forwarded") ||
						c.req.header("x-forwarded-for") ||
						c.req.header("x-forwarded-host") ||
						c.req.header("x-forwarded-proto")
					)
						throw new Error("dots_permission_denied");
					if (dots.config.authenticateLocal(bearer).id !== owner)
						throw new Error("dots_permission_denied");
				}
			} catch {
				const metadata = connection.oauth
					? new URL(
							`/.well-known/oauth-protected-resource/mcp/dots/${owner}`,
							connection.oauth.resource,
						).href
					: null;
				c.header(
					"WWW-Authenticate",
					metadata
						? `Bearer resource_metadata="${metadata}", scope="${scopes.join(" ")}"`
						: "Bearer",
				);
				return c.json({ error: "unauthorized" }, 401);
			}
			const uri = "skill://eumenes/eumenes-coordinator/SKILL.md";
			// Every request gets an owner-bound handler; mutable globals cannot mix principals.
			const handler = createHandler({
				skill: {
					uri,
					frontmatter: {
						name: "eumenes-coordinator",
						description:
							"Answer message commands with replies and summaries, and coordinate explicitly authorized task commands through MCP.",
					},
					resources: [
						{
							uri,
							mimeType: "text/markdown",
							text: coordinatorSkill,
							digest:
								"sha256:" +
								createHash("sha256").update(coordinatorSkill).digest("hex"),
						},
					],
				},
				subscribe: (s) =>
					events.subscribe(owner, {
						...s,
						ttlMs: Math.max(
							1,
							Math.min(s.ttlMs ?? 3600000, accessUntil - Date.now()),
						),
					}),
				unsubscribe: (url) => events.unsubscribe(owner, url),
				tools: [
					...(messages
						? [
								{
									name: "submit_message_reply",
									description:
										"Save one final reply and cumulative summary for a claimed message command. Use its messageId, commandId, leaseId and epoch; retry identical replyId and content after uncertainty. This is not task completion.",
									schema: messageReplyInput,
									readOnly: false,
									invoke: (v: unknown) => messages.reply(owner, v),
								},
							]
						: []),
					{
						name: "list_pending_commands",
						description:
							"List only this connection's pending command references. Fetch commands before claiming.",
						schema: z.strictObject({
							after: z.number().int().min(0).default(0),
							limit: z.number().int().min(1).max(100).default(50),
						}),
						readOnly: true,
						invoke: (v) => {
							const x = z
								.object({ after: z.number(), limit: z.number() })
								.parse(v);
							return dots.commands.list(owner, x.after, x.limit);
						},
					},
					{
						name: "get_command",
						description:
							"Read the current authorized command. Message commands contain text and summary context; task commands contain a frozen grant, profile, Skills and sessions.",
						schema: commandRef,
						readOnly: true,
						invoke: (v) =>
							messages?.handles(owner, commandRef.parse(v).commandId)
								? messages.getCommand(owner, commandRef.parse(v).commandId)
								: dots.getCommand(owner, commandRef.parse(v).commandId),
					},
					{
						name: "claim_command",
						description:
							"Claim before processing a command. Reuse a stable UUID lease; a message command does not authorize creating a session.",
						schema: claimInput,
						readOnly: false,
						invoke: (v) =>
							messages?.handles(owner, claimInput.parse(v).commandId)
								? messages.claim(owner, v)
								: dots.claim(owner, v),
					},
					{
						name: "get_task_snapshot",
						description:
							"Refresh authoritative state, open question, recorded sessions and report sequence before acting.",
						schema: z.strictObject({ taskId: ref }),
						readOnly: true,
						invoke: (v) =>
							dots.taskSnapshot(
								owner,
								z.object({ taskId: ref }).parse(v).taskId,
							),
					},
					{
						name: "report_task",
						description:
							"Report session references, progress, a blocker/question, completion evidence, no next work, a registered reminder or confirmed child stopping. Retry the same reportId and bytes.",
						schema: reportSchema,
						readOnly: false,
						invoke: (v) => dots.report(owner, v),
					},
				],
			});
			return handler.fetch(c.req.raw);
		},
	);
}
