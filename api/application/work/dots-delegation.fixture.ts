import {
	createCapabilities,
	type Definition,
} from "../../domains/capabilities";
import { offlineBundleHost } from "../toolchain/toolchain-adapters";
import { createDotsWork } from "./dots-work";
import { createDotsDelegationAdapter } from "./dots-delegation-adapter";
import { dotsFixture } from "./dots-fixture";
export async function delegationFixture(
	now: () => number = Date.now,
	legacy?: Definition,
) {
	const f = await dotsFixture(now),
		caps = createCapabilities(f.store, new Set(["dots"]), {
			bundleHost: offlineBundleHost,
		});
	if (legacy)
		await f.store.write((db) => caps.registerBuiltinInTransaction(db, legacy));
	const legacyBefore = legacy
		? f.store.readSnapshot((db) =>
				caps.getDefinitionInTransaction(db, "toolchain:dots.delegate@1"),
			)
		: null;
	await caps.seed();
	const { revision: oldProjectRevision, ...oldProject } = f.project;
	const project = await f.dots.config.configureProject({
		...oldProject,
		expectedRevision: oldProjectRevision,
		capabilityRevisionId: "package:dots.orchestrate@4",
	});
	const work = createDotsWork({
		tasks: f.tasks,
		reports: f.reports,
		conversation: f.conversation,
		capabilities: () => caps,
		now,
	});
	await f.store.write((db) =>
		work.settings.applyInTransaction(db, {
			requestId: crypto.randomUUID(),
			expectedRevision: 0,
			digest: "initial",
			settings: {
				...work.settings.inTransaction(db).settings,
				enabled: true,
				connectionRef: "dots",
				projectRef: "project",
			},
		}),
	);
	await f.conversation.append({
		id: "user-message",
		conversationId: "conversation",
		role: "user",
		text: "全ての条件を残して依頼する",
		createdAt: new Date(now()).toISOString(),
		runId: "run",
	});
	const adapter = createDotsDelegationAdapter(work, () => caps, f.dots.config);
	const origin = {
		kind: "conversation" as const,
		owner: { rootRunId: "run", taskId: "agent", cancelEpoch: 0 },
		conversationId: "conversation",
		messageId: "user-message",
		runId: "run",
	};
	const start = {
		projectRef: "project",
		projectRevision: project.revision,
		connectionRevision: 1,
		title: "委任した仕事",
		request: "元の条件を保持する",
		completionConditions: ["根拠と結果を返す"],
		operations: ["read", "create_session", "check"],
		maxSessions: 2,
		runtimeSeconds: 3600,
		startMode: "start",
		sessionRefs: [],
	};
	const invoke = (
		operationName: string,
		input: unknown,
		requestId = crypto.randomUUID(),
		from:
			| typeof origin
			| { kind: "ui"; scope: string; actionRequestId: string } = origin,
	) =>
		f.store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName,
				input,
				requestId,
				origin: from,
				issuedAt: new Date(now()).toISOString(),
			}),
		);
	return {
		...f,
		caps,
		project,
		legacyBefore,
		work,
		adapter,
		origin,
		start,
		invoke,
		async close() {
			caps.close();
			await f.close();
		},
	};
}
