import { ApiError, GoogleGenAI } from "@google/genai";
import { LLMRateLimitError, type StructuredLLM } from "./types";

export function createGeminiLLM(opts: { apiKey: string; model: string }): StructuredLLM {
  const ai = new GoogleGenAI({ apiKey: opts.apiKey });

  return {
    model: opts.model,
    async generateJson({ system, user, jsonSchema }) {
      try {
        const res = await ai.models.generateContent({
          model: opts.model,
          contents: user,
          config: {
            systemInstruction: system,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
            temperature: 0,
            // Headroom for models that "think" before answering.
            maxOutputTokens: 8192,
          },
        });
        const text = res.text;
        if (!text) throw new Error(`Empty response (finishReason=${res.candidates?.[0]?.finishReason ?? "unknown"})`);
        return { text, model: res.modelVersion ?? opts.model };
      } catch (err) {
        if (err instanceof ApiError && err.status === 429) {
          throw new LLMRateLimitError(parseRetryDelay(err.message));
        }
        throw err;
      }
    },
  };
}

/** Gemini 429s include e.g. `"retryDelay": "37s"`. */
function parseRetryDelay(message: string): number | null {
  const m = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return m ? Math.ceil(Number(m[1])) : null;
}
