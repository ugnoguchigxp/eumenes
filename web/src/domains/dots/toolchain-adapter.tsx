import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { WebArtifactAdapter } from "../toolchain-artifacts/registry";
import type { DotsMessagingResource } from "@eumenes/artifact-ui/contracts";
export const dotsMessagingWebAdapter: WebArtifactAdapter = {
	adapterRef: "adapter:dots-messaging@1",
	useArtifact({
		client,
		artifact,
		targetRef,
		setTargetRef,
		conversationId,
		visible,
	}) {
		const source = artifact.sourceBindings[0]!.source;
		const [selected, setSelected] = useState("");
		const [busy, setBusy] = useState(false);
		const lock = useRef(false);
		const uncertain = useRef<
			| {
					text: string;
					requestId: string;
					openRequestId: string;
					threadId?: string;
			  }
			| undefined
		>(undefined);
		const config = useQuery({
			queryKey: ["dots-messaging-config", client.identity],
			queryFn: () => client.dotsConfiguration(),
			enabled: visible,
			retry: false,
		});
		const view = useInfiniteQuery({
			queryKey: ["dots-message-conversation", client.identity, targetRef],
			initialPageParam: 0,
			queryFn: ({ pageParam }) =>
				client.dotsMessageConversation(targetRef!, pageParam),
			getNextPageParam: (last) => last.nextCursor ?? undefined,
			enabled: visible && !!targetRef,
			retry: false,
		});
		const first = view.data?.pages[0];
		const { refetch: refetchConfig } = config;
		const { refetch: refetchView } = view;
		const refresh = useCallback(async () => {
			await refetchConfig();
			if (targetRef) await refetchView();
		}, [refetchConfig, refetchView, targetRef]);
		useEffect(
			() =>
				visible
					? client.subscribeChanges(() => {
							void refresh();
						})
					: undefined,
			[client, visible, refresh],
		);
		const id = first?.thread.connectionRef ?? selected;
		useEffect(() => {
			if (!targetRef && selected) {
				const t = config.data?.messageConversations?.find(
					(t) =>
						t.connectionRef === selected &&
						t.conversationId === (conversationId ?? "main"),
				);
				if (t) setTargetRef(t.id);
			}
		}, [targetRef, selected, config.data, conversationId, setTargetRef]);
		const connection = config.data?.connections.find((c) => c.id === id),
			event = config.data?.events.find((e) => e.connectionRef === id),
			setting = event?.messaging;
		const subscribed =
			!!event?.subscribed && !!event.expiresAt && event.expiresAt > Date.now();
		const snapshot: DotsMessagingResource = {
			kind: "dots-messaging",
			revision: first?.thread.revision ?? setting?.revision ?? 0,
			connectionRef: id,
			...(connection?.oauth
				? {
						setup: {
							resourceUrl: connection.oauth.resource,
							clientId: connection.oauth.clientId,
						},
					}
				: {}),
			connections:
				config.data?.connections
					.filter((c) => c.enabled)
					.map((c) => ({ id: c.id, label: c.title })) ?? [],
			enabled: setting?.enabled ?? false,
			subscribed,
			confirmed: !!setting?.verifiedAt,
			busy,
			canSend:
				!!connection?.enabled &&
				!!setting?.enabled &&
				subscribed &&
				!view.hasNextPage,
			hasMore: view.hasNextPage,
			items: view.data?.pages.flatMap((p) => p.items) ?? [],
		};
		return {
			phase:
				config.isError || view.isError
					? {
							kind: "error",
							message:
								"dotsの状態を取得できませんでした。状態を更新してください。",
						}
					: config.data
						? { kind: "ready" }
						: { kind: "loading" },
			snapshot: { [source]: snapshot },
			targetOf: () => targetRef,
			refresh: () => {
				void refresh();
			},
			settled: () => {},
			async local(binding, event) {
				if (lock.current)
					return { status: "rejected", message: "処理中です。" };
				if (binding.eventAction === "dots-message-select") {
					if (uncertain.current)
						return {
							status: "rejected",
							message: "前の送信状態を確認してください。",
						};
					setSelected(String(event.values.connectionRef ?? ""));
					setTargetRef(undefined);
					return { status: "accepted", message: "" };
				}
				if (binding.eventAction === "dots-message-more") {
					await view.fetchNextPage();
					return { status: "accepted", message: "" };
				}
				if (binding.eventAction === "dots-message-refresh") {
					await refresh();
					return { status: "accepted", message: "状態を更新しました。" };
				}
				if (!connection || config.isError || view.isError)
					return {
						status: "rejected",
						message: "接続状態を確認してください。",
					};
				lock.current = true;
				setBusy(true);
				try {
					if (binding.eventAction === "dots-message-toggle")
						await client.configureDotsMessaging(
							id,
							setting?.revision ?? 0,
							!setting?.enabled,
						);
					else if (binding.eventAction === "dots-message-cancel")
						await client.cancelDotsMessage(String(event.values.messageId), {
							requestId: event.id,
							expectedRevision: Number(event.values.expectedRevision),
						});
					else if (binding.eventAction === "dots-message-send") {
						const text = String(event.values.text ?? "");
						if (uncertain.current && uncertain.current.text !== text)
							return {
								status: "rejected",
								message:
									"先ほどの送信結果が不明です。同じ本文で状態を確認してください。",
							};
						const submission = uncertain.current ?? {
							text,
							requestId: event.id,
							openRequestId: crypto.randomUUID(),
							threadId: targetRef,
						};
						uncertain.current = submission;
						if (!submission.threadId) {
							const t = await client.openDotsMessageConversation({
								requestId: submission.openRequestId,
								connectionRef: id,
								...(connection?.oauth
									? {
											setup: {
												resourceUrl: connection.oauth.resource,
												clientId: connection.oauth.clientId,
											},
										}
									: {}),
								conversationId: conversationId ?? "main",
							});
							submission.threadId = t.id;
							setTargetRef(t.id);
						}
						await client.sendDotsMessage(submission.threadId, {
							requestId: submission.requestId,
							text,
						});
						uncertain.current = undefined;
					} else
						return {
							status: "rejected",
							message: "この操作は利用できません。",
						};
					await refresh();
					return { status: "accepted", message: "" };
				} catch {
					await refresh();
					return {
						status: "rejected",
						message:
							"操作を完了できませんでした。送信結果が不明な場合は同じ本文で再確認してください。",
					};
				} finally {
					lock.current = false;
					setBusy(false);
				}
			},
		};
	},
};
