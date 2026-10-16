import artifact from "../../.s11tnext/catalog.json";
import { createAppCatalog } from "../../.s11tnext/catalog.generated";

// Only authored instruction text lives in the catalog. Request data, schemas and
// capability snapshots remain in their existing host-owned composition paths.
// This text-only adapter preserves the existing composition; it does not record
// submission manifests or claim provider-delivery auditing.
export const systemContext = createAppCatalog(artifact).bindText({
	instructionLocale: "ja-JP",
	fallbackLocales: [],
	trailingNewline: false,
}).p;
