import { z } from "zod";
import { correctionCreate } from "./correction";

export const qrCreate = correctionCreate;
const point = z.tuple([
	z.number().finite().nonnegative(),
	z.number().finite().nonnegative(),
]);
export const qrItem = z.strictObject({
	text: z.string().max(20000).nullable(),
	contentType: z.enum([
		"Text",
		"Binary",
		"Mixed",
		"GS1",
		"ISO15434",
		"UnknownECI",
	]),
	polygon: z.array(point).length(4),
});
export const qrItems = z.array(qrItem).max(255);
export type QrItem = z.infer<typeof qrItem>;
export const qrRecord = z.strictObject({
	id: z.uuid(),
	sourceId: z.uuid(),
	frameIndex: z.number().int().nonnegative().nullable(),
	sourceRevision: z.number().int().nonnegative(),
	sourceDigest: z.string().length(64),
	decoderVersion: z.string().min(1),
	state: z.enum([
		"queued",
		"running",
		"cancelling",
		"cancelled",
		"completed",
		"failed",
	]),
	errorCode: z.string().nullable(),
	items: qrItems.nullable(),
	createdAt: z.number().int(),
	updatedAt: z.number().int(),
});
export type QrRecord = z.infer<typeof qrRecord>;
