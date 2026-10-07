import { createHmac } from "node:crypto";

type AuthEnvironment = {
	[key: string]: string | undefined;
	EUMENES_API_TOKEN?: string;
	LARM_API_TOKEN?: string;
	LARM_CONTROL_TOKEN?: string;
};

/** Server-side only: never import into the browser bundle. */
export function resolveLarmToken(
	env: AuthEnvironment | typeof process.env,
): string | undefined {
	return (
		env.LARM_API_TOKEN?.trim() || env.LARM_CONTROL_TOKEN?.trim() || undefined
	);
}

/** Keep the local API credential distinct from the LARM control credential. */
export function resolveApiToken(
	env: AuthEnvironment | typeof process.env,
): string {
	const explicit = env.EUMENES_API_TOKEN?.trim();
	if (explicit) {
		if (explicit.length < 24)
			throw new Error("EUMENES_API_TOKEN must be at least 24 characters");
		return explicit;
	}
	const larm = resolveLarmToken(env);
	if (!larm)
		throw new Error(
			"Set LARM_API_TOKEN or EUMENES_API_TOKEN before starting Eumenes",
		);
	return createHmac("sha256", larm)
		.update("eumenes:local-api:v1")
		.digest("hex");
}
