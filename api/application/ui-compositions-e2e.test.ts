import { expect, test } from "bun:test";
import { harness } from "./toolchain.fixture";

const artifactRevisionId = "artifact:ui.workshop@1";
const survey = {
	title: "来場者アンケート",
	description: "ご意見をお聞かせください",
	fields: [
		{ id: "name", label: "お名前", type: "text", required: true },
		{
			id: "rating",
			label: "満足度",
			type: "radio",
			required: true,
			options: ["満足", "普通"],
		},
		{
			id: "interests",
			label: "興味のあるテーマ",
			type: "checkbox",
			required: true,
			options: ["技術", "デザイン"],
		},
		{ id: "comment", label: "感想", type: "textarea", required: false },
	],
};

test("registered UI workshop creates, displays, submits, and overwrites a survey", async () => {
	const h = await harness({ uiCompositions: true, uiDesignOutput: survey });
	try {
		const catalog = (await (
			await h.request("/api/toolchain-artifacts")
		).json()) as { artifacts: Array<{ artifactRevisionId: string }> };
		expect(
			catalog.artifacts.some(
				(entry) => entry.artifactRevisionId === artifactRevisionId,
			),
		).toBe(true);
		const detail = (await (
			await h.request(
				`/api/toolchain-artifacts/${encodeURIComponent(artifactRevisionId)}`,
			)
		).json()) as { scopeRef: string };
		const read = async (source: string, target?: string) => {
			const suffix = target ? `?target=${encodeURIComponent(target)}` : "";
			return (
				await h.request(
					`/api/toolchain-artifacts/${encodeURIComponent(artifactRevisionId)}/sources/${source}${suffix}`,
				)
			).json() as Promise<{ revision: number; data: Record<string, unknown> }>;
		};
		const submit = async (
			actionId: string,
			source: string,
			sourceRevision: number,
			input: unknown,
			targetRef?: string,
			eventId = crypto.randomUUID(),
		) => {
			const now = Date.now();
			return h.request("/api/toolchain-actions", {
				version: 1,
				eventId,
				eventCreatedAt: new Date(now).toISOString(),
				eventExpiresAt: new Date(now + 60_000).toISOString(),
				artifactId: "ui-test-tab",
				artifactRevisionId,
				source,
				sourceRevision,
				...(targetRef ? { targetRef } : {}),
				actionId,
				scopeRef: detail.scopeRef,
				input,
			});
		};
		const workshop = await read("ui-workshop");
		expect(workshop.data.kind).toBe("ui-workspace");
		const sent = await submit("compose", "ui-workshop", workshop.revision, {
			prompt: "アンケートを作成",
		});
		expect(sent.status).toBe(200);
		const accepted = (await sent.json()) as {
			result: { resultRefs: Array<{ id: string }> };
		};
		const id = accepted.result.resultRefs[0]!.id;
		for (
			let i = 0;
			i < 200 && h.uiCompositions!.get(id)?.state !== "ready";
			i++
		)
			await Bun.sleep(10);
		expect(h.uiCompositions!.get(id)?.state).toBe("ready");
		const form = await read("composition-form", id);
		expect(
			(form.data.fields as typeof survey.fields).map((field) => field.type),
		).toEqual(["text", "radio", "checkbox", "textarea"]);
		const response = await submit(
			"submit",
			"composition-form",
			form.revision,
			{ name: "A", rating: "満足", interests: '["技術"]', comment: "よかった" },
			id,
		);
		expect(response.status).toBe(200);
		const updated = await read("ui-workshop");
		const revised = await submit("compose", "ui-workshop", updated.revision, {
			prompt: "文言を短く",
			projectId: id,
		});
		expect(revised.status).toBe(200);
		for (
			let i = 0;
			i < 200 && h.uiCompositions!.get(id)?.state !== "ready";
			i++
		)
			await Bun.sleep(10);
		expect(h.uiCompositions!.list()).toHaveLength(1);
		expect(h.uiCompositions!.get(id)?.generation).toBe(2);
		const saved = (await (
			await h.request(`/api/ui-compositions/${id}`)
		).json()) as { definition: { view: string } };
		expect(saved.definition.view).toBe("layout");
	} finally {
		await h.close();
	}
});

test("conversation delegates UI creation to the registered command and saves its result", async () => {
	const prompt = "受付用のアンケート画面を作って";
	const h = await harness({
		uiCompositions: true,
		uiDesignOutput: survey,
		parent: () => "UIの制作を受け付けました。",
		routeTool: "ui_create",
		command: () =>
			JSON.stringify({
				action: "invoke",
				tool: "ui.compose.request",
				arguments: { prompt },
			}),
	});
	try {
		const run = await h.dialogue.submit({
			requestId: crypto.randomUUID(),
			conversationId: "main",
			text: prompt,
		});
		const done = await h.dialogue.waitForTerminal(run.id, { timeoutMs: 8000 });
		expect(done?.status).toBe("completed");
		expect(h.commandContexts).toHaveLength(1);
		for (
			let i = 0;
			i < 200 && h.uiCompositions!.list()[0]?.state !== "ready";
			i++
		)
			await Bun.sleep(10);
		expect(h.uiCompositions!.list()).toHaveLength(1);
		expect(h.uiCompositions!.list()[0]?.state).toBe("ready");
		expect(h.uiCompositions!.list()[0]?.prompt).toBe(prompt);
	} finally {
		await h.close();
	}
});
