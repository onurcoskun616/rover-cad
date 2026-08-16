import fs from "node:fs";
import { config } from "../config.js";

function guessMime(filePath) {
  const ext = filePath.split(".").pop().toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

/**
 * Call the OpenAI Chat Completions API and return the assistant's text.
 *
 * @param {string} input        user prompt text
 * @param {{systemPromptFile: string, imagePath?: string}} opts
 * @returns {Promise<{text:string, usage:object, provider:string, model:string}>}
 */
export async function runOpenAI(input, { systemPromptFile, imagePath }) {
  if (!config.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const systemPrompt = fs.readFileSync(systemPromptFile, "utf-8");

  const messages = [{ role: "system", content: systemPrompt }];

  if (imagePath && fs.existsSync(imagePath)) {
    const base64 = fs.readFileSync(imagePath).toString("base64");
    const mime = guessMime(imagePath);
    messages.push({
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: `data:${mime};base64,${base64}` },
        },
        { type: "text", text: input },
      ],
    });
  } else {
    messages.push({ role: "user", content: input });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.openai.timeoutMs);

  try {
    const url = `${config.openai.baseUrl}/chat/completions`;
    console.log(
      `[OpenAI] calling ${config.openai.model}, input ${input.length} chars`,
    );

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.openai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.openai.model,
        messages,
        temperature: 0.2,
        max_tokens: config.llmQuota.maxOutputTokens,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API ${res.status}: ${body.slice(0, 500)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim();

    console.log(
      `[OpenAI] response ${text?.length ?? 0} chars: ${text?.slice(0, 200)}`,
    );

    if (!text) {
      throw new Error("OpenAI API returned empty response");
    }

    return {
      text,
      provider: "openai",
      model: data.model || config.openai.model,
      providerRequestId: data.id || null,
      usage: {
        inputTokens: Number(data.usage?.prompt_tokens || 0),
        outputTokens: Number(data.usage?.completion_tokens || 0),
        // OpenAI prompt_tokens already includes cached prompt tokens.
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: Number(data.usage?.total_tokens || 0),
        measured: Boolean(data.usage),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
