import { describe, expect, it } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import { getEnvApiKey } from "../src/env-api-keys.ts";
import {
	assertLoopbackBaseUrl,
	blockedStream,
	isLocalChatApi,
	isLoopbackUrl,
	NonLoopbackEndpointError,
} from "../src/local-only.ts";
import type { Model } from "../src/types.ts";

function model(baseUrl: string | undefined): Model<"openai-completions"> {
	return {
		id: "m",
		name: "m",
		api: "openai-completions",
		provider: "p",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	} as Model<"openai-completions">;
}

describe("local-only endpoint guard", () => {
	it.each([
		"http://127.0.0.1:8080/v1",
		"http://localhost:11434/v1",
		"https://localhost/v1",
		"http://[::1]:9000/v1",
		"http://127.1.2.3/v1",
		"ws://127.0.0.1:1234",
	])("treats %s as local", (url) => {
		expect(isLoopbackUrl(url)).toBe(true);
		expect(() => assertLoopbackBaseUrl(url)).not.toThrow();
	});

	it.each([
		"https://api.openai.com/v1",
		"https://api.anthropic.com",
		"http://192.168.1.10:8080/v1",
		"http://10.0.0.5/v1",
		"http://localhost.evil.com/v1",
		"http://127.0.0.1.evil.com/v1",
		"http://0.0.0.0:8080/v1",
		"file:///etc/passwd",
		"not a url",
		"",
		undefined,
	])("refuses %s", (url) => {
		expect(isLoopbackUrl(url)).toBe(false);
		expect(() => assertLoopbackBaseUrl(url)).toThrow(NonLoopbackEndpointError);
	});

	it("only allows chat APIs a local server speaks", () => {
		expect(isLocalChatApi("openai-completions")).toBe(true);
		expect(isLocalChatApi("openai-responses")).toBe(true);
		expect(isLocalChatApi("faux:123:abc")).toBe(true);
		for (const api of ["anthropic-messages", "google-generative-ai", "bedrock-converse-stream", "pi-messages"]) {
			expect(isLocalChatApi(api)).toBe(false);
		}
	});

	it("lazyStream ends with an error event instead of running setup for a cloud model", async () => {
		let setupRan = false;
		const stream = lazyStream(model("https://api.openai.com/v1"), async () => {
			setupRan = true;
			throw new Error("unreachable");
		});
		const result = await stream.result();
		expect(setupRan).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Refusing to contact");
		expect(result.errorMessage).toContain("api.openai.com");
	});

	it("blockedStream reports the refused endpoint", async () => {
		const result = await blockedStream(model("https://example.com/v1")).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("only allows local models");
	});

	it("never reads environment API keys", () => {
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "sk-should-never-be-used";
		try {
			expect(getEnvApiKey("openai")).toBeUndefined();
			expect(getEnvApiKey("anthropic")).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});
});
