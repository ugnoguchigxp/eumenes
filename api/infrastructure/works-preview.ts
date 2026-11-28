export function worksPreviewPort(
	env: Readonly<Record<string, string | undefined>>,
) {
	const port = Number(env.EUMENES_PROTOTYPE_PREVIEW_PORT ?? 8794);
	if (!Number.isInteger(port) || port < 1024 || port > 65535)
		throw new Error("prototype_port_invalid");
	return port;
}

export const worksFrameSource = (port: number) => "http://*.localhost:" + port;
