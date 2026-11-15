import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeEngineInput, runClaudeExecution } from "./claude-engine";
import {
	claudeRequest,
	type ClaudeObservation,
	type ClaudeRequest,
	type ClaudeStart,
} from "./claude-contracts";
import {
	atomicWrite,
	canonical,
	digest,
	lock,
	optionalJson,
	privateDirectory,
} from "./storage";

type Receipt = {
	spec: Pick<ClaudeStart, "id" | "workId" | "readOnly" | "generation">;
	digest: string;
	observation: ClaudeObservation;
	sessionId?: string;
	answers?: Record<string, { digest: string; applied: boolean }>;
};
type Active = {
	receipt: Receipt;
	controller: AbortController;
	answer?: { id: string; send(value: string | null): void };
	done: Promise<void>;
};
type Prepare = (
	spec: ClaudeStart,
	sessionId?: string,
) => Omit<ClaudeEngineInput, "onSession" | "onEvidence" | "ask">;
type Engine = typeof runClaudeExecution;
const readTools = new Set(["Read", "Glob", "Grep"]);
const workTools = new Set([...readTools, "Write", "Edit", "Bash"]);

function effectiveInput(
	input: ReturnType<Prepare>,
	spec: ClaudeStart,
	sessionId?: string,
): ReturnType<Prepare> {
	const permitted = spec.readOnly ? readTools : workTools;
	if (input.tools.some((tool) => !permitted.has(tool)))
		throw new Error("claude_tools_out_of_scope");
	if (
		input.tools.includes("Bash") &&
		(!input.sandbox?.enabled ||
			!input.sandbox.failIfUnavailable ||
			input.sandbox.allowUnsandboxedCommands !== false)
	)
		throw new Error("claude_shell_isolation_required");
	return {
		...input,
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
	private closed = false;
	private quarantined = false;

	constructor(
		root: string,
		workspace: string,
		private readonly prepare: Prepare,
		private readonly engine: Engine,
	) {
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
						managedExecutionStopped: false,
					});
				}
				if (saved.observation.state === "unknown") this.quarantined = true;
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
					ready: !this.closed && !this.quarantined,
					workspace: this.workspace,
				};
			case "inspect":
				return this.read(input.id)?.observation ?? null;
			case "start":
				return this.start(input.spec);
			case "events":
				return this.events(input.id, input.after);
			case "stop": {
				const saved = this.read(input.id);
				// The host may cancel while the start message is still in transit.
				if (!saved) {
					atomicWrite(join(this.root, `stopped-${input.id}.json`), {
						stopped: true,
					});
					return stopped(input.id);
				}
				this.active.get(input.id)?.controller.abort();
				return structuredClone(saved.observation);
			}
			case "reply":
				return this.reply(input);
		}
	}

	private start(spec: ClaudeStart): ClaudeObservation {
		const fingerprint = digest(canonical(spec));
		const existing = this.read(spec.id);
		if (existing) {
			if (existing.digest !== fingerprint)
				throw new Error("claude_operation_conflict");
			return existing.observation;
		}
		if (optionalJson(join(this.root, `stopped-${spec.id}.json`)))
			return stopped(spec.id);
		if (this.closed || this.quarantined || this.active.size)
			throw new Error("claude_runner_unavailable");
		if (spec.deadline <= Date.now()) return stopped(spec.id);
		const prior = spec.priorExecutionId
			? this.read(spec.priorExecutionId)
			: null;
		if (
			spec.priorExecutionId &&
			(!prior ||
				prior.spec.workId !== spec.workId ||
				prior.spec.readOnly !== spec.readOnly ||
				prior.spec.generation > spec.generation ||
				!prior.observation.managedExecutionStopped ||
				!prior.sessionId)
		)
			throw new Error("claude_session_mismatch");
		const input = effectiveInput(
			this.prepare(spec, prior?.sessionId),
			spec,
			prior?.sessionId,
		);
		if (realpathSync(input.cwd) !== this.workspace)
			throw new Error("claude_workspace_mismatch");
		const saved: Receipt = {
			spec: {
				id: spec.id,
				workId: spec.workId,
				readOnly: spec.readOnly,
				generation: spec.generation,
			},
			digest: fingerprint,
			observation: {
				executionId: spec.id,
				seq: 0,
				state: "running",
				managedExecutionStopped: false,
			},
		};
		privateDirectory(join(this.root, spec.id));
		this.save(saved);
		const active: Active = {
			receipt: saved,
			controller: new AbortController(),
			done: Promise.resolve(),
		};
		this.active.set(spec.id, active);
		active.done = this.run(saved, input, active).finally(() =>
			this.active.delete(spec.id),
		);
		return structuredClone(saved.observation);
	}

	private async run(
		saved: Receipt,
		input: ReturnType<Prepare>,
		active: Active,
	) {
		try {
			const result = await this.engine(
				{
					...input,
					onSession: (sessionId) => {
						saved.sessionId = sessionId;
						this.update(saved, { canResume: true });
					},
					onEvidence: (seq, text) =>
						this.recordEvidence(saved, Number(seq), text),
					ask: (question, signal) => {
						if (active.answer || signal.aborted) return Promise.resolve(null);
						this.update(saved, {
							state: "waiting",
							question: {
								...question,
								inputSchema: { type: "string", maxLength: 2_000 },
							},
						});
						const pending = Promise.withResolvers<string | null>();
						const timer = setTimeout(
							() => pending.resolve(null),
							Math.max(0, question.expiresAt - Date.now()),
						);
						const abort = () => pending.resolve(null);
						signal.addEventListener("abort", abort, { once: true });
						active.answer = { id: question.id, send: pending.resolve };
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
			if (!stopped) this.quarantined = true;
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
				summary: result.result?.text,
				turns: result.result?.turns,
			});
		} catch {
			this.quarantined = true;
			this.update(saved, {
				state: "unknown",
				question: undefined,
				managedExecutionStopped: false,
			});
		}
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
		this.update(saved, { state: "running", question: undefined });
		return structuredClone(saved.observation);
	}

	private recordEvidence(saved: Receipt, seq: number, text: string) {
		if (!Number.isSafeInteger(seq) || seq < 1 || seq > 1_000_000)
			throw new Error("claude_event_invalid");
		atomicWrite(join(this.root, saved.spec.id, `event-${seq}.json`), {
			seq,
			text,
		});
		this.update(saved, {
			evidence: [
				...(saved.observation.evidence ?? []).slice(-11),
				{ ref: `${saved.spec.id}:${seq}`, text: text.slice(0, 1_024) },
			],
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

	async close() {
		this.closed = true;
		const active = [...this.active.values()];
		for (const task of active) task.controller.abort();
		try {
			await Promise.allSettled(active.map(({ done }) => done));
		} finally {
			this.unlock();
		}
	}
}

function stopped(id: string): ClaudeObservation {
	return {
		executionId: id,
		seq: 0,
		state: "stopped",
		managedExecutionStopped: true,
	};
}
