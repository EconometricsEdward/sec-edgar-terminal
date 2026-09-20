import { MLCEngine } from '@mlc-ai/web-llm';
import type { AppConfig, ChatCompletionMessageParam, CompletionUsage } from '@mlc-ai/web-llm';
import { Tokenizer } from '@huggingface/tokenizers';
import {
  BROWSER_CHAT_APP_CONFIG, BROWSER_CHAT_CONTEXT_TOKENS,
  BROWSER_CHAT_MAX_OUTPUT_TOKENS, BROWSER_CHAT_MODEL, BROWSER_CHAT_MODEL_URL,
  buildBrowserChatMessages, browserChatVisibleText,
} from './browserChatConfig.js';
import type { BrowserChatInput } from './browserChatRuntime';

// A dedicated worker keeps WebGPU scheduling and tokenization off the page's UI thread.
// It accepts evidence only. There are no tools, server inference calls, or arbitrary URLs.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};
let engine: MLCEngine | null = null;
let tokenizer: Tokenizer | null = null;
let loading = false;
let generating = false;
let interrupted = false;

function post(id: number, type: string, data: Record<string, unknown> = {}) { scope.postMessage({ id, type, ...data }); }

async function load(id: number) {
  if (loading || generating) throw new Error('The browser model is busy.');
  if (engine && tokenizer) return;
  loading = true;
  try {
    engine = new MLCEngine({
      appConfig: BROWSER_CHAT_APP_CONFIG as AppConfig,
      logLevel: 'SILENT',
      initProgressCallback: report => post(id, 'progress', { progress: report.progress, message: report.text }),
    });
    await engine.reload(BROWSER_CHAT_MODEL, { context_window_size: BROWSER_CHAT_CONTEXT_TOKENS });
    // Reuse the exact tokenizer already downloaded by WebLLM. This second instance
    // permits exact prompt bounds through a public API, without accessing internals.
    const url = `${BROWSER_CHAT_MODEL_URL}tokenizer.json`;
    const response = await caches.match(url);
    if (!response) throw new Error('The model tokenizer was not saved by this browser. Use Data answers or allow browser storage and try again.');
    // Special tokens are added by WebLLM's conversation template, accounted for in
    // buildBrowserChatMessages. The BPE vocabulary and split rules are in this JSON.
    tokenizer = new Tokenizer(await response.json(), {});
  } finally { loading = false; }
}

async function generate(id: number, input: BrowserChatInput) {
  if (!engine || !tokenizer || loading) throw new Error('Load Browser AI before asking a question.');
  if (generating) throw new Error('Please stop the current answer before asking another question.');
  const { messages } = buildBrowserChatMessages(input, text => tokenizer!.encode(text, { add_special_tokens: false }).ids.length);
  generating = true;
  interrupted = false;
  const started = performance.now();
  let firstTokenMs: number | null = null;
  let raw = '';
  let visible = '';
  let usage: CompletionUsage | undefined;
  let shortened = false;
  try {
    // Reset between requests: bounded history is supplied explicitly and never grows
    // in a hidden KV session. All arithmetic and evidence retrieval stay in the site.
    await engine.resetChat();
    const stream = await engine.chat.completions.create({
      messages: messages as ChatCompletionMessageParam[],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: BROWSER_CHAT_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
      top_p: 0.8,
      repetition_penalty: 1.05,
      extra_body: { enable_thinking: false },
    });
    for await (const chunk of stream) {
      if (interrupted) break;
      if (chunk.usage) usage = chunk.usage;
      if (chunk.choices.some(choice => choice.finish_reason === 'length')) shortened = true;
      raw += chunk.choices[0]?.delta.content || '';
      const next = browserChatVisibleText(raw);
      if (next.length > visible.length) {
        if (firstTokenMs === null) firstTokenMs = performance.now() - started;
        post(id, 'chunk', { text: next.slice(visible.length) });
        visible = next;
      }
    }
    if (interrupted) throw new DOMException('Browser AI was stopped.', 'AbortError');
    if (shortened) throw new Error('The browser model reached its answer limit. Data answers show the complete results.');
    if (!visible.trim()) throw new Error('The browser model did not produce an answer. Data answers remain available.');
    return {
      text: visible,
      elapsedMs: Math.round(performance.now() - started),
      firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
      outputTokens: usage?.completion_tokens,
      inputTokens: usage?.prompt_tokens,
      tokensPerSecond: usage?.extra?.decode_tokens_per_s,
    };
  } finally { generating = false; }
}

scope.onmessage = event => {
  const { id, type, payload } = event.data || {};
  if (type === 'interrupt') {
    interrupted = true;
    void engine?.interruptGenerate().catch(() => undefined);
    return;
  }
  if (!Number.isSafeInteger(id)) return;
  void (async () => {
    try {
      let result: unknown;
      if (type === 'load') { await load(id); result = { ready: true }; }
      else if (type === 'generate') result = await generate(id, payload);
      else throw new Error('Unsupported browser model operation.');
      post(id, 'result', { result });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Browser AI could not finish. Data answers remain available.';
      post(id, 'error', { message: message.slice(0, 400), aborted: error instanceof Error && error.name === 'AbortError' });
    }
  })();
};
