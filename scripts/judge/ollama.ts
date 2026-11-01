/**
 * Minimal Ollama chat client for the judge: one non-streaming /api/chat call that asks for
 * JSON matching a schema. Thinking is off and temperature 0, so a rerun with the same seed
 * reproduces the grades as far as Ollama itself is deterministic.
 */

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
  fetchImpl?: FetchLike;
}

interface ChatResponse {
  message?: { content?: string };
  error?: string;
}

export function ollamaChat(opts: OllamaOptions): Chat {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
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
        think: false,
        format: opts.schema,
        options: { temperature: 0, seed: opts.seed, num_ctx: opts.numCtx ?? 16384 },
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
    const content = parsed.message?.content;
    if (typeof content !== "string") throw new Error(`ollama response has no message.content: ${text.slice(0, 300)}`);
    return content;
  };
}
