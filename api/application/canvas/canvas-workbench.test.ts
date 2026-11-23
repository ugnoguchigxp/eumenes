import { expect, test } from "bun:test";
import { installCanvasJobs } from "./workbench/jobs.js";

function screen(
	response: (path: string) => Promise<unknown>,
	beforeOpen?: () => Promise<void>,
) {
	const statuses: string[] = [];
	const notices: string[] = [];
	const shown: string[] = [];
	const listeners = new Map<string, () => void>();
	const state = {
		runId: null as string | null,
		artworkId: null as string | null,
	};
	let selection = 0;
	const controller = installCanvasJobs({
		conversationId: "fixture",
		api: response,
		$: (id: string) => ({
			disabled: true,
			addEventListener: (event: string, callback: () => void) =>
				listeners.set(`${id}:${event}`, callback),
		}),
		state,
		getSelection: () => selection,
		hideCandidate() {},
		setRunStatus: (value: string) => statuses.push(value),
		notice: (value: string) => notices.push(value),
		async openArtwork(id: string) {
			state.artworkId = id;
			selection++;
			await beforeOpen?.();
		},
		selectArtwork() {
			state.artworkId = null;
			selection++;
		},
		pollRun: (id: string) => shown.push(id),
		STATE_TEXT: { failed: "失敗しました", cancelled: "取り消しました" },
		now: () => 100,
		schedule: () => 0,
	});
	return {
		controller,
		statuses,
		notices,
		shown,
		state,
		listeners,
		select: () => {
			selection++;
		},
	};
}

test.each([
	["failed", "完了できません"],
	["cancelled", "取り消しました"],
	["expired", "期限"],
	["interrupted", "中断"],
])("画面を初めて開いたときから%sを表示する", async (state, text) => {
	const s = screen(async () => ({ id: "job", state, acceptedAt: 1 }));
	await s.controller.ready;
	expect(s.statuses.at(-1)).toContain(text!);
});

test("版競合は作品の選び直しを案内する", async () => {
	const s = screen(async () => ({
		id: "job",
		state: "failed",
		errorCode: "canvas_revision_conflict",
		acceptedAt: 1,
	}));
	await s.controller.ready;
	expect(s.statuses.at(-1)).toContain("版が変わりました");
});

test("通信断と制作失敗を区別し、再取得で表示を回復する", async () => {
	let online = false;
	const s = screen(async () => {
		if (!online) throw new Error("offline");
		return { id: "job", state: "failed", acceptedAt: 1 };
	});
	await s.controller.ready;
	expect(s.notices.at(-1)).toContain("取得できません");
	expect(s.statuses).toEqual([]);
	online = true;
	await s.controller.refresh();
	expect(s.notices.at(-1)).toBe("");
	expect(s.statuses.at(-1)).toContain("完了できません");
});

test("選択後に到着した古い状態取得結果で画面を書き換えない", async () => {
	const result = Promise.withResolvers<unknown>();
	const s = screen(() => result.promise);
	s.select();
	result.resolve({ id: "job", state: "failed", acceptedAt: 1 });
	await s.controller.ready;
	expect(s.statuses).toEqual([]);
});

test("画面から新しい依頼を送った後に、以前のジョブで候補を上書きしない", async () => {
	let job = { id: "old", state: "failed", acceptedAt: 1 };
	const s = screen(async () => job);
	await s.controller.ready;
	s.listeners.get("composer:submit")!();
	job = { id: "older-job", state: "failed", acceptedAt: 99 };
	await s.controller.refresh();
	expect(s.statuses).toHaveLength(1);
	job = { id: "new", state: "running", acceptedAt: 101 };
	await s.controller.refresh();
	expect(s.statuses.at(-1)).toContain("制作中");
});

test("候補の表示はキュー完了後だけで、同じrunを繰り返し開かない", async () => {
	const s = screen(async (path) =>
		path.includes("/jobs/")
			? { id: "job", state: "completed", runId: "run", acceptedAt: 1 }
			: { id: "run", state: "presented", isNew: true },
	);
	await s.controller.ready;
	expect(s.shown).toEqual(["run"]);
	s.state.runId = null;
	await s.controller.refresh();
	expect(s.shown).toEqual(["run"]);
});

test.each(["composer:submit", "artworks:click"])(
	"run取得中の%sで古い候補を採用しない",
	async (event) => {
		const entered = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<unknown>();
		const s = screen(async (path) => {
			if (path.includes("/jobs/"))
				return { id: "job", state: "completed", runId: "old", acceptedAt: 1 };
			entered.resolve();
			return reply.promise;
		});
		await entered.promise;
		s.listeners.get(event)!();
		reply.resolve({ id: "old", state: "presented", isNew: true });
		await s.controller.ready;
		expect(s.shown).toEqual([]);
		expect(s.state.runId).toBeNull();
		// Ignoring this response must not mark the run as already displayed.
		await s.controller.refresh();
		expect(s.shown).toEqual([]);
	},
);

test("内部の作品読込は許可し、読込中の新操作は古い候補を破棄する", async () => {
	for (const interrupt of [false, true]) {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const s = screen(
			async (path) =>
				path.includes("/jobs/")
					? { id: "job", state: "completed", runId: "run", acceptedAt: 1 }
					: {
							id: "run",
							state: "presented",
							isNew: false,
							artworkId: "artwork",
						},
			async () => {
				entered.resolve();
				await release.promise;
			},
		);
		await entered.promise;
		if (interrupt) s.listeners.get("composer:submit")!();
		release.resolve();
		await s.controller.ready;
		expect(s.shown).toEqual(interrupt ? [] : ["run"]);
	}
});
