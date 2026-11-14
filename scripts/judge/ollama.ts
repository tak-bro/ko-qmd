/**
 * Minimal Ollama chat client for the judge: one non-streaming /api/chat call that asks for
 * JSON matching a schema. Thinking is off unless `think` is set, and temperature is 0, so a rerun
 * with the same seed reproduces the grades as far as Ollama itself is deterministic.
 *
 * Ollama silently drops the start of a prompt longer than num_ctx, and the reply can still pass
 * validation with the rubric gone. A prompt that fills the window is therefore an error.
 */

export const DEFAULT_NUM_CTX = 32768;

export type Chat = (system: string, user: string) => Promise<string>;

/** The slice of `fetch` the client uses — narrow so tests can pass a plain function. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<Response>;

export interface OllamaOptions {
  host: string;
  model: string;
  schema: object;
  seed: number;
  numCtx?: number;
  /** Let a thinking model reason before the JSON reply (default off). The reasoning is not returned. */
  think?: boolean;
  fetchImpl?: FetchLike;
}

interface ChatResponse {
  message?: { content?: string };
  error?: string;
  prompt_eval_count?: number;
}

export function ollamaChat(opts: OllamaOptions): Chat {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
  return async (system, user) => {
    const res = await doFetch(`${opts.host.replace(/\/$/, "")}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        stream: false,
        think: opts.think ?? false,
        format: opts.schema,
        options: { temperature: 0, seed: opts.seed, num_ctx: numCtx },
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`ollama ${res.status}: ${text.slice(0, 300)}`);
    let parsed: ChatResponse;
    try {
      parsed = JSON.parse(text) as ChatResponse;
    } catch (err) {
      throw new Error(`ollama returned non-JSON: ${text.slice(0, 300)}`, { cause: err });
    }
    if (parsed.error) throw new Error(`ollama: ${parsed.error}`);
    // Truncation keeps the prompt just under the window, so anything at 95% of it is suspect.
    // Without the count, truncation cannot be ruled out, so a reply without it is not trusted.
    if (typeof parsed.prompt_eval_count !== "number") {
      throw new Error(`ollama response has no prompt_eval_count, so prompt truncation cannot be checked: ${text.slice(0, 300)}`);
    }
    if (parsed.prompt_eval_count >= numCtx * 0.95) {
      throw new Error(`prompt filled the context (${parsed.prompt_eval_count} tokens, num_ctx ${numCtx}) — Ollama may have cut it`);
    }
    const content = parsed.message?.content;
    if (typeof content !== "string") throw new Error(`ollama response has no message.content: ${text.slice(0, 300)}`);
    return content;
  };
}
