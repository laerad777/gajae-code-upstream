import type { ModelManagerOptions } from "../model-manager";
import { KIRO_RUNTIME_URL, parseKiroAccessContext } from "../providers/kiro";
import type { Model } from "../types";
import { fetchKiroModels } from "../utils/discovery/kiro";

const KIRO_STATIC_SEED: readonly Model<"kiro-streaming">[] = [
	{
		id: "claude-opus-5",
		name: "claude-opus-5",
		api: "kiro-streaming",
		provider: "kiro",
		baseUrl: KIRO_RUNTIME_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-sonnet-5",
		name: "claude-sonnet-5",
		api: "kiro-streaming",
		provider: "kiro",
		baseUrl: KIRO_RUNTIME_URL,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
];

export function kiroModelManagerOptions(config: { apiKey?: string }): ModelManagerOptions<"kiro-streaming"> {
	const access = config.apiKey ? parseKiroAccessContext(config.apiKey) : undefined;
	return {
		providerId: "kiro",
		staticModels: [...KIRO_STATIC_SEED],
		...(access
			? { fetchDynamicModels: () => fetchKiroModels({ accessToken: access.token, profileArn: access.profileArn }) }
			: undefined),
	};
}
