import { z } from "zod";
import type { EumenesClient } from "../../../../client";
import { createTransport, json } from "../../../../client/transport";
import {
	browserBrowseResult,
	browserHistoryList,
	browserHistoryResult,
	browserSetting,
	browserTabList,
	browserTaskList,
	type BrowserTabData,
} from "./contracts";

export type BrowserPathSetting = {
	executablePath: string;
	suggestedPath: string;
	canBrowse: boolean;
};

function browserApi(client: EumenesClient) {
	const t = createTransport(client.identity);
	return {
		tasks: async (conversationId: string, signal?: AbortSignal) =>
			browserTaskList.parse(
				await (
					await t.call(
						`/api/browser/tasks?${new URLSearchParams({ conversationId })}`,
						{ signal },
					)
				).json(),
			).tasks,
		/** Saved histories, newest use first (at most 100). */
		histories: async (signal?: AbortSignal) =>
			browserHistoryList.parse(
				await (await t.call("/api/browser/histories", { signal })).json(),
			).histories,
		history: async (historyId: string, signal?: AbortSignal) =>
			browserHistoryResult.parse(
				await (
					await t.call(
						`/api/browser/histories/${encodeURIComponent(historyId)}`,
						{ signal },
					)
				).json(),
			).history,
		bridge: async (signal?: AbortSignal) =>
			z
				.object({
					revision: z.number(),
					enabled: z.boolean(),
					configured: z.boolean(),
					available: z.boolean(),
				})
				.parse(
					await (
						await t.call("/api/settings/browser-bridge", { signal })
					).json(),
				),
		saveBridge: async (input: {
			expectedRevision: number;
			enabled: boolean;
			clear: boolean;
			token?: string;
		}) => {
			await t.call("/api/settings/browser-bridge", {
				...json(input),
				method: "PUT",
			});
		},
		/** The saved Brave executable ("" when none) and a standard install to offer meanwhile. */
		setting: async (signal?: AbortSignal): Promise<BrowserPathSetting> => {
			const setting = browserSetting.parse(
				await (await t.call("/api/browser/setting", { signal })).json(),
			);
			return {
				executablePath: setting.executablePath ?? "",
				suggestedPath: setting.suggestedPath ?? "",
				canBrowse: setting.canBrowse ?? false,
			};
		},
		saveSetting: async (executablePath: string): Promise<string> =>
			browserSetting.parse(
				await (
					await t.call("/api/browser/setting", {
						...json({ executablePath }),
						method: "PUT",
					})
				).json(),
			).executablePath ?? "",
		/** Opens the OS file dialog on the backend's computer; null when the user cancels. Nothing is saved. */
		browse: async (): Promise<string | null> =>
			browserBrowseResult.parse(
				await (
					await t.call("/api/browser/setting/browse", { method: "POST" })
				).json(),
			).path,
		/** Asks the backend to read the tabs from Brave again. */
		tabs: async (signal?: AbortSignal): Promise<BrowserTabData[]> =>
			browserTabList.parse(
				await (await t.call("/api/browser/tabs", { signal })).json(),
			).tabs,
	};
}
export type BrowserApi = ReturnType<typeof browserApi>;

const apis = new WeakMap<EumenesClient, BrowserApi>();
/** The browser endpoints for the app's client (the host proxy adds the credential). */
export function browserApiFor(client: EumenesClient): BrowserApi {
	let api = apis.get(client);
	if (!api) {
		api = browserApi(client);
		apis.set(client, api);
	}
	return api;
}
