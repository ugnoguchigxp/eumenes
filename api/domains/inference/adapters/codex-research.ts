import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContract, Messages } from "../contracts";
import { controlInstructions } from "../contracts";
import { codexFailure, CodexResearchFailure } from "./codex-failure";
import { codexRuntime, lockedCodex } from "./codex-sdk";

const mission =
	"Select the next Eumenes host action for originalRequest and task.question. TOOLS in the base instructions lists available host operations, independently of Codex native tools and sandbox/network access. Eumenes executes your chosen operation and supplies its result next time. Return one JSON action at the root: invoke with a TOOLS id and its inputSchema when information is needed and budget.canInvoke=true; finish when answered or acquisition cannot continue. operations records past attempts, not available tools. Do not call Codex native tools, inspect files or delegate.";

/**
 * SDK owns the turn and structured events; Eumenes executes all operations. The model is the
 * one of the saved Codex connection (passed per call); without one Codex uses its own default.
 */
export function createCodexResearch(
	environment: Readonly<Record<string, string | undefined>>,
	executable = "codex",
) {
	const runtime = codexRuntime(environment, executable);
	if (!runtime) return undefined;
	return {
		async execute(
			messages: Messages,
			signal: AbortSignal,
			control?: ControlContract,
			model?: string,
		) {
			try {
				return await this.executeOnce(messages, signal, control, model);
			} catch (error) {
				// An empty turn carries no decision; one fresh turn is still within the step.
				if (
					!(error instanceof Error) ||
					error.message !== "codex_research_empty_output"
				)
					throw error;
				return await this.executeOnce(messages, signal, control, model);
			}
		},
		async executeOnce(
			messages: Messages,
			signal: AbortSignal,
			control?: ControlContract,
			model?: string,
		) {
			signal.throwIfAborted();
			if (!control) throw new Error("codex_research_schema_missing");
			const cwd = await mkdtemp(join(tmpdir(), "eumenes-research-"));
			const abort = new AbortController();
			let cancel: () => void = () => {};
			let phase = "sdk_start";
			let pending: Promise<string> | undefined;
			let settled = false;
			try {
				const sdk = await lockedCodex(
					runtime,
					cwd,
					controlInstructions(control),
					undefined,
					mission,
				);
				const thread = sdk.startThread({
					...(model ? { model } : {}),
					workingDirectory: cwd,
					sandboxMode: "read-only",
					skipGitRepoCheck: true,
					approvalPolicy: "never",
					webSearchMode: "disabled",
					modelReasoningEffort: "low",
				});
				const cancelled = new Promise<never>((_, reject) => {
					cancel = () => {
						abort.abort();
						reject(signal.reason ?? new Error("cancelled"));
					};
				});
				cancelled.catch(() => {});
				signal.addEventListener("abort", cancel, { once: true });
				if (signal.aborted) cancel();
				pending = (async () => {
					const { events } = await thread.runStreamed(
						JSON.stringify({
							messages: messages.filter(
								(m) =>
									!(
										m.role === "system" &&
										m.content === controlInstructions(control)
									),
							),
						}),
						{ signal: abort.signal },
					);
					let final = "";
					let completed = 0;
					phase = "sdk_turn";
					for await (const event of events) {
						if (event.type === "error" || event.type === "turn.failed")
							throw codexFailure(
								new Error(
									event.type === "error" ? event.message : event.error.message,
								),
								"sdk_turn",
							);
						if (
							event.type === "item.completed" &&
							event.item.type === "agent_message"
						) {
							final = event.item.text;
							if (Buffer.byteLength(final) > 65536)
								throw codexFailure(
									new Error("codex_research_output_limit"),
									"sdk_output",
								);
						}
						if (event.type === "turn.completed") completed++;
					}
					phase = "sdk_output";
					if (completed !== 1)
						throw new CodexResearchFailure({
							phase,
							reason: "codex_research_incomplete_turn",
						});
					if (!final.trim())
						throw new CodexResearchFailure({
							phase,
							reason: "codex_research_empty_output",
						});
					// The shared worker parser and host guards validate the response.
					return final;
				})();
				pending.then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					},
				);
				return await Promise.race([pending, cancelled]);
			} catch (error) {
				signal.throwIfAborted();
				throw codexFailure(error, phase);
			} finally {
				signal.removeEventListener("abort", cancel);
				if (!settled) abort.abort();
				if (pending)
					await Promise.race([pending.catch(() => {}), Bun.sleep(1500)]);
				await rm(cwd, { recursive: true, force: true });
			}
		},
	};
}
