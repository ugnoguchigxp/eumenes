import type { EumenesClient } from "../client";
import { publicSubmitSchema } from "../api/domains/dialogue/contracts";
import type { Message } from "../api/domains/conversation/contracts";
import { cliFailure, CliInputError } from "./failure";

type ChatClient = Pick<
	EumenesClient,
	"conversation" | "runs" | "submit" | "watchRun" | "subscribeChanges"
>;
export type ChatMessage = Message & { kind?: "announcement" };

/** A view of the server's conversation; no conversation or execution state is persisted locally. */
export function createChatSession(input: {
	client: ChatClient;
	conversationId: string;
	signal: AbortSignal;
	message(message: ChatMessage, updated: boolean): void;
	error(text: string): void;
}) {
	const { client, conversationId, signal } = input;
	const seen = new Map<string, string>();
	let pending: Promise<void> | undefined;
	let dirty = false;
	let unsubscribe: (() => void) | undefined;
	function refresh(): Promise<void> {
		dirty = true;
		if (pending) return pending;
		pending = Promise.resolve().then(async () => {
			try {
				while (dirty && !signal.aborted) {
					dirty = false;
					const [conversation, runs] = await Promise.all([
						client.conversation(conversationId, signal),
						client.runs(conversationId, signal),
					]);
					if (signal.aborted) return;
					const answering = new Map(
						runs.map((run) => [run.inputMessageId, run]),
					);
					const visible: ChatMessage[] = [];
					for (const message of conversation.messages) {
						if (message.presentation === "artifact") continue;
						visible.push(message);
						const run = answering.get(message.id);
						if (run?.announcement)
							visible.push({
								id: `announcement:${run.id}`,
								conversationId,
								role: "assistant",
								text: run.announcement,
								createdAt: run.createdAt,
								runId: run.id,
								kind: "announcement",
							});
					}
					for (const message of visible) {
						const signature = JSON.stringify(message);
						const previous = seen.get(message.id);
						if (previous !== signature) {
							input.message(message, previous !== undefined);
							seen.set(message.id, signature);
						}
					}
					const visibleIds = new Set(visible.map((message) => message.id));
					for (const id of seen.keys())
						if (!visibleIds.has(id)) seen.delete(id);
				}
			} finally {
				pending = undefined;
			}
		});
		return pending;
	}
	function stop() {
		unsubscribe?.();
		unsubscribe = undefined;
		signal.removeEventListener("abort", stop);
	}
	return {
		async start() {
			signal.throwIfAborted();
			signal.addEventListener("abort", stop, { once: true });
			unsubscribe = client.subscribeChanges(() => {
				void refresh().catch((error: unknown) => {
					if (!signal.aborted)
						for (const line of cliFailure(error, 3).lines) input.error(line);
				});
			});
			await refresh();
		},
		async send(text: string) {
			signal.throwIfAborted();
			const requestId = crypto.randomUUID();
			const request = publicSubmitSchema.safeParse({
				requestId,
				conversationId,
				text,
			});
			if (!request.success) throw new CliInputError(request.error.message);
			let submitted;
			try {
				submitted = await client.submit(request.data, signal);
			} catch (error) {
				input.error(
					`Request ID: ${requestId}. send --request-id で同じ要求を照会・再試行できます。`,
				);
				throw error;
			}
			try {
				await refresh();
				let status = submitted.status;
				let reason = submitted.error;
				if (status === "queued" || status === "running")
					await client.watchRun(submitted.id, signal, (progress) => {
						status = progress.status;
						reason = progress.error ?? null;
					});
				if (status !== "completed")
					input.error(
						`run ${submitted.id}: ${status}${reason ? ` (${reason})` : ""}`,
					);
				await refresh();
				return status;
			} catch (error) {
				if (!signal.aborted)
					input.error(
						`run ${submitted.id}: run コマンドで状態を確認できます。`,
					);
				throw error;
			}
		},
		stop,
	};
}
