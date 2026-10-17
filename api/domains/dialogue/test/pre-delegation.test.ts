import { expect, test } from "bun:test";
import { setup } from "./specialist.fixture";
import { validateDiscovery } from "../service/initial-decision";

test("direct answers finish without retrieving candidates or announcing work", async () => {
	const h = await setup();
	try {
		h.state.main.push("おはようございます。");
		const run = await h.ask("おはよう");
		expect(run.status).toBe("completed");
		expect(h.dialogue.answerText(run.id)).toBe("おはようございます。");
		expect(h.state.mainCalls).toHaveLength(1);
		expect(h.state.mainCalls[0]?.preparation?.collection).toMatchObject({
			conversationId: "main",
			turnId: run.id,
			granularity: "answer",
		});
		expect(h.state.routeCalls).toBe(0);
		expect(run.announcement).toBeNull();
		expect(await h.session()).toBeNull();
	} finally {
		await h.close();
	}
});

test("a notice is visible before a full handoff, survives completion and does not enter memory", async () => {
	const h = await setup();
	let stop = () => {};
	try {
		h.startCall({
			request: "新しい案を作る",
			announcement: "制作担当に引き継ぎます。",
		});
		h.state.specialist.push({ action: "reply", text: "こちらで制作します。" });
		const run = await h.say("新しい案を作る");
		const seen: number[] = [];
		stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.announcement) seen.push(h.state.specialistPrompts.length);
		});
		await h.finished(run.id);
		expect(h.dialogue.get(run.id)?.status).toBe("completed");
		expect(seen[0]).toBe(0);
		expect(h.dialogue.get(run.id)?.announcement).toBe(
			"制作担当に引き継ぎます。",
		);
		expect(h.dialogue.progress(run.id)?.text).toBe("こちらで制作します。");
		expect(
			h.conversation
				.get("main")
				.messages.some((m) => m.text === "制作担当に引き継ぎます。"),
		).toBe(false);
		expect(h.state.mainCalls[0]?.tools[0]?.function.name).toBe(
			"find_toolchain",
		);
		expect(h.state.mainCalls[1]?.tools[0]?.function.description).toContain(
			"会話相手",
		);
		const calls = h.state.mainCalls.length;
		h.state.specialist.push({ action: "reply", text: "変更しました。" });
		const next = await h.ask("色を変更して");
		expect(next.status).toBe("completed");
		expect(h.state.mainCalls).toHaveLength(calls);
		expect(h.state.routeCalls).toBe(1);
		expect(next.announcement).toBeNull();
	} finally {
		stop();
		await h.close();
	}
});

test("no available specialist returns an ordinary answer with its delivery collection", async () => {
	const h = await setup();
	try {
		h.state.noCandidates = true;
		h.state.main.push("対応できる担当が見つかりませんでした。");
		const run = await h.ask("制作を依頼したい");
		expect(run.status).toBe("completed");
		expect(run.announcement).toBeNull();
		expect(h.dialogue.answerText(run.id)).toBe(
			"対応できる担当が見つかりませんでした。",
		);
		expect(h.state.mainCalls).toHaveLength(2);
		expect(h.state.mainCalls[1]?.preparation?.collection?.turnId).toBe(run.id);
		expect(h.state.specialistPrompts).toHaveLength(0);
	} finally {
		await h.close();
	}
});

for (const moment of ["before", "after"] as const)
	test(`revoked authority ${moment} the notice never starts a specialist`, async () => {
		const h = await setup();
		let stop = () => {};
		try {
			h.startCall({ request: "制作" });
			h.state.receiptAllowed = moment !== "before";
			const run = await h.say("制作して");
			stop = h.dialogue.subscribeProgress(run.id, (p) => {
				if (p.announcement) h.state.receiptAllowed = false;
			});
			await h.finished(run.id);
			expect(h.dialogue.get(run.id)).toMatchObject({
				status: "failed",
				error: "permission_revoked",
			});
			expect(Boolean(h.dialogue.get(run.id)?.announcement)).toBe(
				moment === "after",
			);
			expect(h.state.specialistPrompts).toHaveLength(0);
			expect(await h.session()).toBeNull();
		} finally {
			stop();
			await h.close();
		}
	});

test("cancellation after the notice prevents specialist execution", async () => {
	const h = await setup();
	let stop = () => {};
	try {
		h.startCall({ request: "作る" });
		const run = await h.say("作る");
		let cancelled: Promise<unknown> | undefined;
		stop = h.dialogue.subscribeProgress(run.id, (p) => {
			if (p.announcement && !cancelled) cancelled = h.dialogue.cancel(run.id);
		});
		await h.finished(run.id);
		await cancelled;
		expect(h.dialogue.get(run.id)?.status).toBe("cancelled");
		expect(h.state.specialistPrompts).toHaveLength(0);
		expect(await h.session()).toBeNull();
	} finally {
		stop();
		await h.close();
	}
});

test("discovery cannot execute a tool or carry hidden arguments", () => {
	const call = (name: string, arguments_: string) => ({
		id: "c",
		name,
		arguments: arguments_,
	});
	expect(() => validateDiscovery([call("find_toolchain", "{}")])).not.toThrow();
	for (const calls of [
		[],
		[call("web_search", "{}")],
		[call("find_toolchain", '{"execute":true}')],
		[call("find_toolchain", "{}"), call("find_toolchain", "{}")],
	])
		expect(() => validateDiscovery(calls)).toThrow(
			"invalid_conversation_operation",
		);
});

test("a specialist may forward the initial run to another specialist, announcing both handoffs", async () => {
	const h = await setup();
	try {
		h.startCall({
			request: "制作",
			announcement: "最初の担当に引き継ぎます。",
		});
		h.startCall(
			{ request: "制作", announcement: "別の担当に引き継ぎます。" },
			"other_create",
		);
		h.state.specialist.push(
			{ action: "return", forward: true },
			{ action: "reply", text: "こちらで対応します。" },
		);
		const run = await h.ask("制作して");
		expect(run.status).toBe("completed");
		expect(run.announcement).toBe(
			"最初の担当に引き継ぎます。\n別の担当に引き継ぎます。",
		);
		expect(await h.session()).toMatchObject({ toolchainId: "fake.other" });
	} finally {
		await h.close();
	}
});
