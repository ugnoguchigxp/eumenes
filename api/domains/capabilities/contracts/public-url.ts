import { z } from "zod";
export const publicUrl = z
	.string()
	.url()
	.max(2048)
	.refine((v) => {
		const u = new URL(v);
		return (
			["http:", "https:"].includes(u.protocol) && !u.username && !u.password
		);
	});
