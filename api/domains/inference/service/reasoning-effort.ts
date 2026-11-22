import { getLogger } from "../../../infrastructure/logger";
import { isAgentConnection } from "../../settings";
import { larmReasoningEfforts } from "../../settings/contracts";
import type { Connection, Resource } from "../../settings";
import type { ConnectionModelsService } from "./connection-models";
import type { Source } from "./execute-types";

const log = getLogger("inference");

/** What a model accepts: its catalog's levels, or nothing known. */
type Accepted = readonly string[] | undefined;

/**
 * The levels the call's model accepts. LARM declares them by its kind (its catalog names none per model); an agent
 * connection's catalog names them per model. `undefined`: nothing is known (no catalog, a model it does not list, a
 * catalog that could not be read), so the saved level goes out as it is and the provider answers for itself.
 */
async function acceptedEfforts(
	source: Source,
	connection: Connection | undefined,
	resource: Resource | undefined,
	models: ConnectionModelsService | undefined,
	signal: AbortSignal,
): Promise<Accepted> {
	if (source === "larm") return larmReasoningEfforts;
	if (!connection || !resource || !models || !isAgentConnection(connection))
		return undefined;
	const catalog =
		models.known?.(connection.id) ??
		(await models.list(connection.id, signal).catch(() => null));
	signal.throwIfAborted();
	return catalog?.models.find((m) => m.id === resource.model)?.reasoning
		?.efforts;
}

/**
 * The level one LLM attempt sends: the saved level, as it is, when the call's model accepts it. A model whose catalog
 * lists no level has none to send (`undefined`). A model that does not accept the saved level fails the attempt with
 * `reasoning_effort_unsupported` and a log line; the level is never changed to another one here (the chat screen
 * changes it with the model).
 */
export async function reasoningToSend(input: {
	effort: string | undefined;
	source: Source;
	connection: Connection | undefined;
	resource: Resource | undefined;
	models: ConnectionModelsService | undefined;
	signal: AbortSignal;
	inferenceId: string;
}): Promise<string | undefined> {
	const { effort, source, connection, resource } = input;
	if (effort === undefined) return effort;
	if (source === "cloud" && (!connection || !isAgentConnection(connection)))
		return undefined;
	const accepted = await acceptedEfforts(
		source,
		connection,
		resource,
		input.models,
		input.signal,
	);
	if (accepted === undefined) return effort;
	if (accepted.length === 0) return undefined;
	if (accepted.includes(effort)) return effort;
	log.warn("inference.reasoning_effort_unsupported", {
		inferenceId: input.inferenceId,
		source,
		connectionId: connection?.id,
		kind: effort,
		count: accepted.length,
	});
	throw new Error("reasoning_effort_unsupported");
}
