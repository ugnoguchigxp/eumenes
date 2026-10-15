import { sdkGitEngine } from "./sdk-git-engine";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	atomicWrite,
	canonical,
	digest,
	lock,
	optionalJson,
	privateDirectory,
} from "./storage";
import {
	sdkConfigSchema,
	sdkRequestSchema,
	sdkTerminal,
	type SdkConfig,
	type SdkReceipt,
	type SdkRequest,
	type SdkSpec,
} from "./sdk-contracts";
import { type SdkEngine } from "./sdk-engine";
import { SdkStore } from "./sdk-store";

export class SdkService {
	readonly epoch = randomUUID();
	readonly store: SdkStore;
	readonly config: SdkConfig;
	private readonly unlock: () => void;
	private readonly active = new Map<
		string,
		{ controller: AbortController; done: Promise<void> }
	>();
	private readonly workspaces = new Map<
		string,
		{ executionId: string; unlock: () => void }
	>();
	private closing = false;
	constructor(
		config: SdkConfig,
		private readonly engine: SdkEngine = sdkGitEngine,
	) {
		this.config = sdkConfigSchema.parse(config);
		for (const path of Object.values(config.workspaces))
			if (realpathSync(path) !== resolve(path))
				throw new Error("sdk_workspace_not_canonical");
		for (const path of config.protectedPaths)
			if (resolve(path) !== path)
				throw new Error("sdk_protected_path_not_absolute");
		this.store = new SdkStore(config.root);
		this.unlock = lock(join(config.root, "sdk-runner.lock"));
		try {
			this.restore();
		} catch (error) {
			for (const workspace of this.workspaces.values()) workspace.unlock();
			this.unlock();
			throw error;
		}
	}
	private workspaceKey(id: string) {
		const path = this.config.workspaces[id];
		if (!path) throw new Error("sdk_workspace_unregistered");
		return digest(realpathSync(path));
	}
	private restore() {
		for (const id of this.store.ids()) {
			const receipt = this.store.read(id);
			if (!receipt) continue;
			if (!sdkTerminal(receipt.state)) {
				const launched = existsSync(
					join(this.store.path(id), "start-intent.json"),
				);
				receipt.state = launched ? "unknown" : "cancelled";
				receipt.reason = launched ? "runner_interrupted" : "not_started";
				receipt.managedExecutionStopped = !launched;
				receipt.workspaceReleaseConfirmed = !launched;
				this.store.save(receipt);
			}
			if (!receipt.workspaceHeld) continue;
			if (receipt.state !== "unknown" && receipt.managedExecutionStopped) {
				receipt.workspaceHeld = false;
				this.store.save(receipt);
				continue;
			}
			const key = this.workspaceKey(receipt.workspaceId);
			if (this.workspaces.has(key)) {
				const held = this.workspaces.get(key)!;
				held.executionId = `ambiguous-${key}`;
				receipt.reason = "sdk_workspace_ownership_ambiguous";
				receipt.workspaceReleaseConfirmed = false;
				this.store.save(receipt);
				continue;
			}
			this.workspaces.set(key, {
				executionId: id,
				unlock: lock(join(this.config.root, "sdk-workspaces", `${key}.lock`)),
			});
		}
	}
	request(input: SdkRequest): unknown {
		const request = sdkRequestSchema.parse(input);
		if (request.operation === "list")
			return {
				executions: this.store
					.ids()
					.map((id) => this.store.read(id))
					.filter((receipt) => receipt !== null)
					.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
					.slice(0, 200)
					.map(
						({
							executionId,
							ownerId,
							workspaceId,
							state,
							threadId,
							updatedAt,
						}) => ({
							executionId,
							ownerId,
							workspaceId,
							state,
							threadId,
							updatedAt,
						}),
					),
			};
		if (request.operation === "start") return this.start(request.spec);
		const receipt = this.require(request.executionId);
		if (request.operation === "inspect" || request.operation === "recover")
			return structuredClone(receipt);
		if (request.operation === "events")
			return {
				receipt,
				events: this.store.events(
					receipt.executionId,
					request.after,
					request.limit,
				),
			};
		return this.control(receipt, request.operation, request.operationId);
	}
	private require(id: string) {
		const receipt = this.store.read(id);
		if (!receipt) throw new Error("sdk_execution_missing");
		return receipt;
	}
	private start(spec: SdkSpec): SdkReceipt {
		const existing = this.store.read(spec.executionId);
		if (existing) {
			if (existing.digest !== digest(canonical(spec)))
				throw new Error("sdk_idempotency_conflict");
			return existing;
		}
		if (this.closing) throw new Error("sdk_runner_closing");
		const remaining = Date.parse(spec.deadline) - Date.now();
		if (remaining <= 0 || remaining > 90 * 60_000)
			throw new Error("sdk_deadline_invalid");
		const key = this.workspaceKey(spec.workspaceId);
		const held = this.workspaces.get(key);
		let previous: SdkReceipt | undefined;
		const predecessor = spec.continuationOf ?? spec.replacementOf;
		if (predecessor) {
			previous = this.require(predecessor);
			if (
				!sdkTerminal(previous.state) ||
				previous.state === "unknown" ||
				!previous.managedExecutionStopped ||
				previous.ownerId !== spec.ownerId ||
				previous.workspaceId !== spec.workspaceId ||
				(spec.continuationOf && previous.threadId !== spec.threadId) ||
				(held && held.executionId !== previous.executionId)
			)
				throw new Error("sdk_continuation_unavailable");
		} else if (held) throw new Error("sdk_workspace_busy");
		const workspaceUnlock =
			held?.unlock ??
			lock(join(this.config.root, "sdk-workspaces", `${key}.lock`));
		let receipt: SdkReceipt;
		try {
			receipt = this.store.create(spec, this.epoch);
		} catch (error) {
			if (!held) workspaceUnlock();
			throw error;
		}
		this.workspaces.set(key, {
			executionId: spec.executionId,
			unlock: workspaceUnlock,
		});
		if (previous?.workspaceHeld) {
			previous.workspaceHeld = false;
			this.store.save(previous);
		}
		const controller = new AbortController();
		// Defer invocation until acceptance is durable and the control map exists.
		const done = Promise.resolve().then(() =>
			this.execute(spec, receipt, controller),
		);
		this.active.set(spec.executionId, { controller, done });
		return structuredClone(receipt);
	}
	private async execute(
		spec: SdkSpec,
		receipt: SdkReceipt,
		controller: AbortController,
	) {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			atomicWrite(
				join(this.store.path(spec.executionId), "start-intent.json"),
				{
					epoch: this.epoch,
					digest: receipt.digest,
					at: new Date().toISOString(),
				},
			);
			receipt.state = controller.signal.aborted ? "stopping" : "starting";
			receipt.managedExecutionStopped = false;
			receipt.workspaceReleaseConfirmed = false;
			this.store.save(receipt);
			timeout = setTimeout(
				() => controller.abort("deadline_exceeded"),
				Math.max(0, Date.parse(spec.deadline) - Date.now()),
			);
			if (controller.signal.aborted) {
				receipt.state = "cancelled";
				receipt.reason = String(controller.signal.reason ?? "not_started");
				receipt.managedExecutionStopped = true;
				receipt.workspaceReleaseConfirmed = true;
			} else {
				const result = await this.engine({
					spec,
					config: this.config,
					directory: this.store.path(spec.executionId),
					signal: controller.signal,
					onGit: (proof) => {
						receipt.git = proof;
						this.store.save(receipt);
					},
					onThread: (id) => {
						receipt.threadId = id;
						if (controller.signal.aborted) receipt.state = "stopping";
						this.store.save(receipt);
					},
					onActivity: (event) => {
						receipt.state = controller.signal.aborted
							? "stopping"
							: event.type === "turn.completed"
								? "settling"
								: "running";
						this.store.append(receipt, event);
					},
				});
				receipt.managedExecutionStopped = result.managedExecutionStopped;
				receipt.report = result.report;
				receipt.snapshot = result.snapshot;
				receipt.git = result.git;
				receipt.gitEligible = result.gitEligible;
				receipt.reason = controller.signal.aborted
					? String(controller.signal.reason ?? "sdk_aborted")
					: result.failure;
				receipt.state =
					!result.managedExecutionStopped ||
					result.failure === "sdk_git_effect_unknown"
						? "unknown"
						: controller.signal.aborted
							? "cancelled"
							: result.failure
								? "failed"
								: result.report?.outcome === "done"
									? "succeeded"
									: "blocked";
			}
			this.store.save(receipt);
			if (receipt.managedExecutionStopped && receipt.state !== "unknown")
				this.releaseManagedWorkspace(receipt);
		} catch {
			// Persistence or engine exceptions never certify that execution stopped.
			controller.abort();
			receipt.state = "unknown";
			receipt.reason = "sdk_runner_failure";
			receipt.managedExecutionStopped = false;
			try {
				this.store.save(receipt);
			} catch {
				/* Keep the durable start intent for recovery. */
			}
		} finally {
			clearTimeout(timeout);
			this.active.delete(spec.executionId);
		}
	}
	private releaseManagedWorkspace(receipt: SdkReceipt) {
		if (
			!sdkTerminal(receipt.state) ||
			receipt.state === "unknown" ||
			!receipt.managedExecutionStopped
		)
			throw new Error("sdk_release_unconfirmed");
		const key = this.workspaceKey(receipt.workspaceId);
		const held = this.workspaces.get(key);
		if (!receipt.workspaceHeld) return;
		if (held?.executionId !== receipt.executionId)
			throw new Error("sdk_workspace_owner_mismatch");
		receipt.workspaceHeld = false;
		try {
			this.store.save(receipt);
		} catch (error) {
			receipt.workspaceHeld = true;
			throw error;
		}
		held.unlock();
		this.workspaces.delete(key);
	}
	private control(
		receipt: SdkReceipt,
		operation: "stop" | "release",
		operationId: string,
	) {
		const controls = privateDirectory(
			join(this.store.path(receipt.executionId), "controls"),
		);
		const path = join(controls, `${operationId}.json`);
		const prior = optionalJson<{ operation: string }>(path);
		if (prior && prior.operation !== operation)
			throw new Error("sdk_idempotency_conflict");
		if (prior) return this.require(receipt.executionId);
		if (operation === "release") {
			this.releaseManagedWorkspace(receipt);
		} else if (!sdkTerminal(receipt.state)) {
			const active = this.active.get(receipt.executionId);
			if (!active) throw new Error("sdk_stop_unavailable");
			receipt.state = "stopping";
			this.store.save(receipt);
			active.controller.abort("stopped_by_person");
		}
		atomicWrite(path, { operation });
		return this.require(receipt.executionId);
	}
	async close() {
		this.closing = true;
		for (const { controller } of this.active.values())
			controller.abort("runner_shutdown");
		await Promise.all([...this.active.values()].map(({ done }) => done));
		for (const workspace of this.workspaces.values()) workspace.unlock();
		this.workspaces.clear();
		this.unlock();
	}
}
