import { z } from "zod";
const endpoint = z
	.string()
	.url()
	.refine((v) => {
		const u = new URL(v);
		return (
			["http:", "https:"].includes(u.protocol) &&
			!u.username &&
			!u.password &&
			!u.search &&
			!u.hash &&
			u.pathname === "/"
		);
	});
export const localServiceLease = z
	.strictObject({
		id: z.string().min(1).max(128),
		serviceId: z.string().min(1).max(128),
		revision: z.string().regex(/^[a-f0-9]{64}$/),
		generation: z.number().int().positive(),
		bootEpoch: z.string().min(1).max(128),
		expiresAt: z.string().datetime(),
		status: z.enum(["starting", "ready", "failed", "released", "expired"]),
		endpoint: endpoint.optional(),
		error: z.string().max(128).optional(),
	})
	.refine((v) => (v.status === "ready") === (v.endpoint !== undefined));
export type LocalServiceLease = z.infer<typeof localServiceLease>;
export interface LocalServicesPort {
	ensure(
		service: string,
		key: string,
		signal: AbortSignal,
	): Promise<LocalServiceLease>;
	resolve(
		expected: LocalServiceLease,
		signal: AbortSignal,
	): Promise<LocalServiceLease>;
	renew(
		expected: LocalServiceLease,
		signal: AbortSignal,
	): Promise<LocalServiceLease>;
	release(id: string): Promise<void>;
}
