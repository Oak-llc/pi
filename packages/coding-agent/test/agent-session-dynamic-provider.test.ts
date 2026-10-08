import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import type { ExtensionFactory } from "../src/core/sdk.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getModel } from "./model-fixtures.ts";

function nativeAnthropicProvider(baseUrl: string): Provider {
	const model = { ...getModel("anthropic", "claude-sonnet-4-5")!, baseUrl };
	return {
		id: "anthropic",
		name: "Native Anthropic",
		baseUrl,
		auth: {
			apiKey: {
				name: "Test API key",
				resolve: async () => ({ auth: { apiKey: "test-key" }, source: "test" }),
			},
		},
		getModels: () => [model],
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

describe("AgentSession dynamic provider registration", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-dynamic-provider-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(extensionFactories: ExtensionFactory[]) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(agentDir, "models.json"),
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			modelRuntime,
			resourceLoader,
		});

		return session;
	}

	async function capturePromptBaseUrl(
		session: Awaited<ReturnType<typeof createSession>>,
	): Promise<string | undefined> {
		let baseUrl: string | undefined;
		session.agent.streamFunction = async (model) => {
			baseUrl = model.baseUrl;
			throw new Error("stop");
		};
		await session.prompt("hello");
		return baseUrl;
	}

	it("registers native pi-ai providers during extension loading", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-top-level"));
			},
		]);

		expect(session.model?.baseUrl).toBe("http://localhost:8080/native-top-level");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/native-top-level");

		session.dispose();
	});

	it("registers native pi-ai providers at command time", async () => {
		const session = await createSession([
			(pi) => {
				pi.registerCommand("use-native", {
					description: "Use native provider",
					handler: async () => {
						pi.registerProvider(nativeAnthropicProvider("http://localhost:8080/native-command"));
					},
				});
			},
		]);

		await session.bindExtensions({});
		await session.prompt("/use-native");

		expect(session.model?.baseUrl).toBe("http://localhost:8080/native-command");
		expect(await capturePromptBaseUrl(session)).toBe("http://localhost:8080/native-command");

		session.dispose();
	});
});
