import { describe, expect, it } from "vitest";
import { ApiError } from "../index";
import { contracts, newClient, stubFetch } from "./harness";

const t0 = "2026-10-13T12:00:00.000Z";
const eventId = "10000000-0000-4000-8000-000000000001";
const event = {
	version: 1 as const,
	eventId,
	eventCreatedAt: t0,
	eventExpiresAt: "2026-10-14T12:00:00.000Z",
	artifactId: "tab",
	artifactRevisionId: "artifact:timers.workspace@1",
	source: "timer-setup",
	sourceRevision: 0,
	actionId: "timer-start",
	scopeRef: "scope:main",
	input: { hours: "0", minutes: "3", seconds: "0" },
};
const view = {
	eventId,
	status: "accepted",
	createdAt: t0,
	settledAt: t0,
	result: {
		version: 1,
		executionId: "e1",
		artifactRevisionId: event.artifactRevisionId,
		outcome: "completed",
		resultRefs: [],
		artifactRefs: [],
		receipt: { kind: "timer_action" },
	},
};
const entry = {
	toolchainId: "timers.manage",
	launcher: null,
	toolchainRevisionId: "toolchain:timers.manage@2",
	artifactRevisionId: event.artifactRevisionId,
	title: "タイマー（データドリブン）",
	adapterRef: "adapter:timers@1",
};
const definition = {
	kind: "artifact",
	id: "timers.workspace",
	revision: 1,
	title: "タイマー（データドリブン）",
	variants: [
		{
			id: "standard",
			label: "標準",
			definition: { view: "timer-workspace", source: "timer-current" },
		},
	],
	defaultVariant: "standard",
	sourceBindings: [
		{
			source: "timer-current",
			adapterRef: "adapter:timers@1",
			query: "query:timers.current@1",
			target: "required",
		},
	],
	actionBindings: [],
};
const interaction = {
	id: "i1",
	conversationId: "main",
	status: "waiting_input",
	revision: 1,
	chainRevisionId: "toolchain:timers.manage@2",
	artifactRevisionId: event.artifactRevisionId,
	question: {
		questionId: "20000000-0000-4000-8000-000000000001",
		prompt: "何分ですか？",
		inputSchemaRef: "builtin:timerDurationAnswer",
		revision: 1,
		expiresAt: "2026-10-14T12:00:00.000Z",
	},
	questionCount: 1,
	receiptRef: null,
	expiresAt: "2026-10-14T12:00:00.000Z",
	createdAt: t0,
	updatedAt: t0,
};
const answer = {
	eventId: "30000000-0000-4000-8000-000000000001",
	questionId: interaction.question.questionId,
	expectedRevision: 1,
	input: { durationSeconds: 180 },
};

contracts("toolchain actions client", [
	{
		name: "toolchainAction",
		call: (c) => c.toolchainAction(eventId),
		method: "GET",
		path: `/api/toolchain-actions/${eventId}`,
		response: view,
	},
	{
		name: "unsettledToolchainActions",
		call: (c) => c.unsettledToolchainActions(),
		method: "GET",
		path: "/api/toolchain-actions?status=unsettled",
		response: { requests: [view] },
		result: [view],
	},
	{
		name: "toolchainArtifacts",
		call: (c) => c.toolchainArtifacts(),
		method: "GET",
		path: "/api/toolchain-artifacts",
		response: { artifacts: [entry] },
		result: [entry],
	},
	{
		name: "toolchainArtifacts (standalone launcher artifact)",
		call: (c) => c.toolchainArtifacts(),
		method: "GET",
		path: "/api/toolchain-artifacts",
		response: {
			artifacts: [
				{
					artifactId: "settings.hub",
					artifactRevisionId: "artifact:settings.hub@1",
					title: "設定",
					toolchainId: null,
					toolchainRevisionId: null,
					adapterRef: null,
					adapterRefs: ["adapter:settings@1"],
					launcher: { label: "設定", order: 10 },
				},
			],
		},
		result: [
			{
				artifactId: "settings.hub",
				toolchainId: null,
				toolchainRevisionId: null,
				artifactRevisionId: "artifact:settings.hub@1",
				title: "設定",
				adapterRef: "adapter:settings@1",
				adapterRefs: ["adapter:settings@1"],
				launcher: { label: "設定", order: 10 },
			},
		],
	},
	{
		name: "toolchainArtifact",
		call: (c) => c.toolchainArtifact("artifact:timers.workspace@1"),
		method: "GET",
		path: "/api/toolchain-artifacts/artifact%3Atimers.workspace%401",
		response: {
			artifact: definition,
			artifactRevisionId: "artifact:timers.workspace@1",
			digest: "d",
			scopeRef: "scope:main",
		},
		result: expect.objectContaining({ scopeRef: "scope:main" }),
	},
	{
		name: "toolchainArtifactSource",
		call: (c) =>
			c.toolchainArtifactSource(
				"artifact:timers.workspace@1",
				"timer-current",
				"t1",
			),
		method: "GET",
		path: "/api/toolchain-artifacts/artifact%3Atimers.workspace%401/sources/timer-current?target=t1",
		response: { revision: 3, data: { anything: true } },
	},
	{
		name: "toolchainArtifactSource with params",
		call: (c) =>
			c.toolchainArtifactSource(
				"artifact:settings.records@1",
				"settings-records",
				undefined,
				undefined,
				{ pageIndex: "1", desc: true },
			),
		method: "GET",
		path: "/api/toolchain-artifacts/artifact%3Asettings.records%401/sources/settings-records?params=%7B%22pageIndex%22%3A%221%22%2C%22desc%22%3Atrue%7D",
		response: { revision: 0, data: { items: [] } },
	},
	{
		name: "toolchainInteractions",
		call: (c) =>
			c.toolchainInteractions({
				conversationId: "main",
				status: "waiting_input",
			}),
		method: "GET",
		path: "/api/toolchain-interactions?conversationId=main&status=waiting_input",
		response: [interaction],
	},
	{
		name: "answerToolchainInteraction",
		call: (c) => c.answerToolchainInteraction("i1", answer),
		method: "POST",
		path: "/api/toolchain-interactions/i1/answers",
		body: answer,
		response: { interaction, runId: "r1", replay: false },
	},
]);

describe("submitToolchainAction", () => {
	it("posts the validated event and reports the HTTP status with the view", async () => {
		const seen = stubFetch(() => Response.json(view, { status: 200 }));
		expect(await newClient().submitToolchainAction(event)).toEqual({
			httpStatus: 200,
			view,
		});
		expect(seen[0]).toMatchObject({
			method: "POST",
			path: "/api/toolchain-actions",
			body: event,
		});
		stubFetch(() =>
			Response.json(
				{ ...view, status: "pending", result: undefined },
				{ status: 202 },
			),
		);
		expect(await newClient().submitToolchainAction(event)).toMatchObject({
			httpStatus: 202,
			view: { status: "pending" },
		});
	});

	it("refuses to send an event that breaks the contract", async () => {
		const seen = stubFetch(() => Response.json(view));
		await expect(
			newClient().submitToolchainAction({ ...event, eventId: "nope" }),
		).rejects.toMatchObject({ name: "ZodError" });
		expect(seen).toHaveLength(0);
	});

	it("keeps the 422 field errors on the ApiError", async () => {
		const body = {
			error: "invalid_input",
			fieldErrors: [{ field: "durationSeconds", message: "too_small" }],
		};
		stubFetch(() => Response.json(body, { status: 422 }));
		const error = await newClient()
			.submitToolchainAction(event)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 422,
			message: "invalid_input",
			body,
		});
	});
});
