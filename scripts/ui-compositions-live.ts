import type { LarmPort } from "../api/domains/larm";
import { ZodError } from "zod";
import { parseLlmJson } from "../api/infrastructure/llm-json";
import { validatedDesign } from "../api/domains/ui-compositions/contracts";
import { harness } from "../api/application/toolchain.fixture";
import { imageFixture } from "../api/application/image.fixture";
import { createLiveLarm, liveLarmSettings } from "./live-larm";

if (!process.argv.includes("--run")) throw new Error("ui_live_requires_run");
const saved = liveLarmSettings();
if (!saved.baseUrl) throw new Error("saved_larm_connection_unconfigured");
const live = createLiveLarm();
const observed: {
	requests: number;
	imageRequests: number;
	lastFailure?: unknown;
} = {
	requests: 0,
	imageRequests: 0,
};
const model: LarmPort = {
	...live,
	answer: async (messages, signal, options) => {
		if (messages[0]?.content.includes("あなたはOpenUI画面の制作担当です")) {
			observed.requests++;
			if (messages.some((message) => message.images?.length))
				observed.imageRequests++;
		}
		const value = await live.answer(messages, signal, options);
		if (messages[0]?.content.includes("あなたはOpenUI画面の制作担当です")) {
			try {
				validatedDesign(parseLlmJson(value));
				observed.lastFailure = undefined;
			} catch (error) {
				observed.lastFailure =
					error instanceof ZodError
						? error.issues.map((issue) => ({
								path: issue.path,
								code: issue.code,
							}))
						: {
								name: error instanceof Error ? error.name : "unknown",
								code:
									error instanceof Error && error.message.startsWith("ui_")
										? error.message
										: "definition_invalid",
							};
			}
		}
		return value;
	},
};
const image = imageFixture("library");
const h = await harness({
	model,
	imageGateway: image.gateway,
	uiCompositions: true,
});
try {
	const current = h.settings.get();
	const applied = await h.request("/api/settings/apply", {
		requestId: crypto.randomUUID(),
		expectedRevision: current.revision,
		settings: { ...current, larm: saved },
		keys: [],
	});
	if (!applied.ok) throw new Error("isolated_settings_failed");
	const connection = await h.request("/api/larm/connect", {});
	const status = (await connection.json()) as {
		larm: { state: string; chatInput?: { images?: unknown } };
	};
	if (status.larm.state !== "ready") throw new Error("live_model_not_ready");
	if (!status.larm.chatInput?.images)
		throw new Error("live_image_input_unavailable");
	const create = async (
		prompt: string,
		projectId?: string,
		motifId?: string,
	) => {
		const receipt = await h.store.write((db) =>
			h.uiCompositions!.composeInTransaction(
				db,
				{
					prompt,
					...(projectId ? { projectId } : {}),
					...(motifId ? { motifId } : {}),
				},
				crypto.randomUUID(),
			),
		);
		h.uiCompositions!.wake();
		const deadline = Date.now() + 120_000;
		let item = h.uiCompositions!.get(receipt.item.id);
		while (item?.state === "generating" && Date.now() < deadline) {
			await Bun.sleep(250);
			item = h.uiCompositions!.get(receipt.item.id);
		}
		if (item?.state !== "ready")
			throw new Error(
				`live_ui_generation_${item?.state ?? "missing"}_${item?.errorCode ?? "unknown"}:${JSON.stringify({ requests: observed.requests, imageRequests: observed.imageRequests, validation: observed.lastFailure })}`,
			);
		return item;
	};
	const survey = await create(
		"来場者向けアンケートフォーム。お名前のテキスト入力、満足度のRadio選択、興味のある分野のチェックボックス選択、感想のTextareaと送信を用意してください。",
	);
	const types = (survey.fields as Array<{ type: string }>).map(
		(field) => field.type,
	);
	for (const required of ["text", "radio", "checkbox", "textarea"])
		if (!types.includes(required))
			throw new Error(`live_survey_missing_${required}`);
	const revised = await create(
		"同じアンケートの説明を短くし、既存の入力項目と送信を残してください。",
		survey.id,
	);
	if (
		revised.id !== survey.id ||
		revised.generation !== 2 ||
		h.uiCompositions!.list().length !== 1
	)
		throw new Error("live_overwrite_failed");
	const motif = await create(
		"画像の色合いを参考に、イベント案内の見出し、短い説明と情報カードを作ってください。フォームは不要です。",
		undefined,
		"past-image",
	);
	if (observed.imageRequests !== 1 || motif.generation !== 1)
		throw new Error("live_motif_not_used");
	console.log(
		JSON.stringify({
			result: "passed",
			surveyTypes: types,
			overwrittenGeneration: revised.generation,
			motifState: motif.state,
			modelRequests: observed.requests,
			imageRequests: observed.imageRequests,
		}),
	);
} finally {
	await h.close();
}
