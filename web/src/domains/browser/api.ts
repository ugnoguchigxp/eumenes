import type { EumenesClient } from "../../../../client";
import { createTransport, json } from "../../../../client/transport";
import {
	browserSetting,
	browserTabList,
	type BrowserTabData,
} from "./contracts";

function browserApi(client: EumenesClient) {
	const t = createTransport(client.identity);
	return {
		/** The saved Brave executable, or "" when none is saved. */
		setting: async (signal?: AbortSignal): Promise<string> =>
			browserSetting.parse(
				await (await t.call("/api/browser/setting", { signal })).json(),
			).executablePath ?? "",
		saveSetting: async (executablePath: string): Promise<string> =>
			browserSetting.parse(
				await (
					await t.call("/api/browser/setting", {
						...json({ executablePath }),
						method: "PUT",
					})
				).json(),
			).executablePath ?? "",
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
