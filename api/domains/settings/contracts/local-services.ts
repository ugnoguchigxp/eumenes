import { z } from "zod";
import { cloudEndpoint } from "./endpoints";
const origin = cloudEndpoint.refine((v) => new URL(v).pathname === "/");
export const excalidrawConnectionInput = z.strictObject({
	expectedRevision: z.number().int().nonnegative(),
	gatewayUrl: origin,
	gatewayOrigin: origin.optional(),
	leaseEndpoint: origin,
	consumerToken: z.string().min(32).max(4096).optional(),
	appToken: z.string().min(32).max(4096).optional(),
});
export const excalidrawConnectionSchema = z.strictObject({
	revision: z.number().int().nonnegative(),
	gatewayUrl: origin.nullable(),
	gatewayOrigin: origin.nullable(),
	leaseEndpoint: origin.nullable(),
	consumerConfigured: z.boolean(),
	appConfigured: z.boolean(),
});
export type ExcalidrawConnectionInput = z.infer<
	typeof excalidrawConnectionInput
>;
