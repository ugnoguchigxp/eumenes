import { validators } from "../contracts";
import { z } from "zod";
export const zSchema = (key: keyof typeof validators) =>
	z.toJSONSchema(validators[key]);
