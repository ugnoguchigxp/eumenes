import { z } from "zod";
import { ref } from "./ref";
export const workSettings = z.strictObject({
	enabled: z.boolean(),
	connectionRef: ref.nullable(),
	projectRef: ref.nullable(),
	showInConversation: z.boolean(),
	maxRuntimeSeconds: z.number().int().min(60).max(7200),
	maxSessions: z.number().int().min(1).max(20),
});
export type WorkSettings = z.infer<typeof workSettings>;
export const defaultWorkSettings: WorkSettings = {
	enabled: false,
	connectionRef: null,
	projectRef: null,
	showInConversation: true,
	maxRuntimeSeconds: 7200,
	maxSessions: 3,
};
export const workSettingsApply = z.strictObject({
	expectedRevision: z.number().int().min(0),
	changes: z
		.array(
			z.strictObject({
				fieldId: z.string().min(1).max(100),
				value: z.string().max(200),
			}),
		)
		.min(1)
		.max(9),
});
