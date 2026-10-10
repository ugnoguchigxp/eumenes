export { Webhook } from "standardwebhooks";
import {
	McpServer,
	createMcpHandler,
	ProtocolError,
} from "@modelcontextprotocol/server";
import { z } from "zod";
export { verifyAccess, scopes, type OAuth } from "./auth";
export { publicHttpsPost, publicHttpsGet, type WebhookPost } from "./webhook";
export const eventName = "command.available";
export const eventArguments = z.strictObject({
	queue_id: z.literal("eumenes-dots"),
});
export const subscribeSchema = z.strictObject({
	name: z.literal(eventName),
	arguments: eventArguments,
	delivery: z.strictObject({
		mode: z.literal("webhook"),
		url: z.url(),
		secret: z
			.string()
			.regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/)
			.min(38)
			.max(94),
	}),
	cursor: z.null().optional(),
	ttlMs: z.number().int().positive().max(86400000).nullable().optional(),
});
export const unsubscribeSchema = subscribeSchema
	.omit({ cursor: true, ttlMs: true })
	.extend({ delivery: subscribeSchema.shape.delivery.omit({ secret: true }) });
export type SubscriptionInput = z.infer<typeof subscribeSchema>;
export type Tool = {
	name: string;
	description: string;
	schema: z.ZodType;
	readOnly: boolean;
	invoke: (input: unknown) => unknown | Promise<unknown>;
};
export type Skill = {
	uri: string;
	frontmatter: { name: string; description: string };
	resources: Array<{
		uri: string;
		mimeType: string;
		text: string;
		digest: string;
	}>;
};
export function createHandler(input: {
	tools: Tool[];
	skill: Skill;
	subscribe: (s: SubscriptionInput) => Promise<Record<string, unknown>>;
	unsubscribe: (url: string) => Promise<Record<string, unknown>>;
}) {
	return createMcpHandler(
		() => {
			const capabilities = {
				tools: {},
				events: {},
				resources: {},
				extensions: { "io.modelcontextprotocol/skills": {} },
			};
			const manifest = {
				uri: input.skill.uri,
				frontmatter: input.skill.frontmatter,
				resources: input.skill.resources.map(({ uri, digest }) => ({
					uri,
					digest,
				})),
			};
			const server = new McpServer(
				{ name: "eumenes-dots", version: "1.0.0" },
				{
					capabilities,
					instructions:
						"You coordinate delegated Eumenes work across authorized Codex projects and sessions. On command.available, list_pending_commands, get_command, then claim_command with a stable UUID lease. Events contain references only. Do not create duplicate sessions. Carry the returned task, role and Skill context to child work. Always report session references, blockers, results, no_next_work and stop confirmation through report_task. Before acting, refresh get_task_snapshot. Only explicitly authorized existing chats may be continued. Native reports are claims, not independent verification.",
				},
			);
			for (const t of input.tools)
				server.registerTool(
					t.name,
					{
						description: t.description,
						inputSchema: t.schema,
						annotations: {
							readOnlyHint: t.readOnly,
							destructiveHint: false,
							openWorldHint: false,
							idempotentHint: true,
						},
						_meta: {
							securitySchemes: [
								{
									type: "oauth2",
									scopes: ["dots:read", "dots:report", "dots:events"],
								},
							],
						},
					},
					async (raw) => {
						try {
							const result = await t.invoke(raw);
							return {
								content: [
									{ type: "text" as const, text: JSON.stringify(result) },
								],
								structuredContent: result as Record<string, unknown>,
							};
						} catch (e) {
							const code =
								e instanceof Error &&
								/^(dots_|invalid_|task_|capability_)[a-z_]+$/.test(e.message)
									? e.message
									: "dots_operation_failed";
							return {
								isError: true,
								content: [{ type: "text" as const, text: code }],
							};
						}
					},
				);
			server.server.setRequestHandler(
				"tools/list",
				{ params: z.strictObject({ cursor: z.string().optional() }) },
				async () => ({
					tools: input.tools.map((t) => ({
						name: t.name,
						description: t.description,
						inputSchema: z.toJSONSchema(t.schema),
						annotations: {
							readOnlyHint: t.readOnly,
							destructiveHint: false,
							openWorldHint: false,
							idempotentHint: true,
						},
						securitySchemes: [
							{
								type: "oauth2",
								scopes: ["dots:read", "dots:report", "dots:events"],
							},
						],
					})),
				}),
			);
			server.server.setRequestHandler(
				"events/list",
				{ params: z.strictObject({ cursor: z.string().optional() }) },
				async () => ({
					events: [
						{
							name: eventName,
							description:
								"Eumenes has an authorized command. Fetch pending references, claim it, coordinate its work and report through MCP.",
							delivery: ["webhook"],
							inputSchema: z.toJSONSchema(eventArguments),
							payloadSchema: {
								type: "object",
								properties: {
									command_id: { type: "string" },
									queue_id: { const: "eumenes-dots" },
								},
								required: ["command_id", "queue_id"],
								additionalProperties: false,
							},
						},
					],
				}),
			);
			server.server.setRequestHandler(
				"events/subscribe",
				{ params: subscribeSchema },
				async (s) => {
					try {
						return await input.subscribe(s);
					} catch (e) {
						if (e instanceof Error && e.message === "dots_conflict")
							throw new ProtocolError(-32602, "dots_conflict");
						throw new ProtocolError(-32015, "dots_subscription_failed", {
							reason:
								e instanceof Error && e.message === "dots_callback_timeout"
									? "timeout"
									: "challenge_failed",
						});
					}
				},
			);
			server.server.setRequestHandler(
				"events/unsubscribe",
				{ params: unsubscribeSchema },
				async (s) => input.unsubscribe(s.delivery.url),
			);
			server.server.setRequestHandler(
				"skills/list",
				{ params: z.strictObject({ cursor: z.string().optional() }) },
				async () => ({ skills: [manifest] }),
			);
			server.server.setRequestHandler(
				"skills/get",
				{ params: z.strictObject({ uri: z.string() }) },
				async (s) => {
					if (s.uri !== input.skill.uri) throw new Error("dots_not_found");
					return { skill: manifest };
				},
			);
			server.server.setRequestHandler(
				"resources/read",
				{ params: z.strictObject({ uri: z.string() }) },
				async (s) => {
					const r = input.skill.resources.find((r) => r.uri === s.uri);
					if (!r) throw new Error("dots_not_found");
					return {
						contents: [{ uri: r.uri, mimeType: r.mimeType, text: r.text }],
					};
				},
			);
			return server;
		},
		{ legacy: "stateless", responseMode: "auto", maxRequestBodySize: 131072 },
	);
}
