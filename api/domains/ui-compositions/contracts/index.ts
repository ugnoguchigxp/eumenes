import { z } from "zod";
import { uiComposeRequest } from "../../capabilities/contracts";
import { parseDefinition } from "@eumenes/artifact-ui/contracts";

export const composeInput = uiComposeRequest;
export const submitInput = z.record(
	z.string(),
	z.union([z.string(), z.boolean(), z.array(z.string())]),
);
export const designSpec = z.strictObject({
	title: z.string().trim().min(1).max(120),
	description: z.string().max(2000),
	layout: z.enum(["stack", "grid"]).optional(),
	appearance: z.enum(["clean", "warm", "elegant", "friendly"]).optional(),
	cards: z
		.array(
			z.strictObject({
				title: z.string().min(1).max(120),
				body: z.string().max(1000),
			}),
		)
		.max(6)
		.optional(),
	fields: z
		.array(
			z.strictObject({
				id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
				label: z.string().min(1).max(120),
				type: z.enum([
					"text",
					"radio",
					"checkbox",
					"textarea",
					"select",
					"number",
					"boolean",
				]),
				required: z.boolean(),
				options: z.array(z.string().min(1).max(120)).min(1).max(8).optional(),
			}),
		)
		.max(8),
});
export type DesignSpec = z.infer<typeof designSpec>;
export function validatedDesign(raw: unknown) {
	const spec = designSpec.parse(raw);
	if (new Set(spec.fields.map((f) => f.id)).size !== spec.fields.length)
		throw new Error("ui_fields_duplicate");
	for (const field of spec.fields) {
		if (
			["radio", "checkbox", "select"].includes(field.type) !== !!field.options
		)
			throw new Error("ui_field_options_invalid");
		if (field.options && new Set(field.options).size !== field.options.length)
			throw new Error("ui_field_options_duplicate");
	}
	const definition = {
		view: "layout",
		direction: spec.layout ?? "stack",
		appearance: spec.appearance ?? "clean",
		title: spec.title,
		children: [
			{ view: "text-block", title: spec.title, body: spec.description },
			...(spec.cards ?? []).map((card) => ({ view: "info-card", ...card })),
			...(spec.fields.length
				? [{ view: "form", source: "composition-form", title: "" }]
				: []),
		],
	};
	parseDefinition(JSON.stringify(definition));
	return { spec, definition };
}
