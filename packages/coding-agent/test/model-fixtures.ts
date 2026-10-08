import type { Model } from "@earendil-works/pi-ai";

/**
 * Oak fork: the built-in cloud model catalog is intentionally empty, so tests that only need *a* model
 * object (not provider-specific behavior) build a loopback one. Never reaches the network.
 */
export function getModel(provider: string, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	} as Model<"openai-completions">;
}
