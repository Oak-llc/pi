import { join } from "node:path";
import { getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return [
		"This build only runs local models. Add one (llama.cpp, Ollama, LM Studio, vLLM, ...) as an",
		"OpenAI-compatible provider with a loopback base URL in models.json. See:",
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
