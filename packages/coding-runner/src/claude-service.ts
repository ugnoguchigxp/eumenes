import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeEngineInput, runClaudeExecution } from "./claude-engine";
import {
	claudeRequest,
	type ClaudeEvidence,
	type ClaudeObservation,
	type ClaudeRequest,
	type ClaudeStart,
} from "./claude-contracts";
import {
	supervisedTools,
	verificationUnavailable,
	workspaceInputsChanged,
} from "./claude-supervised-tools";
import {
	atomicWrite,
	canonical,
	digest,
	lock,
	optionalJson,
	privateDirectory,
} from "./storage";
import { idleRetirement } from "./claude-idle";
import { hostBoot } from "./claude-host-boot";
import { readNarration, recordNarration } from "./claude-narration";

type Receipt = {
	spec: Pick<
		ClaudeStart,
		"id" | "workId" | "readOnly" | "generation" | "supervised"
	> & { deadline?: number };
	digest: string;
	observation: ClaudeObservation;
	sessionId?: string;
	answers?: Record<string, { digest: string; applied: boolean }>;
	presentations?: Record<string, number>;
	boot?: ReturnType<typeof hostBoot>;
	recovery?: "process_exit" | "host_reboot";
	inputDigest?: string;
};
type StopTombstone = { stopped: true; supervised?: ClaudeStart["supervised"] };
type Active = {
	receipt: Receipt;
	controller: AbortController;
	answer?: {
		id: string;
		send(value: string | null): void;
		expires(at: number): void;
	};
	done: Promise<void>;
	toolApprovals: Map<string, (approved: boolean) => void>;
};
type Prepare = (
	spec: ClaudeStart,
	sessionId?: string,
) => Omit<ClaudeEngineInput, "onSession" | "onEvidence" | "ask">;
type Engine = typeof runClaudeExecution;
const readTools = new Set(["Read", "Glob", "Grep"]);
const workTools = new Set([...readTools, "Write", "Edit", "Bash"]);
const verifyTools = new Set([...readTools, "Bash"]);

// Keep the latest edit and each approved check even when many reads follow.
// The final observation is authoritative, including checks the backend missed between polls.
function observedEvidence(previous: ClaudeEvidence[], next: ClaudeEvidence) {
	const events = [...previous, next];
	const latestChecks = new Map<string, ClaudeEvidence>();
	let latestEdit: ClaudeEvidence | undefined;
	for (const event of events) {
		if (event.kind === "edit") latestEdit = event;
		if (event.kind === "check" && event.check)
			latestChecks.set(canonical(event.check), event);
	}
	const retained = new Set(latestChecks.values());
	if (latestEdit) retained.add(latestEdit);
	// The full event files remain available. Bound duplicate command arguments in the
	// observation so the receipt, including its original authorization, can be reopened.
	let recentBytes = 0;
	for (const event of events.slice(-24).reverse()) {
		if (retained.has(event)) continue;
		recentBytes += Buffer.byteLength(JSON.stringify(event));
		if (recentBytes > 256 * 1024) break;
		retained.add(event);
	}
	return events.filter((event) => retained.has(event));
}

function effectiveInput(
	input: ReturnType<Prepare>,
	spec: ClaudeStart,
	workspace: string,
	sessionId?: string,
	priorInputDigest?: string,
): ReturnType<Prepare> {
	const authority = spec.supervised?.authorization;
	const permitted =
		authority?.mode === "verify"
			? verifyTools
			: spec.readOnly
				? readTools
				: workTools;
	if (!authority && input.tools.some((tool) => !permitted.has(tool)))
		throw new Error("claude_tools_out_of_scope");
	if (
		!authority &&
		input.tools.includes("Bash") &&
		(!input.sandbox?.enabled ||
			!input.sandbox.failIfUnavailable ||
			input.sandbox.allowUnsandboxedCommands !== false)
	)
		throw new Error("claude_shell_isolation_required");
	const scope =
		spec.supervised &&
		supervisedTools(
			{ ...spec, supervised: spec.supervised },
			workspace,
			priorInputDigest,
		);
	if (authority?.checks.length && !input.tools.includes("Bash")) {
		scope?.cleanup?.();
		throw new Error(verificationUnavailable);
	}
	return {
		...input,
		...(scope
			? {
					supervisedTools: scope,
					tools: input.tools.filter(
						(tool) =>
							permitted.has(tool) &&
							(tool !== "Bash" || !!scope.commands.length),
					),
					deferredQuestions: true,
					// The hook rewrites every approved Bash call to a fail-closed OS wrapper.
					sandbox: undefined,
					projectInstructions: [
						input.projectInstructions,
						"Follow the registered tool scope below. The workspace reference names the registration. Use the physical working directory and the listed absolute paths for tool arguments.",
						"Read within a listed readable directory or open a listed file directly. When only files are listed, use their exact absolute paths instead of searching the checkout root.",
						...(authority?.worksRuntime
							? [
									"For Works, open files with Read and edit only the listed source paths. Do not install packages or use Git. After the final edit run BOTH of the exact registered verification commands below, one Bash call per command, and report their results.",
								]
							: []),
						JSON.stringify({
							workspaceRef: authority?.workspaceRef,
							workingDirectory: workspace,
							readablePaths: scope.readablePaths,
							writablePaths: scope.writablePaths,
						}),
						...scope.commands.map(
							(command) => `Approved verification Bash command: ${command}`,
						),
					].join("\n"),
				}
			: {}),
		sessionId,
		instruction: spec.instruction,
		deadline: spec.deadline,
		maxTurns: spec.maxTurns,
	};
}

export class ClaudeService {
	readonly root: string;
	readonly workspace: string;
	private readonly unlock: () => void;
	private readonly active = new Map<string, Active>();
	private readonly unknown = new Set<string>();
	private readonly confirmStopped = new Map<string, () => boolean>();
	private readonly recoveryCleanups = new Map<string, () => void>();
	private readonly boot = hostBoot();
	private readonly instance = crypto.randomUUID();
	private readonly retirement: ReturnType<typeof idleRetirement>;
	private closing?: Promise<void>;

	constructor(
		root: string,
		workspace: string,
		private readonly prepare: Prepare,
		private readonly engine: Engine,
		idle?: { ms: number; exit(): void },
	) {
		this.retirement = idleRetirement(
			idle,
			this.instance,
			() => !!(this.active.size || this.unknown.size || this.closing),
		);
		this.workspace = realpathSync(workspace);
		this.root = privateDirectory(root);
		this.unlock = lock(join(root, "claude-runner.lock"));
		try {
			for (const key of readdirSync(root)) {
				if (!/^[0-9a-f-]{36}$/i.test(key)) continue;
				const saved = this.read(key);
				if (!saved) continue;
				if (
					saved.observation.state === "running" ||
					saved.observation.state === "waiting"
				) {
					this.update(saved, {
						state: "unknown",
						question: undefined,
						toolRequests: undefined,
						managedExecutionStopped: false,
					});
				}
				if (saved.observation.state === "unknown") this.unknown.add(key);
			}
		} catch (error) {
			this.unlock();
			throw error;
		}
	}

	private read(id: string) {
		return (
			this.active.get(id)?.receipt ??
			optionalJson<Receipt>(join(this.root, id, "receipt.json"))
		);
	}

	private save(receipt: Receipt) {
		atomicWrite(join(this.root, receipt.spec.id, "receipt.json"), receipt);
	}

	private tombstone(id: string) {
		return optionalJson<StopTombstone>(join(this.root, `stopped-${id}.json`));
	}

	private update(receipt: Receipt, change: Partial<ClaudeObservation>) {
		Object.assign(receipt.observation, change);
		receipt.observation.seq++;
		this.save(receipt);
		return structuredClone(receipt.observation);
	}

	request(raw: ClaudeRequest) {
		const input = claudeRequest.parse(raw);
		switch (input.operation) {
			case "health":
				return {
					ready:
						!this.retirement.closing() && !this.closing && !this.unknown.size,
					workspace: this.workspace,
					supervised: true,
					instance: this.instance,
					retiring: this.retirement.closing(),
				};
			case "retire_idle":
				return this.retirement.request(input.instance);
			case "inspect":
				return this.read(input.id)?.observation ?? null;
			case "start":
				return this.start(input.spec);
			case "events":
				return this.events(input.id, input.after);
			case "narration":
				return readNarration(join(this.root, input.id), input.after);
			case "stop": {
				const saved = this.read(input.id);
				const tombstone = this.tombstone(input.id);
				if (
					(saved || tombstone) &&
					canonical(saved?.spec.supervised ?? tombstone?.supervised) !==
						canonical(input.supervised)
				)
					throw new Error("claude_stop_owner_mismatch");
				// The host may cancel while the start message is still in transit.
				if (!saved) {
					if (!tombstone)
						atomicWrite(join(this.root, `stopped-${input.id}.json`), {
							stopped: true,
							supervised: input.supervised,
						});
					return stopped(input.id, input.supervised);
				}
				this.active.get(input.id)?.controller.abort();
				return structuredClone(saved.observation);
			}
			case "reply":
				return this.reply(input);
			case "present":
				return this.present(input);
			case "recover":
				return this.recover(input);
			case "approve_tool":
				return this.approveTool(input);
		}
	}

	private start(spec: ClaudeStart): ClaudeObservation {
		if (this.retirement.closing() || this.closing)
			throw new Error("claude_runner_unavailable");
		const fingerprint = digest(canonical(spec));
		const existing = this.read(spec.id);
		if (existing) {
			if (existing.digest !== fingerprint)
				throw new Error("claude_operation_conflict");
			return existing.observation;
		}
		const tombstone = this.tombstone(spec.id);
		if (tombstone) {
			if (canonical(tombstone.supervised) !== canonical(spec.supervised))
				throw new Error("claude_operation_conflict");
			return stopped(spec.id, tombstone.supervised);
		}
		if (spec.deadline <= Date.now()) return stopped(spec.id);
		const delegation = spec.supervised;
		const slot = delegation?.lease.slot ?? "exclusive";
		if (delegation) {
			const expected =
				delegation.authorization.mode === "read" ? "read" : "edit";
			if (
				delegation.lease.ownerRef !== `claude-code-work:${spec.workId}` ||
				spec.readOnly !== (expected === "read") ||
				(slot !== "exclusive" && slot !== expected) ||
				spec.deadline > delegation.authorization.deadline
			)
				throw new Error("claude_delegation_invalid");
		}
		this.retirement.reset();
		const incompatible = [...this.active.values()].some(({ receipt }) => {
			const activeLease = receipt.spec.supervised?.lease;
			const activeSlot = activeLease?.slot ?? "exclusive";
			return (
				activeSlot === "exclusive" ||
				slot === "exclusive" ||
				activeSlot === slot ||
				activeLease?.ownerRef === delegation?.lease.ownerRef
			);
		});
		if (this.unknown.size || incompatible) {
			if (!delegation) throw new Error("claude_runner_unavailable");
			return {
				...stopped(spec.id),
				blocked: this.unknown.size ? "runner_quarantined" : "runner_busy",
			};
		}
		const prior = spec.priorExecutionId
			? this.read(spec.priorExecutionId)
			: null;
		if (
			spec.priorExecutionId &&
			(!prior ||
				prior.spec.workId !== spec.workId ||
				prior.spec.readOnly !== spec.readOnly ||
				prior.spec.generation > spec.generation ||
				!!prior.spec.supervised !== !!delegation ||
				(delegation &&
					(prior.spec.generation !== spec.generation ||
						canonical(prior.spec.supervised) !== canonical(delegation))) ||
				!prior.observation.managedExecutionStopped ||
				!prior.sessionId)
		)
			throw new Error("claude_session_mismatch");
		let input;
		try {
			input = effectiveInput(
				this.prepare(spec, prior?.sessionId),
				spec,
				this.workspace,
				prior?.sessionId,
				prior?.inputDigest,
			);
		} catch (error) {
			if (
				delegation &&
				error instanceof Error &&
				error.message === verificationUnavailable
			)
				return { ...stopped(spec.id), blocked: verificationUnavailable };
			if (
				delegation &&
				error instanceof Error &&
				error.message === workspaceInputsChanged
			)
				return { ...stopped(spec.id), blocked: workspaceInputsChanged };
			throw error;
		}
		if (realpathSync(input.cwd) !== this.workspace)
			throw new Error("claude_workspace_mismatch");
		const saved: Receipt = {
			spec: {
				id: spec.id,
				workId: spec.workId,
				readOnly: spec.readOnly,
				generation: spec.generation,
				deadline: spec.deadline,
				...(delegation ? { supervised: delegation } : {}),
			},
			digest: fingerprint,
			boot: this.boot,
			inputDigest: input.supervisedTools?.inputDigest(),
			observation: {
				executionId: spec.id,
				seq: 0,
				state: "running",
				managedExecutionStopped: false,
				...(delegation ? { supervised: delegation } : {}),
			},
		};
		privateDirectory(join(this.root, spec.id));
		this.save(saved);
		const active: Active = {
			receipt: saved,
			controller: new AbortController(),
			done: Promise.resolve(),
			toolApprovals: new Map(),
		};
		this.active.set(spec.id, active);
		active.done = this.run(saved, input, active).finally(() => {
			active.controller.abort();
			this.active.delete(spec.id);
			const cleanup = input.supervisedTools?.cleanup;
			if (cleanup) {
				if (saved.observation.managedExecutionStopped) cleanup();
				else this.recoveryCleanups.set(spec.id, cleanup);
			}
		});
		return structuredClone(saved.observation);
	}

	private async run(
		saved: Receipt,
		input: ReturnType<Prepare>,
		active: Active,
	) {
		let narrated = 0;
		try {
			const result = await this.engine(
				{
					...input,
					authorize: async (tool, raw) => {
						if (!saved.spec.supervised)
							return tool === "AskUserQuestion"
								? true
								: input.authorize(tool, raw);
						const allowed =
							tool === "AskUserQuestion" ||
							(await input.authorize(tool, raw)) === true;
						return allowed && (await this.requestToolApproval(active, tool));
					},
					onSession: (sessionId) => {
						saved.sessionId = sessionId;
						this.update(saved, { canResume: true });
					},
					onToolActivity: (tool) => {
						this.update(saved, { lastTool: tool.slice(0, 80) });
					},
					onEvidence: (seq, text, fact) =>
						this.recordEvidence(saved, Number(seq), text, fact),
					onNarration: (text) =>
						recordNarration(this.root, saved, ++narrated, text),
					ask: (question, signal) => {
						if (active.answer || signal.aborted) return Promise.resolve(null);
						this.update(saved, {
							state: "waiting",
							question: {
								...question,
								...(saved.spec.supervised
									? {
											presentation: "waiting" as const,
											expiresAt: input.deadline,
										}
									: {}),
								inputSchema: {
									type: "string",
									maxLength: 2_000,
									...(question.options?.length
										? {
												description: question.multiSelect
													? `選択肢（複数可）: ${question.options.join(" / ")}`
													: `選択肢: ${question.options.join(" / ")}`,
											}
										: {}),
								},
							},
						});
						const pending = Promise.withResolvers<string | null>();
						let timer: ReturnType<typeof setTimeout>;
						const expires = (at: number) => {
							clearTimeout(timer);
							timer = setTimeout(
								() => pending.resolve(null),
								Math.max(0, at - Date.now()),
							);
						};
						expires(
							saved.spec.supervised ? input.deadline : question.expiresAt,
						);
						const abort = () => pending.resolve(null);
						signal.addEventListener("abort", abort, { once: true });
						active.answer = { id: question.id, send: pending.resolve, expires };
						return pending.promise.finally(() => {
							clearTimeout(timer);
							signal.removeEventListener("abort", abort);
							active.answer = undefined;
							this.update(saved, { state: "running", question: undefined });
						});
					},
				},
				active.controller.signal,
			);
			const stopped = result.managedExecutionStopped;
			if (!stopped) {
				this.unknown.add(saved.spec.id);
				if (result.confirmStopped)
					this.confirmStopped.set(saved.spec.id, result.confirmStopped);
			}
			this.update(saved, {
				state: !stopped
					? "unknown"
					: result.aborted
						? "stopped"
						: result.result?.ok
							? "finished"
							: "failed",
				managedExecutionStopped: stopped,
				question: undefined,
				toolRequests: undefined,
				summary: result.result?.text,
				resultSubtype: result.result?.subtype,
				errorDetail: result.result?.errorDetail,
				stderrExcerpt: result.stderrExcerpt,
				turns: result.result?.turns,
				eventCount: result.evidenceCount,
			});
		} catch {
			this.unknown.add(saved.spec.id);
			this.update(saved, {
				state: "unknown",
				question: undefined,
				toolRequests: undefined,
				managedExecutionStopped: false,
			});
		}
	}

	private async requestToolApproval(active: Active, rawTool: string) {
		// effectiveInput already limits this set. Keep the runtime protocol strict for any caller.
		if (
			(!workTools.has(rawTool) && rawTool !== "AskUserQuestion") ||
			active.controller.signal.aborted ||
			active.toolApprovals.size >= 8
		)
			return false;
		const tool = rawTool as NonNullable<
			ClaudeObservation["toolRequests"]
		>[number]["tool"];
		const id = crypto.randomUUID();
		const pending = Promise.withResolvers<boolean>();
		const signal = active.controller.signal;
		const abort = () => pending.resolve(false);
		const timeout = setTimeout(
			abort,
			Math.max(0, (active.receipt.spec.deadline ?? 0) - Date.now()),
		);
		signal.addEventListener("abort", abort, { once: true });
		active.toolApprovals.set(id, pending.resolve);
		this.update(active.receipt, {
			toolRequests: [
				...(active.receipt.observation.toolRequests ?? []),
				{ id, tool },
			],
		});
		try {
			return (await pending.promise) && !signal.aborted;
		} finally {
			clearTimeout(timeout);
			signal.removeEventListener("abort", abort);
			active.toolApprovals.delete(id);
			this.update(active.receipt, {
				toolRequests: active.receipt.observation.toolRequests?.filter(
					(request) => request.id !== id,
				),
			});
		}
	}

	private approveTool(
		input: Extract<ClaudeRequest, { operation: "approve_tool" }>,
	) {
		const active = this.active.get(input.id);
		if (
			!active ||
			active.controller.signal.aborted ||
			(active.receipt.spec.deadline ?? 0) <= Date.now() ||
			canonical(active.receipt.spec.supervised?.lease) !==
				canonical(input.lease)
		)
			throw new Error("claude_tool_authorization_stale");
		active.toolApprovals.get(input.requestId)?.(true);
		return { approved: true };
	}

	private reply(input: Extract<ClaudeRequest, { operation: "reply" }>) {
		const saved = this.read(input.id);
		if (!saved) throw new Error("claude_execution_not_found");
		const answerDigest = digest(canonical([input.questionId, input.answer]));
		const prior = saved.answers?.[input.operationId];
		if (prior) {
			if (prior.digest !== answerDigest)
				throw new Error("claude_operation_conflict");
			if (!prior.applied) throw new Error("claude_answer_unconfirmed");
			return structuredClone(saved.observation);
		}
		const active = this.active.get(input.id);
		const waiter = active?.answer;
		if (
			!waiter ||
			waiter.id !== input.questionId ||
			active?.controller.signal.aborted ||
			!saved.observation.question ||
			(saved.spec.supervised &&
				saved.observation.question.presentation !== "presented") ||
			saved.observation.question.expiresAt <= Date.now()
		)
			throw new Error("claude_question_stale");
		saved.answers ??= {};
		if (Object.keys(saved.answers).length >= 32)
			throw new Error("claude_answer_limit");
		const received = { digest: answerDigest, applied: false };
		saved.answers[input.operationId] = received;
		this.save(saved);
		waiter.send(input.answer);
		// This confirms delivery to the managed callback, not that the SDK tool ran.
		received.applied = true;
		this.update(saved, {
			state: "running",
			question: undefined,
			...(saved.spec.supervised
				? {
						answerReceipt: {
							operationId: input.operationId,
							questionId: input.questionId,
						},
					}
				: {}),
		});
		return structuredClone(saved.observation);
	}

	private present(input: Extract<ClaudeRequest, { operation: "present" }>) {
		const saved = this.read(input.id);
		if (!saved?.spec.supervised) throw new Error("claude_execution_not_found");
		const previous = saved.presentations?.[input.questionId];
		if (previous !== undefined) {
			if (previous !== input.expiresAt)
				throw new Error("claude_operation_conflict");
			return structuredClone(saved.observation);
		}
		const active = this.active.get(input.id);
		const question = saved.observation.question;
		const now = Date.now();
		if (
			!active?.answer ||
			active.controller.signal.aborted ||
			active.answer.id !== input.questionId ||
			question?.id !== input.questionId ||
			question.presentation !== "waiting" ||
			input.expiresAt <= now ||
			input.expiresAt > Math.min(question.expiresAt, now + 15 * 60_000)
		)
			throw new Error("claude_question_stale");
		saved.presentations ??= {};
		saved.presentations[input.questionId] = input.expiresAt;
		const result = this.update(saved, {
			question: {
				...question,
				presentation: "presented",
				expiresAt: input.expiresAt,
			},
		});
		active.answer.expires(input.expiresAt);
		return result;
	}

	private recover(input: Extract<ClaudeRequest, { operation: "recover" }>) {
		const saved = this.read(input.id);
		if (!saved) {
			const tombstone = this.tombstone(input.id);
			if (
				tombstone?.supervised &&
				canonical(tombstone.supervised.lease) === canonical(input.lease)
			)
				return stopped(input.id, tombstone.supervised);
		}
		if (
			!saved?.spec.supervised ||
			canonical(saved.spec.supervised.lease) !== canonical(input.lease)
		)
			throw new Error("claude_recovery_mismatch");
		if (saved.recovery && saved.observation.managedExecutionStopped)
			return structuredClone(saved.observation);
		if (
			(!saved.observation.managedExecutionStopped &&
				saved.observation.state !== "unknown") ||
			this.active.has(input.id)
		)
			throw new Error("claude_recovery_mismatch");
		const boot = this.boot;
		const confirmed =
			saved.observation.managedExecutionStopped ||
			(input.proof === "process_exit"
				? this.confirmStopped.get(input.id)?.() === true
				: boot &&
					saved.boot &&
					boot.host === saved.boot.host &&
					boot.boot !== saved.boot.boot);
		if (!confirmed) throw new Error("claude_recovery_unconfirmed");
		saved.recovery = input.proof;
		const result = this.update(saved, {
			state: "stopped",
			managedExecutionStopped: true,
			canResume: false,
		});
		this.unknown.delete(input.id);
		this.confirmStopped.delete(input.id);
		this.recoveryCleanups.get(input.id)?.();
		this.recoveryCleanups.delete(input.id);
		return result;
	}

	private recordEvidence(
		saved: Receipt,
		seq: number,
		text: string,
		fact?: Omit<ClaudeEvidence, "executionId" | "ref">,
	) {
		if (!Number.isSafeInteger(seq) || seq < 1 || seq > 1_000_000)
			throw new Error("claude_event_invalid");
		const ref = `${saved.spec.id}:${seq}`;
		const structured = fact && { ...fact, ref, executionId: saved.spec.id };
		if (fact?.kind === "edit") saved.inputDigest = fact.inputDigest;
		atomicWrite(join(this.root, saved.spec.id, `event-${seq}.json`), {
			seq,
			text,
			structured,
		});
		this.update(saved, {
			eventCount: seq,
			evidence: [
				...(saved.observation.evidence ?? []).slice(-11),
				{ ref, text: text.slice(0, 1_024) },
			],
			...(structured
				? {
						structuredEvidence: observedEvidence(
							saved.observation.structuredEvidence ?? [],
							structured,
						),
					}
				: {}),
		});
	}

	private events(id: string, after: number) {
		if (!this.read(id)) return { events: [], next: after };
		const events: { seq: number; text: string }[] = [];
		let bytes = 0;
		let next = after;
		for (let seq = after + 1; seq <= after + 128; seq++) {
			const event = optionalJson<{ seq: number; text: string }>(
				join(this.root, id, `event-${seq}.json`),
			);
			if (!event) break;
			const excerpt = event.text.slice(0, 4_000);
			bytes += Buffer.byteLength(JSON.stringify(excerpt));
			if (bytes > 30_000) break;
			events.push({ seq, text: excerpt });
			next = seq;
		}
		return { events, next };
	}

	close() {
		if (this.closing) return this.closing;
		this.retirement.reset();
		const active = [...this.active.values()];
		this.closing = Promise.allSettled(active.map(({ done }) => done)).then(() =>
			this.unlock(),
		);
		for (const task of active) task.controller.abort();
		return this.closing;
	}
}

function stopped(
	id: string,
	supervised?: ClaudeStart["supervised"],
): ClaudeObservation {
	return {
		executionId: id,
		seq: 0,
		state: "stopped",
		managedExecutionStopped: true,
		...(supervised ? { supervised } : {}),
	};
}
