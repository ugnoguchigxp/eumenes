import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { openStore } from "../../../infrastructure/sqlite";
import { createQueue, migrations as queueMigrations } from "../../queue";
import type { InferencePort } from "../../inference";
import { createUiCompositions } from "..";
import { migrations } from "../repository";
import { validatedDesign } from "../contracts";
import { compileArtifact } from "@eumenes/artifact-ui";
import { waitFor } from "../../../infrastructure/wait-for";

const dirs: string[] = [];
const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closes.splice(0)) await close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
const survey = {
	title: "来場者アンケート",
	description: "ご意見をお聞かせください。",
	fields: [
		{ id: "name", label: "お名前", type: "text", required: true },
		{
			id: "rating",
			label: "満足度",
			type: "radio",
			required: true,
			options: ["満足", "普通", "不満"],
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
function setup(withMotif = false, gate?: Promise<void>) {
	const dir = mkdtempSync(
		join(import.meta.dir, "../../../..", ".ui-compositions-test-"),
	);
	dirs.push(dir);
	const store = openStore(join(dir, "db.sqlite3"), [
		...queueMigrations,
		...migrations,
	]);
	const queue = createQueue(store, { resources: { "inference.llm": 1 } });
	const observed: { imageCount: number; prompt: string }[] = [];
	const inference = {
		status: () => ({
			state: "ready",
			capabilities: ["llm"],
			chatInput: withMotif
				? {
						images: {
							mimeTypes: ["image/jpeg"],
							maxWidth: 1024,
							maxHeight: 1024,
							maxBytes: 500000,
							maxPixels: 1048576,
						},
					}
				: undefined,
		}),
		captureMaintenanceControlInTransaction: () => crypto.randomUUID(),
		executeControl: async (
			id: string,
			messages: Array<{ content: string; images?: unknown[] }>,
		) => {
			observed.push({
				imageCount: messages[1]?.images?.length ?? 0,
				prompt: messages[1]?.content ?? "",
			});
			if (gate) await gate;
			return {
				requestId: id,
				attemptId: crypto.randomUUID(),
				value: JSON.stringify(survey),
			};
		},
		acceptInTransaction: () => true,
	} as unknown as InferencePort & {
		captureMaintenanceControlInTransaction: (
			db: unknown,
			input: unknown,
		) => string;
	};
	const imageBytes = sharp({
		create: { width: 16, height: 16, channels: 3, background: "#e76a7a" },
	})
		.png()
		.toBuffer();
	const service = createUiCompositions({
		store,
		queue,
		inference,
		image: () => ({
			library: () => ({ get: async (id: string) => ({ id }) }),
			content: async () => ({
				bytes: new Uint8Array(await imageBytes),
				mime: "image/png",
			}),
		}),
	});
	queue.start();
	closes.push(async () => {
		await queue.close();
		await store.close();
	});
	return { store, service, observed };
}
async function untilReady(
	service: ReturnType<typeof createUiCompositions>,
	id: string,
) {
	for (let i = 0; i < 200; i++) {
		const item = service.get(id);
		if (item?.state === "ready") return item;
		await Bun.sleep(10);
	}
	throw new Error("generation did not finish");
}

test("survey design is generated, saved, submitted, and overwritten in place", async () => {
	const { store, service } = setup();
	const first = await store.write((db) =>
		service.composeInTransaction(
			db,
			{ prompt: "アンケート", projectId: "", motifId: "" },
			crypto.randomUUID(),
		),
	);
	const ready = await untilReady(service, first.item.id);
	expect(
		(ready.fields as typeof survey.fields).map((field) => field.type),
	).toEqual(["text", "radio", "checkbox", "textarea"]);
	expect((ready.definition as { view: string }).view).toBe("layout");
	const responseId = crypto.randomUUID();
	const result = await store.write((db) =>
		service.submitInTransaction(
			db,
			ready.id,
			ready.generation,
			{ name: "A", rating: "満足", interests: '["技術"]', comment: "よかった" },
			responseId,
		),
	);
	expect(result.responseId).toBe(responseId);
	expect(
		await store.write((db) =>
			service.submitInTransaction(
				db,
				ready.id,
				ready.generation,
				{
					name: "A",
					rating: "満足",
					interests: '["技術"]',
					comment: "よかった",
				},
				responseId,
			),
		),
	).toMatchObject({ replay: true });
	expect(
		store.read((db) => service.responseInTransaction(db, responseId)),
	).toMatchObject({ composition_id: ready.id });
	const second = await store.write((db) =>
		service.composeInTransaction(
			db,
			{ prompt: "文言を短く", projectId: ready.id },
			crypto.randomUUID(),
		),
	);
	expect(second.item.id).toBe(ready.id);
	const revised = await untilReady(service, ready.id);
	expect(revised.generation).toBe(2);
	expect(service.list()).toHaveLength(1);
	expect(() =>
		store.read((db) =>
			service.submitInTransaction(db, ready.id, 1, {}, crypto.randomUUID()),
		),
	).toThrow("ui_project_changed");
});

test("motif pixels reach the design subagent as an image", async () => {
	const { store, service, observed } = setup(true);
	const result = await store.write((db) =>
		service.composeInTransaction(
			db,
			{ prompt: "画像を参考に", motifId: "saved-image" },
			crypto.randomUUID(),
		),
	);
	await untilReady(service, result.item.id);
	expect(observed[0]?.imageCount).toBe(1);
	expect(observed[0]?.prompt).toContain("motifProvided");
});

test("a display-only card layout uses the same OpenUI renderer contract", () => {
	const { definition } = validatedDesign({
		title: "イベント案内",
		description: "本日のご案内",
		layout: "grid",
		appearance: "warm",
		fields: [],
		cards: [
			{ title: "会場", body: "Aホール" },
			{ title: "時間", body: "10時から" },
		],
	});
	const compiled = compileArtifact(JSON.stringify(definition), {});
	expect(compiled.request.view).toBe("layout");
	expect(definition.appearance).toBe("warm");
	expect(definition.children.map((child) => child.view)).toEqual([
		"text-block",
		"info-card",
		"info-card",
	]);
});

test("cancelled generation cannot replace the saved state after a late model result", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const { store, service, observed } = setup(false, gate);
	const started = await store.write((db) =>
		service.composeInTransaction(
			db,
			{ prompt: "案内画面" },
			crypto.randomUUID(),
		),
	);
	const id = started.item.id;
	await waitFor(() => observed.length > 0);
	expect(observed).toHaveLength(1);
	const cancelled = await store.write((db) =>
		service.cancelInTransaction(db, id, crypto.randomUUID()),
	);
	expect(cancelled.receipt.state).toBe("cancelled");
	release();
	await Bun.sleep(30);
	expect(service.get(id)?.state).toBe("cancelled");
	expect(service.get(id)?.definition).toBeUndefined();
});
