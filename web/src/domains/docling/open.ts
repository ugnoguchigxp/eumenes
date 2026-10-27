import type { EumenesClient } from "../../../../client";

export const doclingMessages: Record<string, string> = {
	docling_open_in_progress: "接続中です。しばらくお待ちください。",
	docling_unconfigured: "Docling Deskの接続を利用できません。",
	docling_auth_failed: "Docling Deskの認証を確認できませんでした。",
	docling_connection_changed:
		"接続設定が変わりました。もう一度開いてください。",
	docling_timeout: "接続に時間がかかっています。もう一度開いてください。",
};

/** Reserve the tab during the click, before the first await; never store the ticket URL. */
export async function openDocling(
	client: Pick<EumenesClient, "doclingTicket">,
	publicOrigin: string,
	controller: AbortController,
	open = () => window.open("about:blank", "_blank"),
) {
	const tab = open();
	if (!tab)
		return {
			status: "rejected" as const,
			message:
				"別タブを開けませんでした。ブラウザでポップアップを許可して、もう一度開いてください。",
		};
	tab.opener = null;
	const abort = () => {
		try {
			tab.close();
		} catch {
			/* already gone */
		}
	};
	controller.signal.addEventListener("abort", abort, { once: true });
	const closed = window.setInterval(() => {
		if (tab.closed) controller.abort();
	}, 250);
	const signal = AbortSignal.any([
		controller.signal,
		AbortSignal.timeout(200_000),
	]);
	try {
		const value = await client.doclingTicket(signal);
		signal.throwIfAborted();
		const url = new URL(value.url);
		if (
			url.origin !== publicOrigin ||
			url.pathname !== "/auth/exchange" ||
			url.hash ||
			tab.closed
		)
			throw new Error("docling_invalid_response");
		tab.location.replace(url.href);
		return { status: "accepted" as const, message: "別タブを開きました。" };
	} catch (error) {
		abort();
		const code = signal.aborted
			? "docling_timeout"
			: error instanceof Error
				? error.message
				: "";
		return {
			status: "rejected" as const,
			message: controller.signal.aborted
				? "画面を開く操作を取り消しました。"
				: (doclingMessages[code] ??
					"Docling Deskに接続できませんでした。接続を確認して、もう一度開いてください。"),
		};
	} finally {
		window.clearInterval(closed);
		controller.signal.removeEventListener("abort", abort);
	}
}
