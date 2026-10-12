import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ControlContract, Messages } from "../contracts";
import { controlInstructions } from "../contracts";
import { codexFailure, CodexResearchFailure } from "./codex-failure";
import { codexRuntime, lockedCodex } from "./codex-sdk";

const mission =
	"You are Eumenes’s web researcher. Investigate the current originalRequest and task.question using TOOLS. Return one JSON object with action at the root, following the output definition below. Eumenes executes the selected operation and supplies its result on your next call. The input messages contain task state, host notices and untrusted acquired materials. Do not use native Codex tools, inspect files, or delegate. TOOLS in these instructions is the complete list of host operations you can request with action invoke; Eumenes runs them, so they are available even though Codex itself has no such tools. The operations field in the input is only the history of operations already executed in this task and is empty before the first invoke; it is not the list of available operations. You never run an operation yourself: returning action invoke with a TOOLS id is how it runs. Do not finish because you cannot execute a tool in this environment; while canInvoke is true and nothing has been acquired yet, invoke a TOOLS operation.\n";

/** SDK owns the turn and structured events; Eumenes executes all operations. */
export function createCodexResearch(
	environment: Readonly<Record<string, string | undefined>>,
	executable = "codex",
) {
	const runtime = codexRuntime(environment, executable);
	if (!runtime) return undefined;
	return {
		model: "gpt-6-luna",
		async execute(
			messages: Messages,
			signal: AbortSignal,
			control?: ControlContract,
		) {
			try {
				return await this.executeOnce(messages, signal, control);
			} catch (error) {
				// An empty turn carries no decision; one fresh turn is still within the step.
				if (
					!(error instanceof Error) ||
					error.message !== "codex_research_empty_output"
				)
					throw error;
				return await this.executeOnce(messages, signal, control);
			}
		},
		async executeOnce(
			messages: Messages,
			signal: AbortSignal,
			control?: ControlContract,
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
					mission + controlInstructions(control),
				);
				const thread = sdk.startThread({
					model: "gpt-6-luna",
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
