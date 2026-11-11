import { checkImageRequest } from "../service/cloud-images";
import { readCodexModels } from "./codex-models";
import { disabledFeatures, type CodexRuntime } from "./codex-sdk";
import { codexUsage, type CodexUsage } from "./codex-usage";
import { withCodexTransport } from "./codex-transport";
import { imageDataUrl } from "../../../infrastructure/chat-image-parts";

/** One conversation turn over `codex app-server` (stdio JSON-RPC), which streams
 * agent message deltas that `codex exec --json` only reports when complete. */
export type CodexTurn = {
	cwd: string;
	model: string;
	instructions: string;
	prompt: string;
	images?: import("../../../infrastructure/chat-image-parts").MessageImage[];
	outputSchema?: unknown;
	nativeWebSearch?: true;
	reasoningEffort?: "low" | "medium" | "high";
	signal: AbortSignal;
	/** The current agent message so far (cumulative), on every delta. */
	onMessage?: (text: string) => void;
	onUsage?: (usage: CodexUsage) => void;
};
export type CodexTurnResult = CodexUsage & {
	text: string;
	inputTokens: number | null;
	outputTokens: number | null;
};

export async function runCodexTurn(
	runtime: CodexRuntime,
	turn: CodexTurn,
	fail: (reason: string) => Error,
): Promise<CodexTurnResult> {
	return withCodexTransport(
		runtime,
		turn.cwd,
		turn.signal,
		fail,
		async ({ request, onNotification }) => {
			const done = Promise.withResolvers<CodexTurnResult>();
			const finish = (error: Error | null, value?: CodexTurnResult) =>
				error ? done.reject(error) : done.resolve(value!);
			done.promise.catch(() => {});
			let threadId: string | undefined;
			let turnId: string | undefined;
			let messageId: string | undefined;
			let message = "";
			let final = "";
			let searched = false;
			let usage: CodexUsage | null = null;
			let usageModel: string | null = turn.model;
			onNotification((method, params) => {
				if (params.threadId !== undefined && params.threadId !== threadId)
					return;
				if (params.turnId !== undefined && turnId && params.turnId !== turnId)
					return;
				if (
					turn.images?.length &&
					(method === "thread/compacted" ||
						((method === "item/started" || method === "item/completed") &&
							(params.item as { type?: string })?.type === "contextCompaction"))
				) {
					finish(new Error("image_context_compacted"));
				} else if (method === "item/agentMessage/delta") {
					if (params.itemId !== messageId) {
						messageId = params.itemId as string;
						message = "";
					}
					message += String(params.delta ?? "");
					turn.onMessage?.(message);
				} else if (method === "item/completed") {
					const item = params.item as { type?: string; text?: unknown };
					if (item?.type === "agentMessage" && typeof item.text === "string")
						final = item.text;
					if (
						item?.type === "webSearch" &&
						threadId &&
						params.threadId === threadId &&
						turnId &&
						params.turnId === turnId
					)
						searched = true;
				} else if (method === "thread/tokenUsage/updated") {
					if (
						!threadId ||
						params.threadId !== threadId ||
						!turnId ||
						params.turnId !== turnId
					)
						return;
					const next = codexUsage(params.tokenUsage, usageModel);
					if (
						next &&
						(!usage ||
							(next.inputTokens! >= usage.inputTokens! &&
								next.outputTokens! >= usage.outputTokens!))
					) {
						usage = next;
						turn.onUsage?.(next);
					}
				} else if (method === "model/rerouted") {
					if (
						!threadId ||
						params.threadId !== threadId ||
						!turnId ||
						params.turnId !== turnId
					)
						return;
					if (turn.images?.length) {
						finish(new Error("image_model_changed"));
						return;
					}
					// Cumulative totals cannot be split between the old and new models.
					usageModel = null;
					if (usage) {
						usage = { ...usage, usageModel: null };
						turn.onUsage?.(usage);
					}
				} else if (method === "turn/completed") {
					const t = params.turn as { id?: string; status?: string };
					if (turnId && t?.id !== turnId) return;
					if (t?.status === "completed" && turn.nativeWebSearch && !searched)
						finish(fail("web_search_missing"));
					else if (t?.status === "completed")
						finish(null, {
							text: final,
							inputTokens: usage?.inputTokens ?? null,
							outputTokens: usage?.outputTokens ?? null,
							cacheReadTokens: usage?.cacheReadTokens ?? null,
							cacheCreationTokens: usage?.cacheCreationTokens ?? null,
							reasoningTokens: usage?.reasoningTokens ?? null,
							usageModel,
						});
					else finish(fail("codex_turn_failed"));
				}
			});
			if (turn.images?.length) {
				const model = (await readCodexModels(request)).find(
					(m) => m.id === turn.model,
				);
				if (!model?.inputModalities)
					throw new Error("image_capability_unknown");
				if (!model.inputModalities.includes("image"))
					throw new Error("image_not_supported");
			}
			// Empty TOML tables merge with user config; they do not remove inherited MCPs.
			// Read names only and disable each for this thread, without copying credentials.
			const loaded = (await request("config/read", {
				includeLayers: false,
				cwd: turn.cwd,
			})) as { config?: { mcp_servers?: unknown } };
			if (
				!loaded?.config ||
				typeof loaded.config !== "object" ||
				Array.isArray(loaded.config)
			)
				throw fail("codex_config_invalid");
			const servers = loaded.config.mcp_servers ?? {};
			if (typeof servers !== "object" || Array.isArray(servers))
				throw fail("codex_config_invalid");
			const started = (await request("thread/start", {
				model: turn.model,
				cwd: turn.cwd,
				approvalPolicy: "never",
				sandbox: "read-only",
				baseInstructions: turn.instructions,
				ephemeral: true,
				config: {
					features: disabledFeatures,
					mcp_servers: Object.fromEntries(
						Object.keys(servers).map((name) => [name, { enabled: false }]),
					),
				},
			})) as { thread?: { id?: string } };
			threadId = started?.thread?.id;
			if (!threadId) throw fail("codex_turn_failed");
			const params = {
				threadId,
				input: [
					{ type: "text", text: turn.prompt, text_elements: [] },
					...(turn.images ?? []).map((image) => ({
						type: "image",
						url: imageDataUrl(image),
					})),
				],
				...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
				...(turn.reasoningEffort ? { effort: turn.reasoningEffort } : {}),
			};
			if (turn.images?.length)
				checkImageRequest({
					model: turn.model,
					instructions: turn.instructions,
					...params,
				});
			await request("turn/start", params, (result) => {
				turnId = (result as { turn?: { id?: string } })?.turn?.id;
			});
			return await done.promise;
		},
		turn.nativeWebSearch,
	);
}
