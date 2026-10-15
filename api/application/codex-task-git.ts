import type { Database } from "bun:sqlite";
import type { CodexTasks } from "../domains/codex-tasks";
import type { SdkGitRemote } from "../domains/coding";
import type { KanbanGitGrant } from "../domains/kanban";
export type KanbanGitPreview = {
	sourceRunId: string;
	head: string;
	snapshotDigest: string;
	branch: string;
	targets: Array<{ id: string; label: string }>;
	files: string[];
	commitSha?: string;
	remoteSha?: string;
	commitVerified: boolean;
	pushVerified: boolean;
};
export type KanbanGitRequest = {
	cardId: string;
	expectedRevision: number;
	sourceRunId?: string;
	head?: string;
	snapshotDigest?: string;
	remoteId?: string;
};
/** Uses host observations, not the model's summary, to bind a UI confirmation to one execution. */
export function createCodexTaskGit(options: {
	tasks: CodexTasks;
	scope: string;
	remotes: Record<string, SdkGitRemote>;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	function preview(tx: Database, cardId: string): KanbanGitPreview | null {
		const previous = options.tasks.latestExecutedForCardInTransaction(
			tx,
			options.scope,
			cardId,
		);
		const receipt = previous?.receipt;
		if (
			!previous?.adopted ||
			previous.state === "unknown" ||
			!receipt?.managedExecutionStopped ||
			!receipt.gitEligible ||
			!receipt.snapshot
		)
			return null;
		const targets = Object.entries(options.remotes)
			.filter(([, r]) => r.workspaceId === previous.spec.workspaceId)
			.map(([id, r]) => ({ id, label: `${r.name} / ${r.branch} (${r.url})` }));
		if (!targets.length) return null;
		return {
			sourceRunId: previous.runId,
			head: receipt.snapshot.head,
			snapshotDigest: receipt.snapshot.digest,
			branch: options.remotes[targets[0]!.id]!.branch,
			targets,
			files: receipt.report?.files ?? [],
			commitSha: receipt.git?.commitSha,
			remoteSha: receipt.git?.remoteSha,
			commitVerified: receipt.git?.commitVerified ?? false,
			pushVerified: receipt.git?.pushVerified ?? false,
		};
	}
	return {
		gitPreviewInTransaction: preview,
		gitGrantInTransaction(
			tx: Database,
			input: KanbanGitRequest,
			mode: KanbanGitGrant["mode"],
			id: string,
		): KanbanGitGrant {
			const current = preview(tx, input.cardId);
			if (
				!current ||
				current.sourceRunId !== input.sourceRunId ||
				current.head !== input.head ||
				current.snapshotDigest !== input.snapshotDigest ||
				!current.targets.some((t) => t.id === input.remoteId) ||
				(mode === "push" &&
					(!current.commitVerified ||
						!current.commitSha ||
						current.head !== current.commitSha)) ||
				(mode !== "push" && current.commitVerified)
			)
				throw new Error("codex_git_confirmation_stale");
			return {
				grantId: id,
				mode,
				sourceRunId: current.sourceRunId,
				remoteId: input.remoteId!,
				head: current.head,
				snapshotDigest: current.snapshotDigest,
				files: current.files,
				expiresAt: new Date(now() + 10 * 60_000).toISOString(),
			};
		},
	};
}
