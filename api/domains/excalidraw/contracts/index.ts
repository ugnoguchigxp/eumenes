import { z } from "zod";
const sceneSchema = z.strictObject({
	elements: z.array(z.unknown()),
	appState: z.record(z.string(), z.unknown()),
	files: z.record(z.string(), z.unknown()),
});
export type Scene = z.infer<typeof sceneSchema>;
export const documentMetadata = z.object({
	id: z.uuid(),
	title: z.string().max(200),
	revision: z.number().int().positive(),
});
export const documentSchema = documentMetadata.extend({ scene: sceneSchema });
export type Drawing = z.infer<typeof documentSchema>;
export const saveDrawing = z.strictObject({
	title: z.string().min(1).max(200),
	scene: sceneSchema,
	expectedRevision: z.number().int().positive(),
});
export const createDrawing = saveDrawing.omit({ expectedRevision: true });
export const openDrawing = z.strictObject({
	conversationId: z.string().min(1).max(128).default("main"),
	referenceId: z.uuid().optional(),
	revision: z.number().int().positive().optional(),
	title: z.string().min(1).max(200).default("新しい図"),
	requestId: z.uuid(),
});
export type Reference = {
	id: string;
	conversationId: string;
	documentId: string;
	revision: number;
	title: string;
};
export type DrawingSession = {
	id: string;
	referenceId: string | null;
	conversationId: string;
	title: string;
	state: "starting" | "ready" | "failed" | "idle" | "closed";
	errorCode: string | null;
	revision: number | null;
	url: string | null;
	epoch: number;
	lastOperation: number;
};
