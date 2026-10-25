import { z } from "zod";
export const ref = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
