import {
  BROWSER_CHAT_CACHE_NAMES, BROWSER_CHAT_CLOSE_GRACE_MS, BROWSER_CHAT_IDLE_MS,
  BROWSER_CHAT_MODEL_URL, BROWSER_CHAT_WASM_URL, BROWSER_CHAT_WEIGHT_BYTES,
  isOwnedBrowserChatAsset,
} from './browserChatConfig.js';

export type BrowserChatState = 'idle' | 'checking' | 'unsupported' | 'loading' | 'ready' | 'generating' | 'error';
export type BrowserChatSnapshot = {
  state: BrowserChatState;
  progress: number;
  message: string;
  cached: boolean;
  supported: boolean | null;
};
export type BrowserChatInput = {
  question: string;
  evidence: string;
  pageLabel?: string;
  history?: Array<{ role: string; content: string; state?: string }>;
};
export type BrowserChatResult = {
  text: string;
  elapsedMs: number;
  firstTokenMs: number | null;
  tokensPerSecond?: number;
  outputTokens?: number;
  inputTokens?: number;
};
type BrowserChatCallbacks = { onChunk: (delta: string) => void; signal?: AbortSignal };
type PendingRequest = { resolve: (result: unknown) => void; reject: (error: Error) => void; onChunk?: (delta: string) => void; cleanup?: () => void; timer?: ReturnType<typeof setTimeout> };
type GPUAdapterLike = { features?: { has: (feature: string) => boolean }; limits?: { maxStorageBufferBindingSize?: number } };
type BrowserEnvironment = {
  navigator?: { gpu?: { requestAdapter: (options?: { powerPreference: string }) => Promise<GPUAdapterLike | null> }; storage?: { estimate: () => Promise<{ quota?: number; usage?: number }> }; deviceMemory?: number };
  isSecureContext?: boolean;
  Worker?: typeof Worker;
  caches?: CacheStorage;
};
type RuntimeOptions = { workerFactory?: () => Worker; environment?: BrowserEnvironment };

export const INITIAL_BROWSER_CHAT_SNAPSHOT: BrowserChatSnapshot = {
  state: 'idle', progress: 0, message: 'Browser AI is optional. Download the model to start.', cached: false, supported: null,
};

function aborted() { return new DOMException('Browser AI was stopped.', 'AbortError'); }

/** No worker, model request, or third-party network call is made by constructing this class. */
export class BrowserChatRuntime {
  private snapshot: BrowserChatSnapshot = { ...INITIAL_BROWSER_CHAT_SNAPSHOT };
  private listeners = new Set<() => void>();
  private worker: Worker | null = null;
  private pending = new Map<number, PendingRequest>();
  private sequence = 0;
  private lifecycle = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private supportPromise: Promise<BrowserChatSnapshot> | null = null;
  private loadPromise: Promise<void> | null = null;
  private clearingCache = false;
  private disposed = false;
  private environment: BrowserEnvironment;
  private workerFactory: () => Worker;

  constructor(options: RuntimeOptions = {}) {
    this.environment = options.environment ?? (globalThis as unknown as BrowserEnvironment);
    // This static URL is required for Next/Turbopack to emit a separate Worker chunk.
    this.workerFactory = options.workerFactory ?? (() => new Worker(new URL('./browserChat.worker.ts', import.meta.url), { type: 'module', name: 'edgar-browser-ai' }));
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<BrowserChatSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  checkSupport(): Promise<BrowserChatSnapshot> {
    if (!this.supportPromise) {
      this.supportPromise = this.performSupportCheck().finally(() => { this.supportPromise = null; });
    }
    return this.supportPromise;
  }

  private async performSupportCheck(): Promise<BrowserChatSnapshot> {
    if (this.disposed) throw aborted();
    if (this.snapshot.state === 'loading' || this.snapshot.state === 'ready' || this.snapshot.state === 'generating') return this.snapshot;
    const generation = this.lifecycle;
    this.update({ state: 'checking', message: 'Checking this browser’s graphics support…' });
    try {
      const { navigator, Worker: WorkerClass, isSecureContext } = this.environment;
      if (!isSecureContext || !WorkerClass || !navigator?.gpu) throw new Error('This browser cannot run Browser AI. Use Data answers, or try a browser with WebGPU and hardware acceleration.');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const adapter = await Promise.race([
        navigator.gpu.requestAdapter({ powerPreference: 'low-power' }),
        new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 5000); }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      if (!adapter) throw new Error('No compatible graphics device was found. Data answers remain available.');
      if (!adapter.features?.has('shader-f16')) throw new Error('This graphics device lacks the support required for the small model. Data answers remain available.');
      if ((adapter.limits?.maxStorageBufferBindingSize ?? 0) < 256 * 1024 * 1024) throw new Error('This graphics device cannot allocate enough model memory. Data answers remain available.');
      if (navigator.deviceMemory && navigator.deviceMemory < 4) throw new Error('This device has too little memory for the browser model. Data answers remain available.');
      const cached = await this.inspectCache();
      if (generation !== this.lifecycle || this.disposed) throw aborted();
      this.update({ state: 'idle', supported: true, cached, message: cached ? 'Model files are saved in this browser. Load the model to start.' : 'Compatible browser. About 1 GB will be downloaded and saved on this device.' });
    } catch (error) {
      if (generation !== this.lifecycle || this.disposed) throw aborted();
      this.update({ state: 'unsupported', supported: false, message: error instanceof Error ? error.message : 'Browser AI is unavailable on this device. Data answers remain available.' });
    }
    return this.snapshot;
  }

  private async inspectCache(): Promise<boolean> {
    const storage = this.environment.caches;
    if (!storage) return false;
    try {
      const required = [BROWSER_CHAT_WASM_URL, `${BROWSER_CHAT_MODEL_URL}mlc-chat-config.json`, `${BROWSER_CHAT_MODEL_URL}tokenizer.json`, `${BROWSER_CHAT_MODEL_URL}ndarray-cache.json`, ...Array.from({ length: 30 }, (_, index) => `${BROWSER_CHAT_MODEL_URL}params_shard_${index}.bin`)];
      const keys = new Set<string>();
      for (const name of await storage.keys()) {
        if (!BROWSER_CHAT_CACHE_NAMES.includes(name)) continue;
        for (const request of await (await storage.open(name)).keys()) keys.add(request.url);
      }
      return required.every(url => keys.has(url));
    } catch { return false; }
  }

  private ensureWorker() {
    if (this.worker) return;
    const worker = this.workerFactory();
    this.worker = worker;
    worker.onmessage = event => {
      if (this.worker !== worker || this.disposed) return;
      const { id, type, ...data } = event.data || {};
      const request = this.pending.get(id);
      if (!request) return;
      if (type === 'progress') { this.update({ progress: Math.max(0, Math.min(1, Number(data.progress) || 0)), message: String(data.message || 'Loading model…').slice(0, 240) }); return; }
      if (type === 'chunk') {
        try { request.onChunk?.(String(data.text || '')); }
        catch (error) {
          this.terminate(error instanceof Error ? error : new Error('Answer interrupted.'));
          this.update({ state: 'error', message: 'The answer was interrupted. Use Data answers or reload the saved model.' });
        }
        return;
      }
      this.pending.delete(id);
      request.cleanup?.();
      if (request.timer) clearTimeout(request.timer);
      if (type === 'error') {
        const error = data.aborted ? aborted() : new Error(String(data.message || 'Browser AI could not finish. Data answers remain available.'));
        request.reject(error);
      } else request.resolve(data.result);
    };
    worker.onerror = () => {
      if (this.worker !== worker) return;
      this.terminate(new Error('The browser model stopped unexpectedly. Data answers remain available.'));
      this.update({ state: 'error', message: 'The browser model stopped unexpectedly. Try loading it again or use Data answers.' });
    };
  }

  private request(type: string, payload: unknown, options: { onChunk?: (delta: string) => void; signal?: AbortSignal; timeoutMs: number }) {
    this.ensureWorker();
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const request: PendingRequest = { resolve, reject, onChunk: options.onChunk };
      const onAbort = () => this.interrupt();
      request.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      request.timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        const message = type === 'load' ? 'Model download took too long. Retry on a stable connection or use Data answers.' : 'This answer took too long on this device. Data answers remain available.';
        this.terminate(new Error(message));
        this.update({ state: 'error', progress: 0, message });
      }, options.timeoutMs);
      this.pending.set(id, request);
      options.signal?.addEventListener('abort', onAbort, { once: true });
      if (options.signal?.aborted) { this.terminate(aborted()); return; }
      this.worker!.postMessage({ id, type, payload });
    });
  }

  /** Call only in response to a user's explicit Download/Load action. */
  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.performLoad().finally(() => { this.loadPromise = null; });
    return this.loadPromise;
  }
  private async performLoad(): Promise<void> {
    if (this.disposed) throw aborted();
    if (this.clearingCache) throw new Error('Please wait for the saved model files to be removed.');
    this.retain();
    if (this.snapshot.state === 'ready' || this.snapshot.state === 'generating') return;
    if (this.snapshot.state === 'loading') throw new Error('The model is already loading.');
    if (!this.snapshot.supported) await this.checkSupport();
    if (!this.snapshot.supported) throw new Error(this.snapshot.message);
    const generation = this.lifecycle;
    try {
      const estimate = await this.environment.navigator?.storage?.estimate().catch(() => undefined);
      if (generation !== this.lifecycle || this.disposed) throw aborted();
      if (!this.snapshot.cached && estimate?.quota && estimate.quota - (estimate.usage || 0) < BROWSER_CHAT_WEIGHT_BYTES * 1.15) throw new Error('There is not enough available browser storage for this model. Free about 1.2 GB or use Data answers.');
      this.update({ state: 'loading', progress: 0, message: this.snapshot.cached ? 'Loading saved model files…' : 'Downloading the model to this device…' });
      await this.request('load', {}, { timeoutMs: 15 * 60 * 1000 });
      if (generation !== this.lifecycle || this.disposed) throw aborted();
      this.update({ state: 'ready', progress: 1, cached: true, message: 'Qwen3 is ready on this device.' });
      this.scheduleIdle();
    } catch (error) {
      if (generation !== this.lifecycle || this.disposed || (error instanceof Error && error.name === 'AbortError')) throw error;
      this.terminate(error instanceof Error ? error : new Error('Model loading failed.'));
      this.update({ state: 'error', message: error instanceof Error ? error.message : 'Model loading failed. Use Data answers.' });
      throw error;
    }
  }

  async generate(input: BrowserChatInput, callbacks: BrowserChatCallbacks): Promise<BrowserChatResult> {
    if (this.disposed) throw aborted();
    if (callbacks.signal?.aborted) throw aborted();
    if (this.snapshot.state !== 'ready') throw new Error('Load Browser AI first, or use Data answers.');
    this.retain();
    const generation = this.lifecycle;
    this.update({ state: 'generating', message: 'Writing an answer on this device…' });
    try {
      const result = await this.request('generate', input, { ...callbacks, timeoutMs: 120000 }) as BrowserChatResult;
      if (generation !== this.lifecycle || this.disposed) throw aborted();
      return result;
    } finally {
      if (generation === this.lifecycle && !this.disposed) {
        if (this.stopTimer) clearTimeout(this.stopTimer);
        this.stopTimer = null;
        this.update({ state: this.worker ? 'ready' : 'idle', message: this.worker ? 'Qwen3 is ready on this device.' : 'Model released. Load it again to continue.' });
        this.scheduleIdle();
      }
    }
  }

  interrupt() {
    if (this.snapshot.state === 'loading' || this.snapshot.state === 'checking') {
      this.terminate(aborted());
      this.update({ state: 'idle', progress: 0, message: 'Loading cancelled. Any completed model files can be reused.' });
    } else if (this.snapshot.state === 'generating') {
      this.worker?.postMessage({ type: 'interrupt' });
      if (this.stopTimer) clearTimeout(this.stopTimer);
      this.stopTimer = setTimeout(() => {
        this.terminate(aborted());
        this.update({ state: 'idle', message: 'Answer stopped. Load the saved model to continue.' });
      }, 2000);
    }
  }

  retain() {
    this.clearRelease();
    if (this.worker && this.snapshot.state === 'ready') this.scheduleIdle();
  }
  private clearRelease() {
    if (this.releaseTimer) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
  }
  private scheduleIdle() { if (!this.releaseTimer) this.release({ delayMs: BROWSER_CHAT_IDLE_MS }); }
  release({ delayMs = BROWSER_CHAT_CLOSE_GRACE_MS }: { delayMs?: number } = {}) {
    this.clearRelease();
    if (this.snapshot.state === 'loading' || this.snapshot.state === 'checking') { this.interrupt(); return; }
    if (!this.worker) return;
    // Closing the panel stops ongoing computation immediately; memory gets a grace period.
    if (this.snapshot.state === 'generating') this.interrupt();
    const release = () => {
      this.terminate(aborted());
      this.update({ state: 'idle', progress: 0, message: 'Model memory released. Saved files remain on this device.' });
    };
    if (delayMs <= 0) release();
    else this.releaseTimer = setTimeout(release, delayMs);
  }

  async clearCache(): Promise<void> {
    if (this.clearingCache) return;
    this.terminate(aborted());
    this.clearingCache = true;
    this.update({ state: 'idle', progress: 0, message: 'Removing saved model files…' });
    try {
      const storage = this.environment.caches;
      if (storage) {
        for (const name of await storage.keys()) {
          if (!BROWSER_CHAT_CACHE_NAMES.includes(name)) continue;
          const cache = await storage.open(name);
          for (const request of await cache.keys()) if (isOwnedBrowserChatAsset(request.url)) await cache.delete(request);
        }
      }
      this.update({ state: 'idle', cached: false, progress: 0, message: 'Browser AI model files removed. Your other site data is unchanged.' });
    } catch {
      this.update({ state: 'error', message: 'This browser could not remove all saved model files. Clear this site’s storage in browser settings to remove the download.' });
      throw new Error(this.snapshot.message);
    } finally {
      this.clearingCache = false;
    }
  }

  private terminate(error: Error) {
    this.lifecycle += 1;
    this.clearRelease();
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.worker?.terminate();
    this.worker = null;
    for (const request of this.pending.values()) {
      request.cleanup?.();
      if (request.timer) clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  dispose() { this.terminate(aborted()); this.disposed = true; this.listeners.clear(); }
}
