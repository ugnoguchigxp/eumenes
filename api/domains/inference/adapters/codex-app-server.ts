import { createHash } from "node:crypto";
import { checkImageRequest } from "../service/cloud-images";
import { readCodexModels } from "./codex-models";
import { disabledFeatures } from "./codex-sdk";
import type { CodexThreads, ThreadMessage } from "./codex-threads";
import type { CodexRpc } from "./codex-transport";
import {
	codexTotals,
	codexUsage,
	type CodexTotals,
	type CodexUsage,
} from "./codex-usage";
import { imageDataUrl } from "../../../infrastructure/chat-image-parts";

/** The longest a cancelled turn may take to end before its thread is given up. */
const INTERRUPT_MS = 2000;

/** One conversation turn over `codex app-server` (stdio JSON-RPC), which streams
 * agent message deltas that `codex exec --json` only reports when complete. */
export type CodexTurn = {
	attemptId?: string;
	connectionId?: string;
	model: string;
	instructions: string;
	/** The call's messages past the instructions: what the thread already holds is a front of these. */
	messages: ThreadMessage[];
	/** The text and images that send the messages from `from` on (0: all of them, in the full format). */
	input(from: number): {
		prompt: string;
		images: import("../../../infrastructure/chat-image-parts").MessageImage[];
	};
	outputSchema?: unknown;
	nativeWebSearch?: true;
	reasoningEffort: "low" | "medium" | "high";
	signal: AbortSignal;
	/** Whether the turn's final text asks for something the caller will answer in a call that continues this one. */
	awaitsMore?: (text: string) => boolean;
	/** The current agent message so far (cumulative), on every delta. */
	onMessage?: (text: string) => void;
	onUsage?: (usage: CodexUsage) => void;
};
export type CodexTurnResult = CodexUsage & {
	text: string;
	inputTokens: number | null;
	outputTokens: number | null;
};

/** What makes two calls share a thread head: the model, the host's text, the output schema and the thinking level. */
function threadIdentity(turn: CodexTurn) {
	return createHash("sha256")
		.update(
			JSON.stringify([
				turn.model,
				turn.instructions,
				turn.outputSchema ?? null,
				turn.reasoningEffort,
			]),
		)
		.digest("hex");
}

export async function runCodexTurn(
	deps: { rpc: CodexRpc; threads: CodexThreads; cwd: string },
	turn: CodexTurn,
	fail: (reason: string) => Error,
): Promise<CodexTurnResult> {
	const { rpc } = deps;
	turn.signal.throwIfAborted();
	if (turn.input(0).images.length) {
		const model = (await readCodexModels((m, p) => rpc.request(m, p))).find(
			(m) => m.id === turn.model,
		);
		if (!model?.inputModalities) throw new Error("image_capability_unknown");
		if (!model.inputModalities.includes("image"))
			throw new Error("image_not_supported");
		turn.signal.throwIfAborted();
	}
	const lease = await deps.threads.acquire({
		rpc,
		identity: threadIdentity(turn),
		messages: turn.messages,
		start: {
			model: turn.model,
			cwd: deps.cwd,
			approvalPolicy: "never",
			sandbox: "read-only",
			baseInstructions: turn.instructions,
			ephemeral: false,
			config: { features: { ...disabledFeatures, shell_snapshot: false } },
		},
		attemptId: turn.attemptId,
		connectionId: turn.connectionId,
	});
	const { threadId } = lease;
	let input: ReturnType<CodexTurn["input"]>;
	try {
		// A call cancelled while its thread was being prepared starts no turn.
		turn.signal.throwIfAborted();
		input = turn.input(lease.sendFrom);
	} catch (error) {
		lease.untouched();
		throw error;
	}
	const done = Promise.withResolvers<CodexTurnResult>();
	const finish = (error: Error | null, value?: CodexTurnResult) =>
		error ? done.reject(error) : done.resolve(value!);
	done.promise.catch(() => {});
	const ended = Promise.withResolvers<void>();
	let turnId: string | undefined;
	let messageId: string | undefined;
	let message = "";
	let final = "";
	let searched = false;
	let usage: CodexUsage | null = null;
	let totals: CodexTotals | null = null;
	let usageModel: string | null = turn.model;
	lease.listen({
		fail: (error) => finish(error),
		notify(method, params) {
			if (params.turnId !== undefined && turnId && params.turnId !== turnId)
				return;
			if (
				input.images.length &&
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
				if (item?.type === "webSearch" && turnId && params.turnId === turnId)
					searched = true;
			} else if (method === "thread/tokenUsage/updated") {
				if (!turnId || params.turnId !== turnId) return;
				const next = codexUsage(params.tokenUsage, usageModel, lease.baseline);
				if (
					next &&
					(!usage ||
						(next.inputTokens! >= usage.inputTokens! &&
							next.outputTokens! >= usage.outputTokens!))
				) {
					usage = next;
					totals = codexTotals(params.tokenUsage);
					turn.onUsage?.(next);
				}
			} else if (method === "model/rerouted") {
				if (!turnId || params.turnId !== turnId) return;
				if (input.images.length) {
					finish(new Error("image_model_changed"));
					return;
				}
				// Counters of one turn cannot be split between the old and new models.
				usageModel = null;
				if (usage) {
					usage = { ...usage, usageModel: null };
					turn.onUsage?.(usage);
				}
			} else if (method === "turn/completed") {
				const t = params.turn as { id?: string; status?: string };
				if (turnId && t?.id !== turnId) return;
				ended.resolve();
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
		},
	});
	const params = {
		threadId,
		input: [
			{ type: "text", text: input.prompt, text_elements: [] },
			...input.images.map((image) => ({
				type: "image",
				url: imageDataUrl(image),
			})),
		],
		...(turn.outputSchema ? { outputSchema: turn.outputSchema } : {}),
		effort: turn.reasoningEffort,
	};
	const aborted = Promise.withResolvers<never>();
	aborted.promise.catch(() => {});
	const abort = () => aborted.reject(turn.signal.reason ?? fail("cancelled"));
	turn.signal.addEventListener("abort", abort, { once: true });
	let started: Promise<unknown> | undefined;
	try {
		if (input.images.length)
			checkImageRequest({
				model: turn.model,
				instructions: turn.instructions,
				...params,
			});
		lease.channel.beginTurn(Buffer.byteLength(JSON.stringify(params)));
		started = rpc.request("turn/start", params, (result) => {
			turnId = (result as { turn?: { id?: string } })?.turn?.id;
			if (turnId) lease.turnStarted(turnId);
		});
		started.catch(() => {});
		turn.signal.throwIfAborted();
		await Promise.race([started, done.promise, aborted.promise]);
		const result = await Promise.race([done.promise, aborted.promise]);
		lease.done(totals, turn.awaitsMore?.(result.text) ?? false);
		return result;
	} catch (error) {
		if (turn.signal.aborted && (await interrupt())) lease.interrupted();
		else void lease.discard();
		throw error;
	} finally {
		turn.signal.removeEventListener("abort", abort);
	}

	/** Asks the turn to stop and waits for its end; false when it does not end in time (or can not be asked). */
	async function interrupt() {
		const limit = new Promise<false>((resolve) =>
			setTimeout(resolve, INTERRUPT_MS, false).unref?.(),
		);
		const stop = (async () => {
			if (!turnId) await started?.catch(() => {});
			if (!turnId) return false;
			await rpc.request("turn/interrupt", { threadId, turnId });
			await ended.promise;
			return true;
		})().catch(() => false);
		return Promise.race([stop, limit]);
	}
}
