import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createGoalStore,
	goalMigrations,
	withGoalReplyTools,
	type GoalHost,
} from "eumenes-agency/agenda/runtime";
import {
	createConversationService,
	migrations as conversationMigrations,
} from "../../domains/conversation";
import {
	createGoalsService,
	migrations as goalsMigrations,
} from "../../domains/goals";
import { openStore } from "../../infrastructure/sqlite";
import { createApp } from "../app";
import { createGoalReplyWork } from "./goal-permission";
import { createGoalWorkspaceRegistry } from "./goal-workspaces";
import { registerAgency } from "./routes";

async function verifyGoalListRoute(
	store: Pick<ReturnType<typeof openStore>, "onCommit">,
	list: ReturnType<typeof createGoalReplyWork>["list"],
	expected: unknown,
) {
	const unexpected = () => {
		throw new Error("goal_list_must_only_read");
	};
	const app = createApp({
		token: "test-token",
		origin: "http://localhost",
		modules: [
			{
				mount(app) {
					registerAgency(app, {
						status: unexpected,
						attend: unexpected,
						thoughts: unexpected,
						listGoals: list,
					});
				},
			},
		],
	});
	let commits = 0;
	const unsubscribe = store.onCommit(() => commits++);
	try {
		const url = "/api/agency/goals";
		expect((await app.request(url)).status).toBe(401);
		for (let replay = 0; replay < 2; replay++) {
			const response = await app.request(url, {
				headers: { Authorization: "Bearer test-token" },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
			expect(await response.json()).toEqual(expected);
		}
		expect(commits).toBe(0);
	} finally {
		unsubscribe();
	}
}

test("one utterance registers and grants once, even on replay, and stale authority cannot execute", async () => {
	const root = mkdtempSync(join(tmpdir(), "goal-permission-"));
	const write = (name: string) =>
		writeFileSync(join(root, name), "reference\n");
	write("manual.md");
	write("program.ts");
	execFileSync("git", ["init", "-q", root]);
	execFileSync("git", ["-C", root, "add", "manual.md", "program.ts"]);
	execFileSync("git", [
		"-C",
		root,
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-qm",
		"baseline",
	]);
	const store = openStore(join(root, "temporary.sqlite"), [
		...conversationMigrations,
		...goalsMigrations,
		...goalMigrations,
	]);
	const conversation = createConversationService(store);
	const goals = createGoalStore(
		store,
		createGoalsService(() => new Date().toISOString()),
	);
	const user = {
		id: "words",
		text: "対象を登録してください。作業先で手順書だけ編集してよいです。",
	};
	const access = { principal: "owner", scopeKeys: ["work"] };
	const workspaces = createGoalWorkspaceRegistry(
		JSON.stringify([
			{
				ref: "trial",
				root,
				readablePaths: ["manual.md", "program.ts"],
				writablePaths: ["manual.md"],
				checks: [],
			},
		]),
	);
	let oldOwnerWakes = 0;
	const legacy = {
		list: () => goals.list(access),
		infoChanged: () => {
			oldOwnerWakes++;
		},
	} as GoalHost;
	const bindReply = (owner = access.principal, blocked = false) =>
		createGoalReplyWork({
			store,
			goals,
			conversation,
			workspaces,
			blocked: () => blocked,
			scopeKey: "work",
			access: { ...access, principal: owner },
			binding: () => ({ toolchainRevisionId: "development@1" }),
			progress: { submitInTransaction() {}, wake() {} },
		});
	const bind = (owner = access.principal, blocked = false) =>
		bindReply(owner, blocked)("chat", legacy);
	const call = async (
		work: ReturnType<typeof bind>,
		name: string,
		args: unknown,
		latest = user,
	) => {
		const tools = withGoalReplyTools(
			{ tools: [], call: async () => ({ content: "" }) },
			legacy,
			() => latest,
			"work",
			work,
		);
		const result = await tools.call(
			{ id: "call", name, arguments: JSON.stringify(args) },
			new AbortController().signal,
		);
		return JSON.parse(result.content);
	};
	try {
		await store.write((db) =>
			conversation.appendInTransaction(db, {
				...user,
				conversationId: "chat",
				role: "user",
				createdAt: new Date().toISOString(),
				runId: null,
			}),
		);
		const permission = {
			mode: "edit",
			workspaceRef: "trial",
			readablePaths: ["manual.md", "program.ts"],
			writablePaths: ["manual.md"],
			checkRefs: [],
			quote: "作業先で手順書だけ編集してよいです。",
		};
		const args = {
			slot: null,
			desiredState: "対象の手順書を更新",
			priority: null,
			quote: "対象を登録してください。",
			workPermission: permission,
		};
		const first = await call(bind(), "register_goal", args);
		expect(first).toMatchObject({
			status: "registered",
			permissionStatus: "authorized",
			slot: 1,
			goal: { revision: 1, desiredState: args.desiredState },
		});
		expect(await call(bind(), "register_goal", args)).toEqual(first);
		expect(goals.list(access).filter(({ goal }) => goal !== null)).toHaveLength(
			1,
		);
		expect(
			store.read((db) =>
				db
					.query("SELECT COUNT(*) AS count FROM goal_permits WHERE mode='goal'")
					.get(),
			),
		).toEqual({ count: 1 });
		const slots = await call(bind(), "list_goals", {});
		expect(slots.slots).toHaveLength(10);
		expect(slots.workspaces[0].ref).toBe("trial");
		await verifyGoalListRoute(store, bindReply().list, slots);
		expect(bindReply("other").list().slots.every(({ goal }) => !goal)).toBe(
			true,
		);
		const update = {
			slot: 1,
			goalId: first.goalId,
			revision: first.revision,
			design: null,
			desiredState: null,
			priority: null,
			quote: "作業先で手順書だけ編集してよいです。",
		};
		expect(
			await call(bind("other"), "update_goal", {
				...update,
				action: "authorize_work",
				workPermission: permission,
			}),
		).toMatchObject({ status: "refused" });
		expect(
			await call(bind("owner", true), "update_goal", {
				...update,
				action: "authorize_work",
				workPermission: permission,
			}),
		).toMatchObject({ status: "refused" });
		expect(
			await call(bind(), "update_goal", {
				...update,
				action: "revoke_work",
				revision: 2,
				permit: { id: first.permitId, revision: first.permitRevision },
			}),
		).toMatchObject({ status: "refused" });
		expect(
			await call(bind(), "update_goal", {
				...update,
				action: "revoke_work",
				permit: { id: first.permitId, revision: first.permitRevision },
			}),
		).toMatchObject({ status: "updated" });
		expect(
			store.read((db) =>
				goals.goalPermitInTransaction(db, access, {
					principal: access.principal,
					goalId: first.goalId,
					goalRevision: first.revision,
				}),
			),
		).toBeNull();
		const revokedReplay = await call(bind(), "register_goal", args);
		expect(revokedReplay).toMatchObject({
			status: "registered",
			permissionStatus: "revoked",
		});
		expect(revokedReplay.permitId).toBeUndefined();
		const liveEdit = await call(bind(), "update_goal", {
			...update,
			action: "authorize_work",
			workPermission: permission,
		});
		expect(liveEdit).toMatchObject({
			status: "updated",
			permitId: expect.any(String),
		});

		const reviseWords = {
			id: "revise-real",
			text: "対象の手順書とその内容をもう一度確認する目標に変えてください。",
		};
		await store.write((db) =>
			conversation.appendInTransaction(db, {
				...reviseWords,
				conversationId: "chat",
				role: "user",
				createdAt: new Date().toISOString(),
				runId: null,
			}),
		);
		expect(
			await call(
				bind(),
				"update_goal",
				{
					...update,
					action: "revise",
					desiredState: reviseWords.text,
					quote: reviseWords.text,
				},
				reviseWords,
			),
		).toMatchObject({ status: "updated" });
		const current = (await call(bind(), "list_goals", {})).slots[0];
		expect(current.goal.revision).toBe(first.revision + 1);
		expect(current.permit.id).not.toBe(liveEdit.permitId);
		expect(
			store.read((db) =>
				goals.goalPermitInTransaction(db, access, {
					principal: access.principal,
					goalId: first.goalId,
					goalRevision: current.goal.revision,
				}),
			),
		).toMatchObject({
			impact: "read",
			scope: {
				basis: { kind: "policy" },
				workspaceRef: "trial",
				writablePaths: [],
				checks: [],
			},
		});

		for (const [index, action] of ["revise", "withdraw"].entries()) {
			const slot = index + 2;
			const words = {
				id: `legacy-control-${action}`,
				text:
					action === "revise"
						? "旧目標の達成条件を改訂してください。"
						: "旧目標を取り下げてください。",
			};
			const old = await store.write((db) => {
				conversation.appendInTransaction(db, {
					...words,
					conversationId: "chat",
					role: "user",
					createdAt: new Date().toISOString(),
					runId: null,
				});
				const goal = goals.registerInTransaction(db, access, slot, {
					scopeKey: "work",
					source: { namespace: "conversation", kind: "message", id: user.id },
					sourceMessageIds: [user.id],
					operationKey: `old-registration-${action}`,
					desiredState: "previous goal",
					priority: 50,
				});
				db.query(
					"INSERT INTO goal_work (id,principal,goal_id,goal_revision,payload,state) VALUES (?,?,?,?,?,'accepted')",
				).run(`old-work-${action}`, access.principal, goal.id, 1, "{}");
				return goal;
			});
			const args = {
				...update,
				slot,
				goalId: old.id,
				revision: old.revision,
				quote: words.text,
			};
			expect(
				await call(
					bind(),
					"update_goal",
					{
						...args,
						action: "authorize_work",
						workPermission: { ...permission, quote: words.text },
					},
					words,
				),
			).toMatchObject({ status: "refused", reason: "goal_target_not_current" });
			expect(
				await call(
					bind(),
					"update_goal",
					{
						...args,
						action,
						desiredState: action === "revise" ? "revised goal" : null,
					},
					words,
				),
			).toMatchObject({ status: "updated", action, goalId: old.id });
			const state = (await call(bind(), "list_goals", {})).slots[slot - 1];
			expect(state).toMatchObject({
				mode: "mock",
				goal: {
					goalId: old.id,
					revision: 2,
					status: action === "revise" ? "adopted" : "withdrawn",
				},
			});
			expect(
				store.read((db) =>
					db
						.query("SELECT state, mode FROM goal_work WHERE id=?")
						.get(`old-work-${action}`),
				),
			).toEqual({ state: "accepted", mode: "mock" });
			await store.write((db) =>
				db
					.query("UPDATE goal_work SET state='cancelled' WHERE id=?")
					.run(`old-work-${action}`),
			);
		}
		expect(oldOwnerWakes).toBe(2);
	} finally {
		await store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
