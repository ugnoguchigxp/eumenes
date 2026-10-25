import { useCallback, useEffect, useRef, useState } from "react";
import {
	parseResourceUri,
	type ResolveResourceResponse,
	type ResourceAction,
} from "../../../../api/domains/resources/contracts";
import type { EumenesClient } from "../../../../client";
import { resourcesApiFor } from "./api";
import { presentOnScreen, type ResourceLauncher } from "./present";

export const NOT_FOUND_NOTICE = "見つかりません。";
export const BLOCKED_NOTICE =
	"自動再生できませんでした。再生ボタンを押してください。";
const UNAVAILABLE_NOTICE = "画面を開けませんでした。";
const NOT_ALLOWED_NOTICE = "この種類ではその操作はできません。";
const FAILED_NOTICE = "開けませんでした。接続を確認してください。";
const NOTICE_MS = 6_000;

/** A short message that clears itself, shown the way the conversation shows its other notices. */
export function useResourceNotice() {
	const [notice, setNotice] = useState<string | null>(null);
	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), NOTICE_MS);
		return () => clearTimeout(timer);
	}, [notice]);
	return { notice, show: setNotice, dismiss: () => setNotice(null) };
}

type OpenResourceResult =
	| "done"
	| "blocked"
	| "unavailable"
	| "not_found"
	| "not_allowed"
	| "failed";

/**
 * `openResource(uri, action?)`: resolves the URI, opens the screen of the resource and points at it;
 * `play` also starts it. A refusal is shown through `notify`.
 */
export function useResourceOpener({
	client,
	launcher,
	notify,
}: {
	client: EumenesClient;
	launcher: ResourceLauncher;
	notify: (message: string) => void;
}) {
	const latest = useRef({ launcher, notify });
	useEffect(() => {
		latest.current = { launcher, notify };
	});
	return useCallback(
		async (
			uri: string,
			action?: ResourceAction,
		): Promise<OpenResourceResult> => {
			const { launcher, notify } = latest.current;
			const parsed = parseResourceUri(uri);
			if (!parsed) {
				notify(NOT_FOUND_NOTICE);
				return "not_found";
			}
			let resolved: ResolveResourceResponse;
			try {
				resolved = await resourcesApiFor(client).resolve(parsed.uri);
			} catch {
				notify(FAILED_NOTICE);
				return "failed";
			}
			if (!resolved.ok) {
				notify(NOT_FOUND_NOTICE);
				return "not_found";
			}
			const { resource } = resolved;
			// `read` is for the conversation agent; on screen it is the same as opening.
			const wanted = action ?? parsed.action ?? resource.defaultAction;
			const screenAction = wanted === "play" ? "play" : "open";
			if (screenAction === "play" && !resource.actions.includes("play")) {
				notify(NOT_ALLOWED_NOTICE);
				return "not_allowed";
			}
			const outcome = await presentOnScreen(launcher, {
				adapterRef: resource.adapterRef,
				targetRef: resource.targetRef,
				action: screenAction,
			});
			if (outcome === "blocked") notify(BLOCKED_NOTICE);
			else if (outcome === "unavailable") notify(UNAVAILABLE_NOTICE);
			return outcome;
		},
		[client],
	);
}
