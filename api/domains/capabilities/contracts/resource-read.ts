import { z } from "zod";

/**
 * Input of the `resource.read` tool: the URI of a resource handed to the execution or returned by one of its
 * tools. `format: "eumenes-uri"` makes the sub-agent host check the value before the tool runs. Capabilities
 * cannot import the resources domain, which owns the URI grammar (`parseResourceUri`) and is the one that reads.
 */
export const resourceRead = z.strictObject({
	uri: z
		.string()
		.min(1)
		.max(512)
		.meta({ format: "eumenes-uri" })
		.describe("読むリソースのURI。提示されたものをそのまま写す。"),
});
