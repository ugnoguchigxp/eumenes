import { join } from "node:path";
import { atomicWrite, canonical, privateDirectory } from "./storage";
import { SdkStore } from "./sdk-store";
import { nativeSdkEngine, type SdkEngine } from "./sdk-engine";
import {
	sdkCaptureSnapshot,
	sdkGitIntegrity,
	sdkRemoteSha,
	readSdkGitResult,
	sdkChangedPaths,
} from "./sdk-git-operations";
import {
	sdkSnapshotSchema,
	type SdkGitPhase,
	type SdkGitResult,
} from "./sdk-git-contracts";
import { existsSync } from "node:fs";

/** Each phase is a distinct SDK turn, with a durable intent; MCP owns the constrained Git IO. */
export function createSdkGitEngine(
	native: SdkEngine = nativeSdkEngine,
): SdkEngine {
	return async (input) => {
		const { spec, config, directory } = input;
		const cwd = config.workspaces[spec.workspaceId]!;
		if (!spec.git) {
			let gitEligible = false;
			let initialHead: string | undefined;
			try {
				const before = sdkCaptureSnapshot(cwd, spec.workspaceId);
				initialHead = before.head;
				const previous = spec.continuationOf
					? new SdkStore(config.root).read(spec.continuationOf)
					: null;
				gitEligible =
					sdkChangedPaths(cwd).length === 0 ||
					(!!previous?.gitEligible &&
						canonical(previous.snapshot) === canonical(before));
			} catch {}
			const result = await native(input);
			if (result.managedExecutionStopped && result.report?.outcome === "done") {
				try {
					result.snapshot = sdkSnapshotSchema.parse(
						sdkCaptureSnapshot(cwd, spec.workspaceId),
					);
					result.gitEligible =
						gitEligible && result.snapshot.head === initialHead;
				} catch {
					result.report.unconfirmed.push(
						"Git用の内容照合記録は取得できませんでした。",
					);
				}
			}
			return result;
		}
		let proof: SdkGitResult | undefined;
		let lastStopped = true;
		let threadId = spec.threadId;
		try {
			if (!spec.continuationOf || !threadId)
				throw new Error("sdk_git_prior_execution_required");
			const previous = new SdkStore(config.root).read(spec.continuationOf);
			const remote = config.remotes?.[spec.git.remoteId];
			if (
				!previous?.managedExecutionStopped ||
				previous.ownerId !== spec.ownerId ||
				!previous.gitEligible ||
				!previous.snapshot ||
				!remote ||
				remote.workspaceId !== spec.workspaceId
			)
				throw new Error("sdk_git_evidence_missing");
			if (Date.parse(spec.git.expiresAt) <= Date.now())
				throw new Error("sdk_git_grant_expired");
			if (
				canonical(sdkCaptureSnapshot(cwd, spec.workspaceId)) !==
				canonical(previous.snapshot)
			)
				throw new Error("sdk_git_snapshot_changed");
			const expectedRemoteSha = sdkRemoteSha(cwd, remote);
			const integrity = sdkGitIntegrity(cwd);
			if (spec.git.mode === "push") {
				if (
					!previous.git?.commitVerified ||
					!previous.git.commitSha ||
					previous.git.remoteId !== spec.git.remoteId
				)
					throw new Error("sdk_git_commit_unconfirmed");
				proof = {
					...previous.git,
					groupId: spec.executionId,
					pushVerified: false,
					remoteSha: undefined,
					unknown: false,
				};
				atomicWrite(join(directory, "git-result.json"), proof);
			}
			const phases =
				spec.git.mode === "push"
					? ["push" as const]
					: spec.git.mode === "commit"
						? ["commit" as const]
						: ["commit" as const, "push" as const];
			for (const phase of phases) {
				if (input.signal.aborted) break;
				if (Date.parse(spec.git.expiresAt) <= Date.now())
					throw new Error("sdk_git_grant_expired");
				const grant: SdkGitPhase = {
					groupId: spec.executionId,
					grantId: spec.git.grantId,
					remoteId: spec.git.remoteId,
					workspaceId: spec.workspaceId,
					cwd,
					directory,
					phase,
					expiresAt: spec.git.expiresAt,
					snapshot: sdkCaptureSnapshot(cwd, spec.workspaceId),
					files: spec.git.files,
					remote,
					integrity,
					expectedRemoteSha,
					commitSha: proof?.commitSha,
				};
				const phaseDirectory = privateDirectory(
					join(directory, "phases", phase),
				);
				atomicWrite(join(phaseDirectory, "grant.json"), grant);
				atomicWrite(join(phaseDirectory, "turn-intent.json"), {
					executionId: spec.executionId,
					phase,
					threadId,
				});
				lastStopped = false;
				const result = await native({
					...input,
					directory: phaseDirectory,
					gitPhaseFile: join(phaseDirectory, "grant.json"),
					spec: {
						...spec,
						threadId,
						prompt: `${spec.prompt}\n\nホストで確定した今回の工程: ${phase}。作業ファイルを変更しない。${phase === "commit" ? "approved_commit ツールで確認された内容だけをcommitする。pushは行わない。" : "approved_push ツールで検証済みSHAだけを送る。新しいcommitは作らない。"} ツールの実行結果を確認して最終schemaで報告する。`,
					},
					onThread: (id) => {
						threadId = id;
						input.onThread(id);
					},
				});
				lastStopped = result.managedExecutionStopped;
				proof = readSdkGitResult(directory) ?? proof;
				if (proof) input.onGit?.(proof);
				const verified =
					phase === "commit" ? proof?.commitVerified : proof?.pushVerified;
				if (
					!lastStopped ||
					result.failure ||
					result.report?.outcome !== "done" ||
					input.signal.aborted ||
					!verified
				) {
					const unknown =
						existsSync(join(directory, `git-${phase}-intent.json`)) &&
						!verified;
					if (proof)
						proof = {
							...proof,
							unknown,
							reason: unknown
								? "sdk_git_effect_unknown"
								: (result.failure ?? "sdk_git_step_incomplete"),
						};
					return {
						...result,
						git: proof,
						gitEligible: true,
						snapshot:
							lastStopped && !unknown
								? sdkCaptureSnapshot(cwd, spec.workspaceId)
								: undefined,
						failure: unknown
							? "sdk_git_effect_unknown"
							: (result.failure ?? "sdk_git_step_incomplete"),
					};
				}
				input.onActivity({ type: `git.${phase}.verified` });
			}
			const done =
				spec.git.mode === "commit"
					? proof?.commitVerified
					: proof?.pushVerified;
			return {
				managedExecutionStopped: lastStopped,
				git: proof,
				gitEligible: true,
				snapshot: sdkCaptureSnapshot(cwd, spec.workspaceId),
				report: {
					outcome: done ? "done" : "blocked",
					summary: proof?.pushVerified
						? `commit ${proof.commitSha} と送信先のSHAを確認しました。`
						: `commit ${proof?.commitSha ?? "未確認"}。pushは完了していません。`,
					blocker: done ? "" : "git工程を完了できませんでした。",
					files: spec.git.files,
					verification: done
						? [
								"commitの親・tree・内容一致を確認",
								...(proof?.pushVerified ? ["送信先のSHA一致を確認"] : []),
							]
						: [],
					unconfirmed: proof?.pushVerified ? [] : ["push未確認"],
				},
			};
		} catch (error) {
			try {
				proof = readSdkGitResult(directory) ?? proof;
			} catch {}
			const unknown =
				(existsSync(join(directory, "git-commit-intent.json")) &&
					!proof?.commitVerified) ||
				(existsSync(join(directory, "git-push-intent.json")) &&
					!proof?.pushVerified);
			const reason = unknown
				? "sdk_git_effect_unknown"
				: error instanceof Error &&
					  /^(sdk_git|runner)_[a-z_]+$/.test(error.message)
					? error.message
					: "sdk_git_failed";
			if (proof) proof = { ...proof, unknown, reason };
			let snapshot;
			try {
				if (lastStopped && !unknown)
					snapshot = sdkCaptureSnapshot(cwd, spec.workspaceId);
			} catch {}
			return {
				managedExecutionStopped: lastStopped,
				git: proof,
				gitEligible: !!proof?.commitVerified,
				snapshot,
				report: {
					outcome: "blocked",
					summary: proof?.commitVerified
						? `commit ${proof.commitSha} は確認済みです。`
						: "git工程を開始または完了できませんでした。",
					blocker: reason,
					files: spec.git.files,
					verification: [],
					unconfirmed: [reason],
				},
				failure: reason,
			};
		}
	};
}
export const sdkGitEngine = createSdkGitEngine();
