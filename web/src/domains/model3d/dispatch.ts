import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui/contracts";
import { ApiError } from "../../../../client/transport";
import type { Model3dApi } from "./api";
import {
	parseTags,
	type Model3dAsset,
	type Model3dGenerateBody,
	type Model3dGeneration,
	type Model3dQuery,
} from "./contracts";

/** What the event handlers may do to the screen; the hook supplies the real effects. */
export type Model3dDeps = {
	api: Model3dApi;
	available: boolean;
	unavailableReason: string | null;
	generations: readonly Model3dGeneration[];
	hasMore: boolean;
	/** The submission whose request id is kept so a retry of the same form reuses it. */
	submission: { current: { signature: string; requestId: string } | null };
	fetchMore: () => void;
	setQuery: (update: (previous: Model3dQuery) => Model3dQuery) => void;
	setSelected: (id: string | undefined) => void;
	setHighlighted: (id: string | undefined) => void;
	selectedId: string | undefined;
	refreshAll: () => Promise<void>;
	refreshGenerations: () => Promise<void>;
	refreshAssets: () => Promise<void>;
	assetChanged: (asset: Model3dAsset) => void;
	assetRemoved: (id: string) => void;
};

const accepted = (message = ""): Receipt => ({ status: "accepted", message });
const rejected = (message: string): Receipt => ({
	status: "rejected",
	message,
});
const text = (value: unknown) => (typeof value === "string" ? value : "");
const sorts = ["createdAt", "relevance"] as const;
const orders = ["asc", "desc"] as const;

const generateFailed =
	"受付を確認できませんでした。同じ内容でもう一度送っても重複しません。";

function generateBody(
	values: ArtifactEvent["values"],
	requestId: string,
): Model3dGenerateBody | string {
	const title = text(values.title).trim();
	const prompt = text(values.prompt).trim();
	const imageId = text(values.imageId);
	if (!title) return "タイトルを入力してください。";
	if (!prompt === !imageId)
		return "文章か元の画像のどちらか一方を指定してください。";
	return {
		requestId,
		title,
		tags: parseTags(text(values.tags)),
		source: prompt
			? { type: "prompt", prompt }
			: { type: "image-artifact", id: imageId },
	};
}

async function generate(deps: Model3dDeps, event: ArtifactEvent) {
	if (!deps.available)
		return rejected(
			deps.unavailableReason ?? "3Dモデルの生成は現在利用できません。",
		);
	const signature = JSON.stringify([
		event.values.title,
		event.values.tags,
		event.values.prompt,
		event.values.imageId,
	]);
	const kept = deps.submission.current;
	const requestId =
		kept?.signature === signature ? kept.requestId : crypto.randomUUID();
	const body = generateBody(event.values, requestId);
	if (typeof body === "string") return rejected(body);
	deps.submission.current = { signature, requestId };
	try {
		const created = await deps.api.createGeneration(body);
		deps.submission.current = null;
		deps.setHighlighted(created.id);
		await deps.refreshGenerations();
		return accepted("生成を受け付けました。");
	} catch (cause) {
		if (
			cause instanceof ApiError &&
			cause.status < 500 &&
			cause.status !== 408
		) {
			// The backend refused this body for good: a new submission needs a new id.
			deps.submission.current = null;
			return rejected(
				cause.message === "request_conflict"
					? "同じ送信が別の内容で受け付け済みです。もう一度送ってください。"
					: "生成を受け付けられませんでした。内容を確認してください。",
			);
		}
		return rejected(generateFailed);
	}
}

async function operate(
	deps: Model3dDeps,
	run: (api: Model3dApi) => Promise<unknown>,
	done: string,
	failed: string,
): Promise<Receipt> {
	try {
		await run(deps.api);
	} catch {
		await deps.refreshAll().catch(() => {});
		return rejected(failed);
	}
	return accepted(done);
}

function search(deps: Model3dDeps, values: ArtifactEvent["values"]): Receipt {
	const query = text(values.query).trim();
	const sort = sorts.find((s) => s === values.sort);
	const order = orders.find((o) => o === values.order);
	if (query.length > 512 || !sort || !order)
		return rejected("検索条件を確認してください。");
	// A new query object is a new cache key, so the previous cursor is never reused.
	deps.setQuery(() => ({
		q: query,
		tags: parseTags(text(values.tags)),
		sort,
		order,
	}));
	return accepted();
}

export async function handleModel3dEvent(
	deps: Model3dDeps,
	event: ArtifactEvent,
): Promise<Receipt> {
	const id = text(event.values.id);
	switch (event.action) {
		case "model3d-generate":
			return generate(deps, event);
		case "model3d-search":
			return search(deps, event.values);
		case "model3d-more":
			if (deps.hasMore) deps.fetchMore();
			return accepted();
		case "model3d-refresh":
			await deps.refreshAll();
			return accepted("更新しました。");
		case "model3d-select":
			if (!id) return rejected("3Dモデルを選び直してください。");
			deps.setSelected(id);
			return accepted();
		case "model3d-cancel":
		case "model3d-recheck": {
			if (!deps.generations.some((g) => g.id === id))
				return rejected("生成が見つかりません。");
			const cancel = event.action === "model3d-cancel";
			const receipt = await operate(
				deps,
				(api) =>
					cancel ? api.cancelGeneration(id) : api.recheckGeneration(id),
				cancel ? "取消を依頼しました。" : "状態を確認しました。",
				cancel
					? "取消を確認できませんでした。状態を再確認してください。"
					: "状態を確認できませんでした。",
			);
			await deps.refreshGenerations().catch(() => {});
			return receipt;
		}
		case "model3d-update": {
			const title = text(event.values.title).trim();
			if (!id || !title) return rejected("タイトルを入力してください。");
			return operate(
				deps,
				async (api) => {
					deps.assetChanged(
						await api.updateAsset(id, {
							title,
							tags: parseTags(text(event.values.tags)),
						}),
					);
					await deps.refreshAssets();
				},
				"変更を保存しました。",
				"保存を確認できませんでした。一覧を更新してください。",
			);
		}
		case "model3d-delete": {
			if (!id) return rejected("3Dモデルを選び直してください。");
			const receipt = await operate(
				deps,
				async (api) => {
					await api.deleteAsset(id);
					deps.assetRemoved(id);
					if (deps.selectedId === id) deps.setSelected(undefined);
				},
				"3Dモデルを削除しました。",
				"削除を確認できませんでした。一覧を更新してください。",
			);
			if (receipt.status === "accepted")
				await Promise.all([deps.refreshAssets(), deps.refreshGenerations()]);
			return receipt;
		}
		default:
			return rejected("この操作は利用できません。");
	}
}
