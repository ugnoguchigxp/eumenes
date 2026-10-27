import { afterEach, expect, test } from "bun:test";
import { validators } from "../../domains/capabilities";
import {
	connect,
	runCleanup,
	setup as setupDomain,
	until,
} from "../../domains/browser/test/fakes";
import { CONVERSATION_DEFAULT_PRINCIPAL } from "../../domains/conversation/contracts";
import type { AdapterOrigin } from "../../domains/tool-runtime";
import {
	createBrowserAdapter,
	describeBrowserAdapter,
} from "./browser-adapter";
import { registerBrowserEffects } from "./browser-effects";
import { PAGE_TOOLS } from "./browser-task-tools";

afterEach(runCleanup);

const ui: AdapterOrigin = { kind: "ui", scope: "main", actionRequestId: "a1" };
const HISTORY_ID = "7c0e3b1a-5d2f-4a6b-9c81-0e4f6a2b3c4d";

function setup() {
	const env = setupDomain();
	const effects = registerBrowserEffects({
		queue: env.queue,
		service: env.service,
	});
	const adapter = createBrowserAdapter(env.service, effects, {
		userMessageInTransaction: () => null,
	} as never);
	const invoke = (
		operationName: string,
		input: unknown,
		origin: AdapterOrigin = {
			kind: "conversation",
			owner: { rootRunId: "run-1", taskId: "task-1", cancelEpoch: 0 },
			runId: "run-1",
			conversationId: "c1",
			messageId: "m1",
		},
	) =>
		env.store.write((db) =>
			adapter.invokeInTransaction(db, {
				operationName,
				input,
				requestId: crypto.randomUUID(),
				issuedAt: new Date().toISOString(),
				origin,
			}),
		);
	return { env, adapter, invoke };
}
type Setup = ReturnType<typeof setup>;

const REPLAY_HISTORY = "4d9b7e52-1c3a-4f08-b6a1-5e2d8c0f9a31";
const seedReplayable = (s: Setup) =>
	s.env.store.write((db) =>
		db
			.query(
				`INSERT INTO browser_histories(id,owner,title,request,place,variables_json,steps_json,actions_json,
				 revision,run_count,failure_count,last_outcome,has_commit,last_used_at,created_at,updated_at)
				 VALUES(?,?,'手順','依頼','www.example.com',?,'[]',?,3,1,0,'completed',0,1,1,1)`,
			)
			.run(
				REPLAY_HISTORY,
				CONVERSATION_DEFAULT_PRINCIPAL,
				JSON.stringify([{ name: "keyword", label: "検索語", slots: [] }]),
				JSON.stringify([
					{
						seq: 1,
						kind: "navigate",
						url: "https://www.example.com/s?q={{keyword}}",
					},
				]),
			),
	);

test("replaying is the screen's: it starts one replay, reads back by its id and the screen can stop it", async () => {
	const s = setup();
	await connect(s.env);
	await seedReplayable(s);
	let release!: () => void;
	s.env.driver.replayGate = new Promise<void>((r) => (release = r));
	const input = {
		historyId: REPLAY_HISTORY,
		expectedRevision: 3,
		values: { keyword: "猫" },
	};
	await expect(s.invoke("browser.history.replay", input)).rejects.toThrow(
		"origin_invalid",
	);
	await expect(
		s.invoke("browser.history.replay", { ...input, expectedRevision: 2 }, ui),
	).rejects.toThrow("browser_history_conflict");
	await expect(
		s.invoke("browser.history.replay", { ...input, values: {} }, ui),
	).rejects.toThrow("replay_values_invalid");
	const out = await s.invoke("browser.history.replay", input, ui);
	const replayId = (out.receipt as { replayId: string }).replayId;
	expect(out.receipt).toEqual({ action: "history.replay", replayId });
	const source = () =>
		(
			s.env.store.read((db) =>
				s.adapter.sourceInTransaction(
					db,
					"query:browser.workspace@1",
					undefined,
				),
			) as { data: { replays: { replayId: string; state: string }[] } }
		).data.replays;
	expect(source()).toMatchObject([{ replayId, state: "running" }]);
	const back = s.env.store.read((db) =>
		s.adapter.readInTransaction(db, `history.replay:${replayId}`),
	);
	expect(back?.receipt).toEqual({ action: "history.replay", replayId });
	await expect(s.invoke("browser.history.replay", input, ui)).rejects.toThrow(
		"replay_busy",
	);
	await until(() => s.env.driver.calls.includes("runReplay"));
	await expect(
		s.invoke("browser.history.replay.cancel", { replayId }),
	).rejects.toThrow("origin_invalid");
	const stopped = await s.invoke(
		"browser.history.replay.cancel",
		{ replayId },
		ui,
	);
	expect(stopped.receipt).toEqual({
		action: "history.replay.cancel",
		replayId,
	});
	// The abort reaches the running code through the control queue; the replay ends once the code has stopped.
	await until(() => source()[0]?.state === "cancelled");
	expect(s.env.driver.active).toBe(0);
	await expect(
		s.invoke("browser.history.replay.cancel", { replayId }, ui),
	).rejects.toThrow("replay_not_running");
	await expect(
		s.invoke(
			"browser.history.replay.cancel",
			{ replayId: crypto.randomUUID() },
			ui,
		),
	).rejects.toThrow("browser_replay_not_found");
	release();
});

test("the replay event's strings become the number and the values map; anything else reports its field", () => {
	const convert = describeBrowserAdapter().inputAdapters.get(
		"input:browser.history-replay@1",
	)!;
	expect(
		convert({
			historyId: HISTORY_ID,
			expectedRevision: "4",
			"var.keyword": "猫 癒し",
			"var.siteName": "x",
			ignored: "y",
		}),
	).toEqual({
		ok: true,
		value: {
			historyId: HISTORY_ID,
			expectedRevision: 4,
			values: { keyword: "猫 癒し", siteName: "x" },
		},
	});
	expect(convert({ historyId: HISTORY_ID, expectedRevision: "0" })).toEqual({
		ok: true,
		value: { historyId: HISTORY_ID, expectedRevision: 0, values: {} },
	});
	expect(convert({ historyId: HISTORY_ID, expectedRevision: "x" })).toEqual({
		ok: false,
		errors: [
			{ field: "expectedRevision", message: "revision を確認してください" },
		],
	});
	expect(
		convert({
			historyId: HISTORY_ID,
			expectedRevision: "1",
			"var.keyword": 5,
		}),
	).toEqual({
		ok: false,
		errors: [{ field: "var.keyword", message: "変数の値を確かめてください" }],
	});
	expect(convert({})).toMatchObject({
		ok: false,
		errors: [{ field: "historyId" }, { field: "expectedRevision" }],
	});
	// What the screen sends passes the operation's own schema once converted.
	const converted = convert({
		historyId: REPLAY_HISTORY,
		expectedRevision: "3",
		"var.keyword": "猫",
	});
	expect(
		converted.ok &&
			validators.browserHistoryReplayInput.safeParse(converted.value).success,
	).toBe(true);
});

test("the page operator's tools never reach the code runner: replays are the screen's alone", () => {
	for (const [id, tool] of Object.entries(PAGE_TOOLS)) {
		expect(id).toMatch(/^browser\.page\./);
		expect(id).not.toMatch(/replay|run_code/i);
		expect(String(tool.run)).not.toMatch(/runReplay|run_code/);
	}
});
