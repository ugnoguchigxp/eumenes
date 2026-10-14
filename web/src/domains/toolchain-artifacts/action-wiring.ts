import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactDefinitionV1 } from "../../../../api/domains/capabilities/contracts";
import type { EumenesClient } from "../../../../client";
import { createActionDispatcher, type ActionDispatcher } from "./dispatcher";
import { rejectionMessage } from "./messages";
import { createOutbox } from "./outbox";
import type { GetLatest } from "./screen-state";

/**
 * The write path of a screen: the wording for refusals, the outbox and the dispatcher that
 * sends and reconciles actions, and the notices a background settlement leaves.
 */
export function useActionWiring({
	client,
	artifact,
	artifactId,
	artifactRevisionId,
	scopeRef,
	getLatest,
}: {
	client: EumenesClient;
	artifact: ArtifactDefinitionV1;
	artifactId: string;
	artifactRevisionId: string;
	scopeRef: string;
	getLatest: GetLatest;
}) {
	const [notice, setNotice] = useState<string | null>(null);
	const [settledEpoch, setSettledEpoch] = useState(0);
	const describe = useCallback(
		(
			code: string | undefined,
			fieldErrors: ReadonlyArray<{ field: string; message: string }>,
		) =>
			rejectionMessage(code, fieldErrors, (c, f) =>
				getLatest().state.describeRejection?.(c, f),
			),
		[getLatest],
	);

	const outbox = useMemo(
		() => createOutbox(client.identity),
		[client.identity],
	);
	const dispatcherRef = useRef<ActionDispatcher | null>(null);
	useEffect(() => {
		const dispatcher = createActionDispatcher({
			client,
			outbox,
			artifactId,
			artifactRevisionId,
			scopeRef,
			onSettled(event, outcome) {
				setSettledEpoch((n) => n + 1);
				const binding = artifact.actionBindings.find(
					(a) => a.actionId === event.actionId,
				);
				if (outcome.kind === "accepted") {
					if (binding && outcome.result)
						getLatest().state.settled(
							binding,
							outcome.result,
							{ sent: performance.now(), sentAt: Date.now() },
							event.input,
						);
					setNotice("前回の操作の結果を確認し、画面に反映しました。");
				} else if (outcome.kind === "rejected") {
					getLatest().state.refresh();
					setNotice(
						`前回の操作は完了しませんでした。${describe(outcome.code, outcome.fieldErrors)}`,
					);
				}
			},
			onDiscarded() {
				setNotice(
					"以前の操作を照合できていません。画面の状態を確認してから、必要なら操作し直してください。",
				);
			},
			onUnknown() {
				setNotice("結果を確認中の操作があります。");
			},
		});
		dispatcherRef.current = dispatcher;
		void dispatcher.start();
		const retry = () => void dispatcher.reconcileAll();
		window.addEventListener("online", retry);
		window.addEventListener("focus", retry);
		return () => {
			window.removeEventListener("online", retry);
			window.removeEventListener("focus", retry);
			dispatcher.stop();
			dispatcherRef.current = null;
		};
	}, [
		client,
		outbox,
		artifactId,
		artifactRevisionId,
		scopeRef,
		artifact,
		describe,
		getLatest,
	]);
	return { describe, dispatcherRef, notice, setNotice, settledEpoch };
}
