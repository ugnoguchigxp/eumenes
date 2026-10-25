import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArtifactRenderer } from "../../packages/artifact-ui/src";
import { dotsMessagingWebAdapter } from "../../web/src/domains/dots/toolchain-adapter";
import type { AdapterHostContext } from "../../web/src/domains/toolchain-artifacts/registry";
import type { MessagingView } from "../../api/domains/dots/contracts/messaging";
import bundle from "../../api/domains/capabilities/bundles/dots-messaging.bundle.json";
import "@eumenes/design-system/styles";
const artifact = bundle.artifacts[0]! as AdapterHostContext["artifact"];
const listeners = new Set<() => void>();
const setting = {
	connectionRef: "conn",
	enabled: false,
	epoch: 0,
	revision: 0,
	verifiedAt: null as number | null,
};
const config = {
	connections: [
		{
			id: "conn",
			title: "試験の接続先",
			enabled: true,
			oauth: {
				resource: "https://receiver.example/mcp/dots/conn",
				clientId: "public-test-client",
			},
		},
	],
	events: [
		{
			connectionRef: "conn",
			subscribed: true,
			expiresAt: Date.now() + 600000,
			messaging: setting,
		},
	],
	messageConversations: [] as MessagingView["thread"][],
};
let view: MessagingView | undefined;
const submitted: Array<{ requestId: string; text: string }> = [];
const notify = () => listeners.forEach((f) => f());
const client = {
	identity: "fixture-dots",
	subscribeChanges: (f: () => void) => {
		listeners.add(f);
		return () => listeners.delete(f);
	},
	dotsConfiguration: async () => structuredClone(config),
	configureDotsMessaging: async (
		_id: string,
		revision: number,
		enabled: boolean,
	) => {
		if (revision !== setting.revision) throw new Error("conflict");
		setting.enabled = enabled;
		setting.revision++;
		setting.epoch++;
		notify();
		return { ...setting };
	},
	openDotsMessageConversation: async (input: {
		requestId: string;
		connectionRef: string;
		conversationId: string;
	}) => {
		const thread = {
			...input,
			id: crypto.randomUUID(),
			epoch: 1,
			revision: 1,
			sequence: 0,
			createdAt: Date.now(),
		};
		config.messageConversations.push(thread);
		view = {
			thread,
			setting,
			subscription: { subscribed: true, expiresAt: Date.now() + 600000 },
			items: [],
			nextCursor: null,
		};
		return structuredClone(thread);
	},
	dotsMessageConversation: async () => {
		if (!view) throw new Error("not_found");
		return structuredClone(view);
	},
	sendDotsMessage: async (
		_id: string,
		input: { requestId: string; text: string },
	) => {
		submitted.push(input);
		if (!view) throw new Error("not_found");
		view.thread.revision++;
		const item = {
			id: crypto.randomUUID(),
			commandId: crypto.randomUUID(),
			threadId: view.thread.id,
			sequence: view.items.length + 1,
			revision: 1,
			state: "pending" as const,
			expiresAt: Date.now() + 600000,
			redacted: false,
			delivery: null,
			text: input.text,
			reply: null,
		};
		view.items.push(item);
		notify();
		return structuredClone(item);
	},
	cancelDotsMessage: async (id: string) => {
		const item = view!.items.find((x) => x.id === id)!;
		item.state = "cancelled";
		item.revision++;
		view!.thread.revision++;
		notify();
		return structuredClone(item);
	},
};
let reload = () => {};
declare global {
	interface Window {
		dotsMessagingTest: {
			submitted: typeof submitted;
			notifyOnly: () => void;
			answer: () => void;
			unsubscribe: () => void;
			resubscribe: () => void;
			reload: () => void;
		};
	}
}
window.dotsMessagingTest = {
	submitted,
	notifyOnly: () => {
		view!.items.at(-1)!.delivery = { state: "delivered", httpStatus: 200 };
		notify();
	},
	answer: () => {
		const item = view!.items.at(-1)!;
		item.state = "answered";
		item.revision++;
		item.reply = {
			id: crypto.randomUUID(),
			replyText: "dots からの返答",
			summary: "これまでの要約",
			limitations: ["連携前の履歴は含みません"],
		};
		view!.thread.revision++;
		setting.verifiedAt = Date.now();
		notify();
	},
	unsubscribe: () => {
		config.events[0]!.subscribed = false;
		notify();
	},
	resubscribe: () => {
		config.events[0]!.subscribed = true;
		notify();
	},
	reload: () => reload(),
};
function Screen() {
	const [targetRef, setTargetRef] = useState<string>();
	const state = dotsMessagingWebAdapter.useArtifact({
		client: client as unknown as AdapterHostContext["client"],
		artifact,
		artifactRevisionId: "fixture",
		targetRef,
		setTargetRef,
		visible: true,
		conversationId: "fixture-chat",
		catalog: [],
		documentFields: {},
		documentFieldsReady: true,
		drafts: {},
	});
	return (
		<ArtifactRenderer
			definition={JSON.stringify(artifact.variants[0]!.definition)}
			runtime={{
				snapshot: state.snapshot,
				dispatch: (event) => {
					const binding = artifact.actionBindings.find(
						(b) => b.eventAction === event.action,
					);
					return binding
						? state.local(binding, event)
						: Promise.resolve({
								status: "rejected",
								message: "unknown_action",
							});
				},
			}}
		/>
	);
}
function Fixture() {
	const [key, setKey] = useState(0);
	useEffect(() => {
		reload = () => setKey((v) => v + 1);
		return () => {
			reload = () => {};
		};
	}, []);
	return (
		<QueryClientProvider
			client={
				new QueryClient({ defaultOptions: { queries: { retry: false } } })
			}
		>
			<div data-fixture-generation={key}>
				<Screen key={key} />
			</div>
		</QueryClientProvider>
	);
}
createRoot(document.getElementById("root")!).render(<Fixture />);
