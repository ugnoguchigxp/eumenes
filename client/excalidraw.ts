import { z } from "zod";
import {
	documentSchema,
	type Drawing,
	type DrawingSession,
	type Reference,
	type Scene,
} from "../api/domains/excalidraw/contracts";
import { callJson, json, type Transport } from "./transport";

const referenceSchema: z.ZodType<Reference> = z.object({
	id: z.string(),
	conversationId: z.string(),
	documentId: z.string(),
	revision: z.number(),
	title: z.string(),
});
const sessionSchema: z.ZodType<DrawingSession> = z.object({
	id: z.string(),
	referenceId: z.string().nullable(),
	conversationId: z.string(),
	title: z.string(),
	state: z.enum(["starting", "ready", "failed", "idle", "closed"]),
	errorCode: z.string().nullable(),
	revision: z.number().nullable(),
	url: z.string().nullable(),
	epoch: z.number(),
	lastOperation: z.number(),
});
const operationSchema = z.object({
	id: z.string(),
	state: z.string(),
	runId: z.string(),
	action: z.string().nullable(),
	referenceId: z.string().nullable(),
	sessionId: z.string().nullable(),
	url: z.string().nullable(),
});
const createdSchema = documentSchema.extend({ referenceId: z.string() });

export function excalidrawClient(t: Transport) {
	const path = (id: string) =>
		`/api/excalidraw/sessions/${encodeURIComponent(id)}`;
	return {
		drawingReferences: async (
			conversationId = "main",
			signal?: AbortSignal,
		): Promise<Reference[]> =>
			callJson(
				t,
				z.array(referenceSchema),
				`/api/excalidraw/references?conversationId=${encodeURIComponent(conversationId)}`,
				{ signal },
			),
		drawingOperations: (signal?: AbortSignal) =>
			callJson(t, z.array(operationSchema), "/api/excalidraw/operations", {
				signal,
			}),
		openDrawing: async (
			input: {
				requestId: string;
				referenceId?: string;
				revision?: number;
				title?: string;
				conversationId?: string;
			},
			signal?: AbortSignal,
		): Promise<DrawingSession> =>
			callJson(t, sessionSchema, "/api/excalidraw/sessions", {
				...json(input),
				signal,
			}),
		drawingSession: async (
			id: string,
			signal?: AbortSignal,
		): Promise<DrawingSession> =>
			callJson(t, sessionSchema, path(id), { signal }),
		reconnectDrawing: async (
			id: string,
			signal?: AbortSignal,
		): Promise<DrawingSession> =>
			callJson(t, sessionSchema, `${path(id)}/reconnect`, {
				...json({}),
				signal,
			}),
		drawingDocument: async (
			id: string,
			signal?: AbortSignal,
		): Promise<Drawing> =>
			callJson(t, documentSchema, `${path(id)}/document`, { signal }),
		saveDrawing: async (
			id: string,
			input: { title: string; scene: Scene; expectedRevision: number },
			key: string,
		): Promise<Drawing> =>
			callJson(t, documentSchema, `${path(id)}/document`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify(input),
			}),
		createDrawing: async (
			id: string,
			input: { title: string; scene: Scene },
			key: string,
			signal?: AbortSignal,
		): Promise<Drawing & { referenceId: string }> =>
			callJson(t, createdSchema, `${path(id)}/document`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify(input),
				signal,
			}),
		deleteDrawing: async (
			referenceId: string,
			conversationId = "main",
		): Promise<void> => {
			await t.call(
				`/api/excalidraw/references/${encodeURIComponent(referenceId)}?conversationId=${encodeURIComponent(conversationId)}`,
				{ method: "DELETE" },
			);
		},
		drawingActivity: async (id: string): Promise<void> => {
			await t.call(`${path(id)}/activity`, json({}));
		},
		releaseDrawing: async (id: string): Promise<void> => {
			await t.call(path(id), { method: "DELETE", keepalive: true });
		},
	};
}
