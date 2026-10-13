import { z } from "zod";
import type { ArtifactEvent, Receipt } from "@eumenes/artifact-ui";
import type { Recipe } from "./records-presentation";
import type { TableQuery } from "@eumenes/design-system";
import { usagePageQuerySchema } from "../../../../client/settings";
import {
	selectionPageQuerySchema,
	recipePageQuerySchema,
} from "../../../../client/toolchain-history";

type Operations = {
	revision: () => number;
	recipes: () => Recipe[];
	alive: () => boolean;
	refresh: () => Promise<void>;
	query: (
		tableId: "ai" | "toolchains" | "procedures",
		query: TableQuery,
	) => void;
	state: (id: string, enabled: boolean) => Promise<void>;
	remove: (id: string) => Promise<void>;
	download: () => Promise<void>;
};
const empty = z.strictObject({});
const recipeId = z.string().min(1).max(160);
/** Source/choice validation and a synchronous lock fence concurrent/stale UI events. */
export function createRecordsDispatch(ops: Operations) {
	const receipts = new Set<string>();
	let busy = false;
	return async (event: ArtifactEvent): Promise<Receipt> => {
		if (!ops.alive() || event.source !== "settings-records")
			return { status: "rejected", message: "この記録は操作できません" };
		if (receipts.has(event.id))
			return { status: "duplicate", message: "この操作は受付済みです" };
		if (event.revision !== ops.revision())
			return {
				status: "conflict",
				message: "記録が更新されています。最新の表示から操作してください",
			};
		if (busy)
			return { status: "rejected", message: "前の操作の完了を待ってください" };
		let operation: () => Promise<void>;
		let message = "";
		try {
			switch (event.action) {
				case "records-refresh":
					empty.parse(event.values);
					operation = ops.refresh;
					message = "記録を更新しました";
					break;
				case "records-query": {
					const { tableId, ...raw } = event.values;
					const id = z.enum(["ai", "toolchains", "procedures"]).parse(tableId);
					const query = (
						id === "ai"
							? usagePageQuerySchema
							: id === "toolchains"
								? selectionPageQuerySchema
								: recipePageQuerySchema
					).parse(raw);
					operation = async () => {
						ops.query(id, query);
					};
					break;
				}
				case "records-procedure-state": {
					const { id, enabled } = z
						.strictObject({ id: recipeId, enabled: z.boolean() })
						.parse(event.values);
					if (!ops.recipes().some((r) => r.id === id))
						throw new Error("unknown_recipe");
					operation = () => ops.state(id, enabled);
					message = enabled
						? "取得手順を有効にしました"
						: "取得手順を無効にしました";
					break;
				}
				case "records-procedure-delete": {
					const { id } = z.strictObject({ id: recipeId }).parse(event.values);
					if (!ops.recipes().some((r) => r.id === id))
						throw new Error("unknown_recipe");
					operation = () => ops.remove(id);
					message = "取得手順を削除しました";
					break;
				}
				case "records-download":
					empty.parse(event.values);
					operation = ops.download;
					message = "診断データを保存しました";
					break;
				default:
					throw new Error("unknown_action");
			}
		} catch {
			return { status: "rejected", message: "この操作は受け付けられません" };
		}
		receipts.add(event.id);
		busy = true;
		try {
			await operation();
			return ops.alive()
				? { status: "accepted", message }
				: { status: "rejected", message: "画面を閉じたため結果を破棄しました" };
		} catch {
			return {
				status: "rejected",
				message: "操作に失敗しました。記録を更新して状態を確認してください",
			};
		} finally {
			busy = false;
		}
	};
}
