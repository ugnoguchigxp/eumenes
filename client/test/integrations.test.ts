import { describe, expect, it } from "vitest";
import { contracts, newClient, stubFetch } from "./harness";

const t0 = "2026-10-10T00:00:00.000Z";
const uuid = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";

const reference = {
	id: uuid,
	conversationId: "main",
	documentId: "doc1",
	revision: 1,
	title: "図",
};
const session = {
	id: uuid2,
	referenceId: uuid,
	conversationId: "main",
	title: "図",
	state: "ready",
	errorCode: null,
	revision: 1,
	url: "http://127.0.0.1:5173/#drawing/x",
	epoch: 1,
	lastOperation: 0,
};
const scene = { elements: [], appState: {}, files: {} };
const drawing = { id: uuid, title: "図", revision: 1, scene };
const saveKey = "key-12345678";
contracts("excalidraw client", [
	{
		name: "drawingReferences",
		call: (c) => c.drawingReferences("main"),
		method: "GET",
		path: "/api/excalidraw/references?conversationId=main",
		response: [reference],
	},
	{
		name: "drawingOperations",
		call: (c) => c.drawingOperations(),
		method: "GET",
		path: "/api/excalidraw/operations",
		response: [
			{
				id: "o1",
				state: "completed",
				runId: "r1",
				action: null,
				referenceId: null,
				sessionId: null,
				url: null,
			},
		],
	},
	{
		name: "openDrawing",
		call: (c) => c.openDrawing({ requestId: uuid }),
		method: "POST",
		path: "/api/excalidraw/sessions",
		body: { requestId: uuid },
		response: session,
	},
	{
		name: "drawingSession",
		call: (c) => c.drawingSession(uuid2),
		method: "GET",
		path: `/api/excalidraw/sessions/${uuid2}`,
		response: session,
	},
	{
		name: "reconnectDrawing",
		call: (c) => c.reconnectDrawing(uuid2),
		method: "POST",
		path: `/api/excalidraw/sessions/${uuid2}/reconnect`,
		body: {},
		response: session,
	},
	{
		name: "drawingDocument",
		call: (c) => c.drawingDocument(uuid2),
		method: "GET",
		path: `/api/excalidraw/sessions/${uuid2}/document`,
		response: drawing,
	},
	{
		name: "saveDrawing",
		call: (c) =>
			c.saveDrawing(
				uuid2,
				{ title: "図", scene, expectedRevision: 1 },
				saveKey,
			),
		method: "PUT",
		path: `/api/excalidraw/sessions/${uuid2}/document`,
		response: drawing,
	},
	{
		name: "createDrawing",
		call: (c) => c.createDrawing(uuid2, { title: "図", scene }, saveKey),
		method: "POST",
		path: `/api/excalidraw/sessions/${uuid2}/document`,
		response: { ...drawing, referenceId: uuid },
	},
]);

const account = {
	revision: 2,
	configured: true,
	status: "connected",
	profile: { sub: "s", name: "名前", email: "a@example.com" },
	pending: false,
};
contracts("google-accounts client", [
	{
		name: "googleAccount",
		call: (c) => c.googleAccount(),
		method: "GET",
		path: "/api/google-accounts",
		response: account,
	},
	{
		name: "connectGoogleAccount",
		call: (c) => c.connectGoogleAccount(2),
		method: "POST",
		path: "/api/google-accounts/connect",
		body: { expectedRevision: 2 },
		response: { url: "https://accounts.example.com/auth" },
	},
	{
		name: "cancelGoogleAccount",
		call: (c) => c.cancelGoogleAccount(2),
		method: "POST",
		path: "/api/google-accounts/cancel",
		body: { expectedRevision: 2 },
		response: account,
	},
	{
		name: "disconnectGoogleAccount",
		call: (c) => c.disconnectGoogleAccount(2),
		method: "POST",
		path: "/api/google-accounts/disconnect",
		body: { expectedRevision: 2 },
		response: { ...account, status: "disconnected", profile: undefined },
		result: { ...account, status: "disconnected", profile: undefined },
	},
]);

const run = {
	id: "r1",
	requestId: "q1",
	conversationId: "c1",
	utteranceId: null,
	status: "queued",
	revision: 1,
	inputMessageId: "m1",
	answerMessageId: null,
	error: null,
	jobId: null,
	deadlineAt: null,
	sourceKind: "manual",
	scheduleId: null,
	occurrenceId: null,
	createdAt: t0,
	updatedAt: t0,
};
const ocrConnection = {
	revision: 1,
	serviceId: "ocr-host",
	baseUrl: null,
	credentialConfigured: false,
};
const recognitionConnection = {
	revision: 1,
	serviceId: "object-recognition-host",
	baseUrl: null,
	credentialConfigured: false,
	credentialSource: "dedicated",
	sharedCredentialAvailable: false,
};
contracts("ocr and object-recognition client answers", [
	{
		name: "configureOcrConnection",
		call: (c) =>
			c.configureOcrConnection({
				expectedRevision: 0,
				baseUrl: "http://127.0.0.1:9000",
			}),
		method: "PUT",
		path: "/api/settings/ocr",
		body: { expectedRevision: 0, baseUrl: "http://127.0.0.1:9000" },
		response: ocrConnection,
	},
	{
		name: "ocrIncorporate",
		call: (c) => c.ocrIncorporate("o1", uuid, 0, [1]),
		method: "POST",
		path: "/api/ocr/o1/conversation",
		body: { requestId: uuid, frameIndex: 0, lineIndexes: [1] },
		response: run,
	},
	{
		name: "ocrCorrectionIncorporate",
		call: (c) => c.ocrCorrectionIncorporate("o1", "k1", uuid, "main"),
		method: "POST",
		path: "/api/ocr/o1/corrections/k1/conversation",
		body: { requestId: uuid, conversationId: "main" },
		response: run,
	},
	{
		name: "configureRecognitionConnection",
		call: (c) =>
			c.configureRecognitionConnection({
				expectedRevision: 0,
				credentialSource: "larm",
			}),
		method: "PUT",
		path: "/api/settings/object-recognition",
		body: { expectedRevision: 0, credentialSource: "larm" },
		response: recognitionConnection,
	},
	{
		name: "recognitionIncorporate",
		call: (c) => c.recognitionIncorporate("o1", uuid, 0),
		method: "POST",
		path: "/api/object-recognition/o1/conversation",
		body: { requestId: uuid, frameIndex: 0 },
		response: run,
	},
]);

describe("inference usage page", () => {
	it("parses each usage row and rejects a malformed page", async () => {
		stubFetch(() =>
			Response.json({ items: [], total: 0, pageIndex: 0, pageSize: 10 }),
		);
		await expect(
			newClient().inferenceUsagePage({
				pageIndex: 0,
				pageSize: 10,
				q: "",
				desc: true,
				sort: "createdAt",
			} as never),
		).resolves.toEqual({ items: [], total: 0, pageIndex: 0, pageSize: 10 });
		stubFetch(() => Response.json({ items: [{ id: 1 }], total: 1 }));
		await expect(
			newClient().inferenceUsagePage({} as never),
		).rejects.toMatchObject({ name: "ZodError" });
	});
});
