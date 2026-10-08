import type { CredentialStore } from "@earendil-works/pi-ai";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../src/core/models-store.ts";

const runtimes = new WeakMap<ModelRegistry, ModelRuntime>();

/**
 * Oak fork: no built-in cloud providers exist, but many session tests use `anthropic`/`openai` model
 * fixtures with a stored key. Register loopback stand-ins under those names so credential handling and
 * session behavior stay covered. They never reach the network (baseUrl is loopback, streams are mocked).
 */
const FIXTURE_PROVIDERS: Record<string, string[]> = {
	anthropic: ["claude-sonnet-4-5", "claude-opus-4-6", "claude-opus-4-8", "claude-haiku-4-5"],
	openai: ["gpt-5", "gpt-5.4", "gpt-5.5", "gpt-4o-mini"],
};

function registerFixtureProviders(registry: ModelRegistry): void {
	for (const [provider, ids] of Object.entries(FIXTURE_PROVIDERS)) {
		registry.registerProvider(provider, {
			baseUrl: "http://127.0.0.1:1/v1",
			api: "openai-completions",
			apiKey: "test-key",
			models: ids.map((id) => ({
				id,
				name: id,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			})),
		});
	}
}

export interface TestRegistryOptions {
	/** Register the loopback `anthropic`/`openai` stand-ins (default true). Harness-based tests turn it off. */
	fixtures?: boolean;
}

function wrap(runtime: ModelRuntime, options?: TestRegistryOptions): ModelRegistry {
	const registry = new ModelRegistry(runtime);
	runtimes.set(registry, runtime);
	if (options?.fixtures !== false) registerFixtureProviders(registry);
	return registry;
}

/** Load optional models.json configuration without introducing file-backed catalog locks into unit tests. */
export async function createModelRegistry(
	credentials: CredentialStore,
	modelsPath?: string,
	options?: TestRegistryOptions,
): Promise<ModelRegistry> {
	return wrap(
		await ModelRuntime.create({
			credentials,
			modelsPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			allowModelNetwork: false,
		}),
		options,
	);
}

export async function createInMemoryModelRegistry(
	credentials: CredentialStore,
	options?: TestRegistryOptions,
): Promise<ModelRegistry> {
	return wrap(await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false }), options);
}

export function getModelRuntime(modelRegistry: ModelRegistry): ModelRuntime {
	const runtime = runtimes.get(modelRegistry);
	if (!runtime) throw new Error("ModelRegistry was not created by the test helper");
	return runtime;
}
