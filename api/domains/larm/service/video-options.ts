import { z } from "zod";
import { videoOptions } from "../contracts/video";

const schemaNode = z.object({
	$ref: z.string().optional(),
	properties: z.record(z.string(), z.unknown()).optional(),
});
const documentSchema = z.object({
	paths: z.record(z.string(), z.unknown()),
	components: z
		.object({
			schemas: z.record(z.string(), z.unknown()),
		})
		.optional(),
});
const generationPath = z.object({
	post: z
		.object({
			requestBody: z
				.object({
					content: z.object({
						"application/json": z.object({ schema: schemaNode }),
					}),
				})
				.optional(),
		})
		.optional(),
});
const choices = z.union([
	z.object({ const: z.number().positive() }).transform((v) => [v.const]),
	z
		.object({ enum: z.number().positive().array().min(1).max(32) })
		.transform((v) => [...new Set(v.enum)]),
]);

/** The request schema publishes finite, independent values for these three properties. */
export function readVideoOptions(document: unknown, path: string) {
	const openapi = documentSchema.parse(document);
	const schema = generationPath.parse(openapi.paths[path]).post?.requestBody
		?.content["application/json"].schema;
	const ref = schema?.$ref?.match(/^#\/components\/schemas\/([\w.-]+)$/)?.[1];
	const properties = ref
		? schemaNode.parse(openapi.components?.schemas[ref]).properties
		: schema?.properties;
	const widths = choices.parse(properties?.width);
	const heights = choices.parse(properties?.height);
	return videoOptions.parse({
		sizes: widths.flatMap((width) =>
			heights.map((height) => ({ width, height })),
		),
		durations: choices.parse(properties?.durationSeconds),
	});
}
