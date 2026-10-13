import type { EumenesClient } from "../../../../client";
import { createRecordsDispatch } from "./records-dispatch";
import type { Recipe } from "./records-presentation";
import type { TableQuery } from "@eumenes/design-system";

export type RecordsSessionData = {
	revision: number;
	recipes: Recipe[];
	refresh: () => Promise<void>;
	query: (
		tableId: "ai" | "toolchains" | "procedures",
		query: TableQuery,
	) => void;
	refreshRecipes: () => Promise<void>;
};
/** Per-mounted host lifetime. Async downloads/writes keep their original generation. */
export function createRecordsSession(client: EumenesClient) {
	let controller = new AbortController();
	let current: RecordsSessionData | null = null;
	const alive = () => !controller.signal.aborted;
	const dispatch = createRecordsDispatch({
		revision: () => current?.revision ?? -1,
		recipes: () => current?.recipes ?? [],
		alive,
		refresh: async () => {
			await current!.refresh();
		},
		query: (tableId, query) => current!.query(tableId, query),
		state: async (id, active) => {
			const signal = controller.signal;
			await client.setToolchainRecipeState(
				id,
				active ? "active" : "disabled",
				signal,
			);
			if (!signal.aborted) await current!.refreshRecipes();
		},
		remove: async (id) => {
			const signal = controller.signal;
			await client.deleteToolchainRecipe(id, signal);
			if (!signal.aborted) await current!.refreshRecipes();
		},
		download: async () => {
			const signal = controller.signal;
			const [diagnostics, larm, usage] = await Promise.all([
				client.settingsDiagnostics(),
				client.larmDetails(),
				client.inferenceUsage(),
			]);
			if (signal.aborted) return;
			const blob = new Blob(
				[
					JSON.stringify(
						{ generatedAt: new Date().toISOString(), diagnostics, larm, usage },
						null,
						2,
					),
				],
				{ type: "application/json" },
			);
			const url = URL.createObjectURL(blob);
			try {
				const link = document.createElement("a");
				link.href = url;
				link.download = "eumenes-diagnostics.json";
				link.click();
			} finally {
				setTimeout(() => URL.revokeObjectURL(url), 0);
			}
		},
	});
	return {
		dispatch: async (event: Parameters<typeof dispatch>[0]) => {
			const signal = controller.signal;
			const receipt = await dispatch(event);
			return signal.aborted
				? {
						status: "rejected" as const,
						message: "画面を閉じたため結果を破棄しました",
					}
				: receipt;
		},
		bind: (data: RecordsSessionData) => {
			current = data;
		},
		mount: () => {
			controller = new AbortController();
		},
		dispose: () => {
			controller.abort();
		},
	};
}
