import { systemContext } from "../../../infrastructure/system-context";
import type { Database } from "bun:sqlite";
import sharp from "sharp";
import { z } from "zod";
import { parseLlmJson } from "../../../infrastructure/llm-json";
import type { InferencePort, Receipt } from "../../inference";
import { controlInstructions, type ControlContract } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { designSpec, validatedDesign } from "../contracts";
import { get } from "../repository";

import type { ChatMessage } from "../../larm";
const payload = z.strictObject({
	id: z.string().uuid(),
	generation: z.number().int().positive(),
});
type Payload = z.infer<typeof payload>;
export type ControlInference = InferencePort & {
	captureMaintenanceControlInTransaction(
		db: Database,
		input: { subject: string; deadline: number; maxOutputTokens: number },
	): string;
};
export type ImagePort = {
	library(): { get(id: string, signal: AbortSignal): Promise<{ id: string }> };
	content(
		id: string,
		signal: AbortSignal,
	): Promise<{ bytes?: Uint8Array; mime?: string }>;
};
const control: ControlContract = {
	instructions: systemContext(
		"ui-compositions.contexts.handler.instructions",
		{},
	),
	outputSchema: z.toJSONSchema(designSpec),
};
export function createUiGenerationHandler(deps: {
	inference: ControlInference;
	image: () => ImagePort;
}) {
	const { inference } = deps;
	const handler: HandlerDefinition<
		Payload,
		{
			id: string;
			generation: number;
			prompt: string;
			motifId: string | null;
			previous: unknown;
			requestId: string;
		},
		{ receipt: Receipt; design: unknown }
	> = {
		kind: "ui-compositions.generate",
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const row = get(db, claim.payload.id);
			if (
				!row ||
				row.state !== "generating" ||
				row.generation !== claim.payload.generation
			)
				return { status: "stale", reason: "ui_generation_stale" };
			const requestId = inference.captureMaintenanceControlInTransaction(db, {
				subject: `ui:${row.id}:${row.generation}`,
				deadline: Date.now() + 90_000,
				maxOutputTokens: 2048,
			});
			return {
				status: "ready",
				input: {
					id: row.id,
					generation: row.generation,
					prompt: row.prompt,
					motifId: row.motif_id,
					previous: row.fields_json ? JSON.parse(row.fields_json) : null,
					requestId,
				},
			};
		},
		async execute(input, { signal }) {
			const images: import("../../inference").ChatImage[] = [];
			if (input.motifId) {
				const capability = inference.status().chatInput;
				if (!capability?.images.mimeTypes.includes("image/jpeg"))
					throw new Error("ui_motif_model_unsupported");
				await deps.image().library().get(input.motifId, signal);
				const artifact = await deps.image().content(input.motifId, signal);
				if (!artifact.bytes || artifact.bytes.length > 16 * 1024 * 1024)
					throw new Error("ui_motif_unavailable");
				const maxSide = Math.min(
					1024,
					capability.images.maxWidth,
					capability.images.maxHeight,
				);
				const bytes = await sharp(artifact.bytes)
					.rotate()
					.flatten({ background: "#ffffff" })
					.resize({
						width: maxSide,
						height: maxSide,
						fit: "inside",
						withoutEnlargement: true,
					})
					.jpeg({ quality: 80 })
					.toBuffer();
				const metadata = await sharp(bytes).metadata();
				if (
					bytes.length > capability.images.maxBytes ||
					!metadata.width ||
					!metadata.height ||
					metadata.width * metadata.height > capability.images.maxPixels
				)
					throw new Error("ui_motif_too_large");
				images.push({
					mime: "image/jpeg",
					bytes,
					width: metadata.width,
					height: metadata.height,
				});
			}
			const messages: ChatMessage[] = [
				{ role: "system", content: controlInstructions(control) },
				{
					role: "user",
					content: JSON.stringify({
						request: input.prompt,
						previous: input.previous,
						motifProvided: images.length > 0,
					}),
					...(images.length ? { images } : {}),
				},
			];
			const receipt = await inference.executeControl!(
				input.requestId,
				messages,
				signal,
				control,
			);
			let design: unknown;
			try {
				design = validatedDesign(parseLlmJson(receipt.value));
			} catch {
				design = null;
			}
			return { receipt, design };
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const row = get(db, claim.payload.id);
			if (
				!row ||
				row.generation !== claim.payload.generation ||
				row.state !== "generating"
			)
				return "stale";
			const now = Date.now();
			if (
				outcome.type !== "success" ||
				!input ||
				!outcome.result.design ||
				!inference.acceptInTransaction?.(db, outcome.result.receipt)
			) {
				db.query(
					"UPDATE ui_compositions SET state='failed', error_code=?, updated_at=? WHERE id=?",
				).run(
					outcome.type === "failed"
						? outcome.errorCode
						: "ui_generation_invalid",
					now,
					row.id,
				);
				return "applied";
			}
			const result = outcome.result.design as ReturnType<
				typeof validatedDesign
			>;
			db.query(
				"UPDATE ui_compositions SET title=?, description=?, definition_json=?, fields_json=?, state='ready', error_code=NULL, updated_at=? WHERE id=?",
			).run(
				result.spec.title,
				result.spec.description,
				JSON.stringify(result.definition),
				JSON.stringify(result.spec.fields),
				now,
				row.id,
			);
			return "applied";
		},
		cancelInTransaction(db, job) {
			const row = get(db, job.payload.id);
			if (
				row?.generation === job.payload.generation &&
				row.state === "generating"
			)
				db.query(
					"UPDATE ui_compositions SET state='cancelled', error_code=NULL, updated_at=? WHERE id=?",
				).run(Date.now(), row.id);
		},
	};
	return handler;
}
