import type { Config } from "../../infrastructure/config";
import type { Core } from "../server-core";
import type { ConversationService } from "../../domains/conversation";
import type { ChildExecution } from "../../domains/tool-runtime";
import { createCompute } from "../../domains/compute";
import { createComputeClient } from "../../domains/larm";

export function buildCompute(
	config: Config,
	deps: {
		core: Pick<Core, "store" | "queue" | "settings">;
		conversation: ConversationService;
		validChild: (
			db: import("bun:sqlite").Database,
			child: ChildExecution,
		) => boolean;
	},
) {
	const { store, queue, settings } = deps.core;
	return createCompute({
		store,
		queue,
		port: () => {
			const baseUrl = settings.get().larm.baseUrl;
			return baseUrl && config.larmToken
				? createComputeClient({ baseUrl, token: config.larmToken })
				: null;
		},
		validInTransaction: (db, row) =>
			!row.authorization_json ||
			deps.validChild(db, JSON.parse(row.authorization_json) as ChildExecution),
		onFinished: computeAnnouncements(deps.conversation),
	});
}

export function computeAnnouncements(conversation: ConversationService) {
	return (
		db: import("bun:sqlite").Database,
		job: import("../../domains/compute").JobView,
		conversationId: string,
	) => {
		const id = `compute-notice:${job.id}:${job.state}`;
		if (conversation.messageInTransaction(db, id)) return;
		const value =
			job.state === "completed"
				? `計算結果: ${JSON.stringify(job.result?.value ?? null).slice(0, 2000)}${job.artifacts.length ? `。成果物${job.artifacts.length}件を計算画面で確認できます。` : ""}${job.artifactError ? " 成果物の取得に失敗しました。" : ""}`
				: job.state === "cancelled"
					? "計算の取消を確認しました。"
					: `計算の状態: ${job.state}（${job.error?.code ?? "unavailable"}）。計算画面で確認してください。`;
		conversation.appendInTransaction(db, {
			id,
			conversationId,
			role: "assistant",
			text: value,
			createdAt: new Date().toISOString(),
			runId: null,
		});
	};
}
