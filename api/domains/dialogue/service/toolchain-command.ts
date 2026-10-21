import { systemContext } from "../../../infrastructure/system-context";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import {
	controlInstructions,
	delegatedTaskRules,
	promptTime,
	type ControlContract,
} from "../../inference";
import { recognitionCommand } from "../../capabilities";
import type { HandlerDefinition } from "../../queue";
import { ANSWER_TEXT_SCHEMA } from "../contracts/command-interactions";
import { delegationCommand } from "../contracts/delegation";
import type { Run } from "../contracts";
import { byId, linkAnswer, transition } from "../repository";
import { endRun } from "./run-end";
import { COMMAND_KIND, GENERATE_KIND, type DialogueDeps } from "./context";
import { applyCommand } from "./command-apply";
import { commandSource } from "./command-source";
import type {
	BoundInvocation,
	CommandInput,
	CommandOutput,
} from "./command-apply";

const log = getLogger("dialogue");

/** The route of a task sub-agent's calls: the saved sub-agent resource, or LARM only. */
export const subagentRoute = (settings?: {
	subagent: { resourceId: string | null };
}) =>
	settings?.subagent.resourceId
		? { resourceId: settings.subagent.resourceId }
		: ("larm-only" as const);

/**
 * The sub-agent's whole contract: one tool of the set with flat arguments, or one question
 * back to the user. No discriminated union: the model fills one object.
 */
export function commandOutputFor(questionRefs: readonly string[]) {
	return z
		.object({
			action: z.enum(["invoke", "clarify"]),
			tool: z.string().min(1).max(64).optional(),
			arguments: z.record(z.string(), z.unknown()).optional(),
			question: z.string().trim().min(1).max(500).optional(),
			/** The registered schema the user's answer to `question` is checked against. */
			answerSchema: z
				.enum([ANSWER_TEXT_SCHEMA, ...questionRefs] as [string, ...string[]])
				.optional(),
		})
		.strict()
		.meta({
			examples: [
				{ action: "invoke", tool: "TOOLSのid", arguments: {} },
				{
					action: "clarify",
					question: "ユーザーへの確認質問",
					answerSchema: ANSWER_TEXT_SCHEMA,
				},
			],
		});
}
/** The question schemas a set may ask besides the generic text: its binding's, if any. */
const questionRefsOf = (set?: {
	questions: Array<{ inputSchemaRef: string }>;
}) => set?.questions.map((q) => q.inputSchemaRef) ?? [];
const COMMAND_RULES = systemContext(
	"dialogue.contexts.toolchain-command.command-rules",
	{},
);

/** The fixed set as the sub-agent's SystemContext, and the request as data. */
export function commandPrompt(
	set: { profile: string; skills: string[] },
	tools: Array<{ id: string; description: string; inputSchema: unknown }>,
	data: Record<string, unknown>,
	questionRefs: readonly string[],
	nowMs: number,
) {
	const control: ControlContract = {
		instructions:
			delegatedTaskRules +
			"\n" +
			set.profile +
			"\n\n" +
			set.skills.join("\n\n") +
			"\n\n" +
			COMMAND_RULES +
			"\nTOOLS=" +
			JSON.stringify(tools),
		outputSchema: z.toJSONSchema(commandOutputFor(questionRefs)),
	};
	return {
		control,
		messages: [
			{ role: "system" as const, content: controlInstructions(control) },
			{
				role: "user" as const,
				content: JSON.stringify({
					...data,
					...promptTime(nowMs),
				}),
			},
		],
	};
}

export function parseToolCommand(
	input: Pick<CommandInput, "backend" | "toolIds">,
	out: z.infer<ReturnType<typeof commandOutputFor>>,
) {
	const operation = out.tool ? input.toolIds[out.tool] : undefined;
	if (!operation) throw new Error("toolchain_command_tool_unknown");
	const raw = { ...out.arguments, operation };
	const command =
		input.backend === "object-recognition"
			? recognitionCommand.safeParse(raw)
			: delegationCommand.safeParse(raw);
	if (!command.success) {
		log.warn("dialogue.operation_rejected", {
			reason: "command_arguments_invalid",
			controlAction: input.toolIds[out.tool!] ? out.tool : "unknown",
			issueCount: command.error.issues.length,
		});
		throw new Error("toolchain_command_invalid_arguments");
	}
	return command.data;
}

/**
 * The command sub-agent of a toolchain (timers, project delegation): it loads the toolchain's
 * fixed set (profile, SKILL, tool details), turns the request into one typed operation, and the
 * host executes that operation through the existing path. The conversation never builds it.
 */
export function createToolchainCommandHandler(
	deps: DialogueDeps,
): HandlerDefinition<
	{ runId: string; toolchainRevisionId: string; interactionId?: string },
	CommandInput,
	CommandOutput
> {
	const { larm, queue, clock } = deps;
	function fail(db: Database, run: Run, code: string) {
		endRun(deps, db, run, "failed", code);
		deps.toolchains?.settleSelectionInTransaction(db, run.id, {
			outcome: "failed",
			code,
		});
		// A run that ends without the operation leaves no interaction open behind it.
		deps.interactions?.endForRunInTransaction(db, run.id, code);
	}
	return {
		kind: COMMAND_KIND,
		payloadVersions: [1],
		schema: z.object({
			runId: z.string(),
			toolchainRevisionId: z.string(),
			/** Set when the run resumes an interaction after its question was answered. */
			interactionId: z.string().optional(),
		}),
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(tx, claim) {
			const run = byId(tx, claim.payload.runId);
			if (!run || run.status !== "queued" || run.jobId !== claim.jobId)
				return { status: "stale", reason: "run_not_queued" };
			const toolchains = deps.toolchains;
			if (
				!toolchains ||
				!larm.captureControlInTransaction ||
				!larm.executeControl
			) {
				fail(tx, run, "control_unavailable");
				return { status: "stale", reason: "control_unavailable" };
			}
			let set: ReturnType<typeof toolchains.commandSetInTransaction>;
			try {
				set = toolchains.commandSetInTransaction(
					tx,
					claim.payload.toolchainRevisionId,
				);
			} catch {
				fail(tx, run, "toolchain_unavailable");
				return { status: "stale", reason: "toolchain_unavailable" };
			}
			const loaded = commandSource(deps, tx, run, set, claim.payload);
			if (!loaded.ok) {
				fail(tx, run, loaded.code);
				return { status: "stale", reason: loaded.code };
			}
			const {
				request,
				original,
				priorSteps,
				resume,
				snapshot,
				tools,
				toolIds,
			} = loaded.source;
			const deadline = Math.min(
				Date.parse(run.deadlineAt!) - 15000,
				Date.now() + 45000,
			);
			// Too little time left for one model call and the answer: end with a clear code.
			if (deadline <= Date.now() + 5000) {
				fail(tx, run, "deadline_exceeded");
				return { status: "stale", reason: "deadline_exceeded" };
			}
			if (!transition(tx, run.id, run.revision, "running", clock()))
				return { status: "stale", reason: "run_changed" };
			const prompt = commandPrompt(
				set,
				tools,
				{
					request,
					originalRequest: original,
					...(priorSteps.length ? { priorSteps } : {}),
					...(set.backend === "dots" ? { catalog: snapshot } : { snapshot }),
					...(resume?.exchanges.length
						? { previousQuestions: resume.exchanges }
						: {}),
				},
				questionRefsOf(set.binding),
				Date.parse(clock()),
			);
			const requestId = larm.captureControlInTransaction(tx, {
				subject: `toolchain:${run.id}:command`,
				policySubject: run.id,
				deadline,
				maxOutputTokens: 2048,
				// The saved sub-agent resource (read in this transaction); none keeps the command on LARM.
				route: subagentRoute(larm.snapshotInTransaction?.(tx)),
			});
			return {
				status: "ready",
				input: {
					runId: run.id,
					revision: (byId(tx, run.id) as Run).revision,
					toolchainRevisionId: claim.payload.toolchainRevisionId,
					requestId,
					backend: set.backend,
					toolIds,
					snapshot,
					request,
					...(set.binding ? { boundSet: set.binding } : {}),
					...(resume && claim.payload.interactionId
						? {
								interaction: {
									id: claim.payload.interactionId,
									generation: resume.generation,
									epoch: resume.epoch,
								},
							}
						: {}),
					...prompt,
				},
			};
		},
		async execute(input, { signal }) {
			return withLogContext({ runId: input.runId }, async () => {
				// A command is one call: its agent session ends with the call, whatever the outcome.
				const receipt = await larm.executeControl!(
					input.requestId,
					input.messages,
					signal,
					input.control,
					{ sessionRole: "subagent", taskId: input.runId },
				).finally(() =>
					larm
						.releaseTaskSession?.(input.runId)
						.catch((error) =>
							log.warn("dialogue.task_session_release_failed", {}, error),
						),
				);
				let value: unknown;
				try {
					value = parseLlmJson(receipt.value as string);
				} catch {
					throw new Error("toolchain_command_invalid_json");
				}
				const parsed = commandOutputFor(
					questionRefsOf(input.boundSet),
				).safeParse(value);
				if (!parsed.success)
					throw new Error("toolchain_command_invalid_contract");
				const out = parsed.data;
				if (out.action === "clarify") {
					if (!out.question)
						throw new Error("toolchain_command_invalid_contract");
					return {
						receipt,
						question: out.question,
						answerSchema: out.answerSchema ?? "builtin:answerText",
					};
				}
				if (input.boundSet) {
					const bound = deps.toolchains?.bound;
					if (!bound) throw new Error("adapter_unavailable");
					const checked = bound.parseInvocation(
						input.boundSet,
						out.tool ?? "",
						out.arguments ?? {},
					);
					if (!checked.ok) {
						log.warn("dialogue.operation_rejected", {
							reason: "command_arguments_invalid",
							validationCode: checked.code,
						});
						throw new Error("toolchain_command_invalid_arguments");
					}
					const invocation: BoundInvocation = {
						bindingRevisionId: input.boundSet.bindingRevisionId,
						adapterRef: input.boundSet.adapterRef,
						packageRevisionId: input.boundSet.packageRevisionId,
						toolRevisionId: checked.toolRevisionId,
						operationName: checked.operationName,
						input: checked.input,
					};
					return { receipt, command: invocation };
				}
				return { receipt, command: parseToolCommand(input, out) };
			});
		},
		classify: () => "fail",
		settleInTransaction(tx, claim, input, outcome) {
			const run = byId(tx, claim.payload.runId);
			if (!run) return "stale";
			if (
				run.status !== "running" ||
				!input ||
				run.revision !== input.revision
			) {
				if (run.status === "running" && outcome.type !== "success")
					fail(
						tx,
						run,
						"errorCode" in outcome ? outcome.errorCode : "interrupted",
					);
				return "stale";
			}
			if (outcome.type !== "success") {
				fail(
					tx,
					run,
					"errorCode" in outcome
						? outcome.errorCode
						: "toolchain_command_failed",
				);
				return "applied";
			}
			// A newer generation, a cancellation or another run holding the interaction: this
			// model result belongs to an operation that is no longer this one.
			if (
				input.interaction &&
				!deps.interactions?.guardInTransaction(
					tx,
					input.interaction.id,
					run.id,
					input.interaction,
				)
			) {
				fail(tx, run, "interaction_closed");
				return "applied";
			}
			if (!larm.acceptInTransaction?.(tx, outcome.result.receipt)) {
				fail(tx, run, "permission_revoked");
				return "applied";
			}
			const answerJob = (note?: string) => {
				const { job } = queue.enqueueInTransaction(tx, {
					scope: "dialogue",
					kind: GENERATE_KIND,
					dedupeKey: `toolchain-answer:${run.id}`,
					payload: { runId: run.id, ...(note ? { commandNote: note } : {}) },
					subjectRef: run.id,
					lane: "interactive",
					resourceKey: "inference.llm",
					maxAttempts: 1,
					concurrencyKey: `conversation:${run.conversationId}`,
					deadlineAtMs: Date.parse(run.deadlineAt!),
				});
				linkAnswer(tx, run.id, job.id);
			};
			const savepoint = "dialogue_toolchain_command";
			tx.exec(`SAVEPOINT ${savepoint}`);
			try {
				applyCommand(
					deps,
					tx,
					claim.jobId,
					run,
					input,
					outcome.result,
					answerJob,
				);
				tx.exec(`RELEASE ${savepoint}`);
			} catch (e) {
				// Nothing of a half-applied operation stays; the run ends with the reason.
				tx.exec(`ROLLBACK TO ${savepoint}`);
				tx.exec(`RELEASE ${savepoint}`);
				const code =
					e instanceof Error && /^[a-z_]+$/.test(e.message)
						? e.message
						: "toolchain_command_failed";
				fail(tx, run, code);
				return { status: "failed", errorCode: code };
			}
			transition(
				tx,
				run.id,
				(byId(tx, run.id) as Run).revision,
				"queued",
				clock(),
			);
			return "applied";
		},
		cancelInTransaction(tx, job) {
			const run = byId(tx, job.payload.runId);
			if (run && (run.status === "queued" || run.status === "running")) {
				endRun(deps, tx, run, "cancelled", "cancel_requested");
				deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
					outcome: "cancelled",
					code: "cancel_requested",
				});
				deps.interactions?.endForRunInTransaction(
					tx,
					run.id,
					"cancel_requested",
				);
			}
		},
	};
}
