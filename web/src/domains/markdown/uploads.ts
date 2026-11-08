import { z } from "zod";
import type { EumenesClient } from "../../../../client";
import type { AdapterState } from "../toolchain-artifacts/registry";

/** Uses the existing upload contracts: staged editor input, or an ordinary SSD scratch file. */
export function markdownUploads(
	client: Pick<
		EumenesClient,
		"uploadScratchFile" | "markdownStage" | "markdownStageManagement"
	>,
	conversationId: string | undefined,
	maxRequestBytes?: number,
): NonNullable<AdapterState["uploadFile"]> {
	return async (_source, file, context) => {
		const cache = context?.purpose === "markdown-cache";
		try {
			if (context?.purpose === "markdown-management") {
				if (
					file.size >
					Math.min(20 * 1024 * 1024, maxRequestBytes ?? 20 * 1024 * 1024)
				)
					throw new Error("too_large");
				const value = await client.markdownStageManagement(
					JSON.parse(await file.text()),
				);
				return { status: "accepted", message: "", value: value.id };
			}
			if (cache) {
				if (!conversationId || !z.uuid().safeParse(context.requestId).success)
					throw new Error("cache_unavailable");
				const saved = await client.uploadScratchFile(
					conversationId,
					context.requestId!,
					file,
				);
				return { status: "accepted", message: "", value: saved.uri };
			}
			if (
				file.size >
				Math.min(20 * 1024 * 1024, maxRequestBytes ?? 20 * 1024 * 1024)
			)
				throw new Error("too_large");
			const value = await client.markdownStage(JSON.parse(await file.text()));
			return { status: "accepted", message: "", value: value.id };
		} catch {
			return {
				status: "rejected",
				message: cache
					? "cacheへ一時保存できませんでした。入力は画面に保持しています。"
					: "文書の下書きを受け付けられませんでした。内容は画面に保持しています。",
			};
		}
	};
}
