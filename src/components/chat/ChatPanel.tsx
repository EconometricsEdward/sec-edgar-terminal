"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { usePathname, useSearchParams } from "next/navigation";
import { ArrowUp, BookOpen, MessageSquare, Plus, Square, X } from "lucide-react";
import { getChatStarters } from "../../utils/chatContext.js";
import ChatMessage, { type ChatMessageData, type ChatMode, type ChatEngine } from "./ChatMessage";
import { buildChatMessages, CHAT_ANSWER_LIMIT, CHAT_HISTORY_LIMIT, CHAT_USER_LIMIT, chatRetrySeconds, cleanChatSources, readChatStream } from "./chatClient.js";
import styles from "./Chat.module.css";
import { chatPageSelection } from "./chatPageSelection.js";
import { normalizeSharedChatContext } from "../../utils/chatSharedContext.js";
import { useBrowserChat } from "./useBrowserChat";
import BrowserChatSetup from "./BrowserChatSetup";

type Props = { open: boolean; onClose: () => void; triggerRef: RefObject<HTMLButtonElement | null>; attachment?: { snapshot: NonNullable<ReturnType<typeof normalizeSharedChatContext>>; route: string } | null; onClearAttachment?: () => void };
type ActiveRequest = { id: string; controller: AbortController; content: string; frame: number | null };
type ChatFailure = Error & { retryAfter?: number };

export default function ChatPanel({ open, onClose, triggerRef, attachment, onClearAttachment }: Props) {
  const path = usePathname();
  const search = useSearchParams();
  useSyncExternalStore(chatPageSelection.subscribe, chatPageSelection.getSnapshot, () => null);
  const context = chatPageSelection.resolve({ path, query: search.toString() });
  const pageEntity = context.company || context.fund || context.managerCik;
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<ChatMode>("fast");
  const [engine, setEngine] = useState<ChatEngine>("data");
  const local = useBrowserChat(engine === "browser", open);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [retryTimes, setRetryTimes] = useState({ hosted: 0, research: 0 });
  const retryUntil = retryTimes[engine === "hosted" ? "hosted" : "research"];
  const [clock, setClock] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const keepAtBottom = useRef(true);
  const messagesRef = useRef<ChatMessageData[]>([]);
  const active = useRef<ActiveRequest | null>(null);
  const route = `${path}${search.size ? `?${search}` : ''}`;
  const attached = attachment?.route === route ? attachment.snapshot : null;
  useEffect(() => {
    if (attachment && attachment.route !== window.location.pathname + window.location.search) onClearAttachment?.();
  }, [attachment, route, onClearAttachment]);

  const updateMessages = useCallback((update: (previous: ChatMessageData[]) => ChatMessageData[]) => {
    const next = update(messagesRef.current).slice(-CHAT_HISTORY_LIMIT);
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const stop = useCallback(() => {
    const request = active.current;
    if (!request) return;
    active.current = null;
    if (request.frame !== null) cancelAnimationFrame(request.frame);
    request.controller.abort();
    updateMessages(previous => previous.map(message => message.id === request.id ? { ...message, content: request.content, state: "stopped" } : message));
    setBusy(false);
    setStatus("");
  }, [updateMessages]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout>;
    const finishClose = () => {
      if (!dialog.open) return;
      dialog.close();
      triggerRef.current?.focus({ preventScroll: true });
    };
    if (open) {
      if (!dialog.open) dialog.showModal();
      // Allow the closed position to paint before changing its transition target.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => { dialog.dataset.visible = "true"; });
      });
    } else {
      stop();
      dialog.dataset.visible = "false";
      const preference = document.documentElement.dataset.readingMotion;
      const reduced = preference === "reduced" || (preference !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
      timer = setTimeout(finishClose, reduced ? 0 : 260);
    }
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); };
  }, [open, stop, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [open]);

  useEffect(() => () => {
    const request = active.current;
    if (request?.frame !== null && request?.frame !== undefined) cancelAnimationFrame(request.frame);
    request?.controller.abort();
  }, []);

  useEffect(() => {
    if (!retryUntil || retryUntil <= Date.now()) return;
    setClock(Date.now());
    const interval = setInterval(() => {
      const now = Date.now();
      setClock(now);
      if (now >= retryUntil) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [retryUntil]);

  useEffect(() => {
    if (open && keepAtBottom.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, status, open]);

  const send = async (question: string, previous = messagesRef.current) => {
    const content = question.trim().slice(0, CHAT_USER_LIMIT);
    if (!content || active.current || Date.now() < retryUntil) return;
    // Read the URL at send time, including client-side navigation since opening.
    const current = chatPageSelection.resolve({ path: window.location.pathname, query: window.location.search });
    const sharedContext = attachment?.route === window.location.pathname + window.location.search ? attachment.snapshot : null;
    const requestMode = mode;
    const requestEngine = engine;
    const started = performance.now();
    const userMessage: ChatMessageData = { id: crypto.randomUUID(), role: "user", content };
    const answerId = crypto.randomUUID();
    const conversation = [...previous, userMessage];
    const request: ActiveRequest = { id: answerId, controller: new AbortController(), content: "", frame: null };
    active.current = request;
    keepAtBottom.current = true;
    updateMessages(() => [...conversation, { id: answerId, role: "assistant", content: "", page: current.label, engine: requestEngine, ...(requestEngine === "hosted" ? { mode: requestMode } : {}), state: "streaming" }]);
    setDraft("");
    setBusy(true);
    setStatus(requestEngine === "hosted" ? "Connecting to EDGAR Terminal…" : "Preparing a research snapshot…");
    const patchAnswer = (patch: Partial<ChatMessageData>) => {
      if (active.current !== request) return;
      updateMessages(items => items.map(message => message.id === answerId ? { ...message, ...patch } : message));
    };
    const flushText = () => {
      request.frame = null;
      patchAnswer({ content: request.content });
    };
    try {
      const response = await fetch(requestEngine === "hosted" ? "/api/chat" : "/api/chat/research", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: requestEngine === "hosted" ? "application/x-ndjson" : "application/json" },
        body: JSON.stringify({ messages: buildChatMessages(conversation), context: { path: current.path, query: current.query }, mode: requestMode, ...(sharedContext ? { sharedContext } : {}) }),
        signal: request.controller.signal,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const failure: ChatFailure = new Error(typeof detail.error === "string" ? detail.error.slice(0, 500) : "Chat is temporarily unavailable. Please try again shortly.");
        failure.retryAfter = chatRetrySeconds(response.headers.get("Retry-After")) || chatRetrySeconds(detail.retryAfter);
        throw failure;
      }
      if (requestEngine !== "hosted") {
        const research = await response.json();
        if (typeof research.answer !== "string" || !research.answer.trim() || research.answer.length > CHAT_ANSWER_LIMIT
          || typeof research.evidence !== "string" || research.evidence.length > 8000) throw new Error("The research snapshot could not be read. Please try again.");
        patchAnswer({ sources: cleanChatSources(research.sources) });
        const instance = local.runtime.current;
        if (requestEngine === "browser" && instance?.getSnapshot().state === "ready" && research.status === "ready") {
          setStatus("Qwen is reading the research on your device…");
          patchAnswer({ evidenceSnapshot: research.answer });
          try {
            const result = await instance.generate({ question: content, evidence: research.evidence,
              history: previous.slice(-6).map(({ role, content, state }) => ({ role, content, state })), pageLabel: current.label }, {
              signal: request.controller.signal,
              onChunk: (text: string) => {
                if (active.current !== request) return;
                request.content += text;
                if (request.content.length > CHAT_ANSWER_LIMIT) throw new Error("The browser answer reached its length limit.");
                setStatus("Writing on your device…");
                if (request.frame === null) request.frame = requestAnimationFrame(flushText);
              },
            });
            request.content = result.text;
            patchAnswer({ engine: "browser" });
          } catch (error) {
            if (request.controller.signal.aborted || active.current !== request) throw error;
            request.content = research.answer;
            patchAnswer({ engine: "data", notice: "Browser AI could not finish. Here is the research snapshot; no hosted AI was used." });
          }
        } else {
          request.content = research.answer;
          patchAnswer({ engine: "data", ...(requestEngine === "browser" ? { notice: research.status === "ready"
            ? "Browser AI is not loaded. This research snapshot uses no AI model."
            : "This request needs the clarification or data availability information below." } : {}) });
        }
        if (active.current !== request) return;
        if (request.frame !== null) cancelAnimationFrame(request.frame);
        patchAnswer({ content: request.content, state: "complete", elapsedMs: performance.now() - started });
        return;
      }
      if (!response.headers.get("Content-Type")?.includes("application/x-ndjson")) throw new Error("Chat returned an unexpected response. Please try again shortly.");
      await readChatStream(response.body, frame => {
        if (active.current !== request) return;
        if (frame.type === "status") setStatus(typeof frame.message === "string" ? frame.message.slice(0, 180) : "Reading the available data…");
        if (frame.type === "meta") {
          if (typeof frame.page?.label === "string") patchAnswer({ page: frame.page.label.slice(0, 100) });
          if (frame.mode === "fast" || frame.mode === "reasoning") patchAnswer({ mode: frame.mode });
        }
        if (frame.type === "sources") patchAnswer({ sources: cleanChatSources(frame.sources) });
        if (frame.type === "text") {
          if (request.content.length + frame.text.length > CHAT_ANSWER_LIMIT) throw new Error("The answer reached its length limit. Ask a more focused follow-up question.");
          request.content += frame.text;
          setStatus("Writing an answer…");
          if (request.frame === null) request.frame = requestAnimationFrame(flushText);
        }
        if (frame.type === "error") {
          const failure: ChatFailure = new Error(typeof frame.message === "string" ? frame.message.slice(0, 500) : "The answer was interrupted. Please try again.");
          failure.retryAfter = chatRetrySeconds(frame.retryAfter);
          throw failure;
        }
      });
      if (!request.content.trim()) throw new Error("No answer was received. Please try again.");
      if (request.frame !== null) cancelAnimationFrame(request.frame);
      patchAnswer({ content: request.content, state: "complete", elapsedMs: performance.now() - started });
    } catch (error) {
      if (active.current !== request) return;
      if (request.frame !== null) cancelAnimationFrame(request.frame);
      const failure = error as ChatFailure;
      if (failure.retryAfter && failure.retryAfter > 0) {
        setRetryTimes(previous => ({ ...previous, [requestEngine === "hosted" ? "hosted" : "research"]: Date.now() + failure.retryAfter! * 1000 }));
        setClock(Date.now());
      }
      patchAnswer({ content: request.content, state: "error", error: `${request.content ? "This answer is incomplete. " : ""}${failure.message || "Chat could not connect. Please try again."}` });
    } finally {
      if (active.current === request) {
        active.current = null;
        setBusy(false);
        setStatus("");
      }
    }
  };

  const cooldown = Math.max(0, Math.ceil((retryUntil - clock) / 1000));
  const latest = messages.at(-1);
  const retry = () => {
    const history = messagesRef.current;
    const index = history.findLastIndex(message => message.role === "user");
    if (index >= 0) void send(history[index].content, history.slice(0, index));
  };

  return createPortal(
    <dialog
      id="edgar-chat"
      ref={dialogRef}
      className={styles.dialog}
      aria-modal="true"
      aria-labelledby="edgar-chat-title"
      aria-describedby="edgar-chat-description"
      data-visible="false"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])')).filter(element => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}
      onClick={event => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <span className={styles.brandIcon}><MessageSquare size={20} aria-hidden="true" /></span>
          <div className={styles.heading}>
            <span>RESEARCH ASSISTANT</span>
            <h2 id="edgar-chat-title">Chat with EDGAR Terminal</h2>
          </div>
          <button type="button" className={styles.iconButton} aria-label="Close chat" onClick={onClose} autoFocus><X size={21} aria-hidden="true" /></button>
        </header>
        <div className={styles.contextBar}>
          <span><BookOpen size={14} aria-hidden="true" /> On <strong>{context.label}</strong>{pageEntity ? ` · ${pageEntity}` : ""}</span>
          <button type="button" onClick={() => { stop(); updateMessages(() => []); setDraft(""); onClearAttachment?.(); inputRef.current?.focus(); }} disabled={!messages.length && !draft && !attached}><Plus size={14} aria-hidden="true" /> New chat</button>
        </div>
        <fieldset className={styles.engineChoice} disabled={busy} aria-describedby="edgar-engine-help">
          <legend className={styles.visuallyHidden}>Research assistant engine</legend>
          {(["data", "browser", "hosted"] as const).map(value => <label key={value} className={styles.engineOption}>
            <input className={styles.visuallyHidden} type="radio" name="edgar-chat-engine" checked={engine === value} onChange={() => setEngine(value)} />
            <span>{value === "data" ? "Data answers" : value === "browser" ? "Browser AI" : "Hosted AI"}<small>{value === "data" ? "No model needed" : value === "browser" ? "On your device · Pilot" : "Shared allowance"}</small></span>
          </label>)}
        </fieldset>
        {attached ? <div className={styles.attachment}>
          <span><strong>{attached.kind === 'portfolio' ? `${attached.holdings.length} of ${attached.totalHoldings} tickers attached` : `${attached.ticker} scenario · ${attached.end}`}</strong><small>{attached.kind === 'portfolio' ? 'User-provided tickers and modeled weights only.' : 'Applied hypothetical assumptions; financial baseline will be checked.'} Snapshot stays attached on this page until removed.</small></span>
          <button type="button" className={styles.iconButton} aria-label="Remove shared selection" onClick={onClearAttachment}><X size={16} aria-hidden="true" /></button>
        </div> : null}
        <div ref={scrollRef} className={styles.conversation} role="region" aria-label="Chat conversation" tabIndex={0} onScroll={event => {
          const element = event.currentTarget;
          keepAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
        }}>
          <p id="edgar-engine-help" className={styles.engineHelp}>{engine === "data" ? "Structured facts and page guidance from EDGAR Terminal. No AI model or download." : engine === "browser" ? "A small local model explains a prepared research snapshot. Quality and speed depend on your device." : "The existing research AI, including cross-page tools. Uses the site's shared AI allowance."}</p>
          {engine === "browser" ? <BrowserChatSetup snapshot={local.snapshot} onLoad={local.load} onCancel={local.cancel} onClear={local.clear} busy={busy} /> : null}
          {!messages.length ? (
            <div className={styles.empty}>
              <span className={styles.eyebrow}>A CLEARER VIEW OF THE DATA</span>
              <h3>Ask a question.<br /><em>Follow the evidence.</em></h3>
              <p id="edgar-chat-description">Explore a company, fund, or market. Start with source-backed facts, or choose an AI explanation.</p>
              <div className={styles.starters}>{getChatStarters(context).map(question => (
                <button key={question} type="button" onClick={() => { setDraft(question); inputRef.current?.focus(); }}><span>{question}</span><ArrowUp size={15} aria-hidden="true" /></button>
              ))}</div>
              <p className={styles.scope}>Answers use available public research and show supporting data. Reporting periods can differ, and missing data stays missing.</p>
            </div>
          ) : (
            <>
              <p id="edgar-chat-description" className={styles.visuallyHidden}>EDGAR Terminal research assistant. Answers use available public research and supporting data.</p>
              <div className={styles.messageList}>{messages.map(message => <ChatMessage key={message.id} message={message} />)}</div>
            </>
          )}
          {busy ? <p className={styles.progress} role="status"><span className={styles.pulse} />{status || "Reading the available data…"}</p> : null}
          <p className={styles.visuallyHidden} role="status">{!busy && latest?.state === "complete" ? "Answer ready. Review the answer and supporting data above." : !busy && latest?.state === "stopped" ? "Answer generation stopped." : ""}</p>
          {!busy && latest?.state === "error" ? <button type="button" className={styles.retry} disabled={cooldown > 0} onClick={retry}>Try this question again</button> : null}
        </div>
        <form className={styles.composer} onSubmit={event => { event.preventDefault(); void send(draft); }}>
          {engine === "hosted" ? <div className={styles.modeControls}>
            <fieldset className={styles.modeChoice} aria-describedby="edgar-chat-mode-help" disabled={busy}>
              <legend className={styles.visuallyHidden}>Answer mode</legend>
              {(["fast", "reasoning"] as const).map(value => (
                <label key={value} className={styles.modeOption}>
                  <input className={styles.visuallyHidden} type="radio" name="edgar-chat-mode" value={value} checked={mode === value} disabled={busy} onChange={() => setMode(value)} />
                  <span>{value === "reasoning" ? "Reasoning" : "Fast"}</span>
                </label>
              ))}
            </fieldset>
            <p id="edgar-chat-mode-help" className={styles.modeHelp}>{mode === "reasoning" ? "Takes longer; useful for comparisons and analysis." : "Quick answers from the available data."}</p>
          </div> : <p className={styles.modeHelp}>{engine === "browser" && local.snapshot.state === "ready" ? "Qwen3-1.7B · Ready on your device · No hosted AI charge" : "Data lookups have short rate limits to keep the site responsive."}</p>}
          <div className={styles.inputBox}>
            <label htmlFor="edgar-chat-question" className={styles.visuallyHidden}>Ask EDGAR Terminal</label>
            <textarea id="edgar-chat-question" ref={inputRef} value={draft} rows={3} maxLength={CHAT_USER_LIMIT} placeholder={`Ask about ${pageEntity || context.label.toLowerCase()}…`} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!busy) void send(draft); }
            }} />
            <div className={styles.composerActions}>
              <span>{draft.length > 1700 ? `${draft.length.toLocaleString()} / 2,000` : "Enter to send · Shift + Enter for a new line"}</span>
              {busy ? <button type="button" className={styles.send} onClick={stop} aria-label="Stop generating answer"><Square size={15} aria-hidden="true" /> Stop</button> : <button type="submit" className={styles.send} disabled={!draft.trim() || cooldown > 0} aria-label="Send question"><ArrowUp size={18} aria-hidden="true" /></button>}
            </div>
          </div>
          {cooldown > 0 ? <p className={styles.cooldown} role="status">Please wait {cooldown >= 60 ? `${Math.ceil(cooldown / 60)} minute${cooldown > 60 ? "s" : ""}` : `${cooldown} second${cooldown !== 1 ? "s" : ""}`} before sending another question.</p> : null}
          {!busy && engine === "hosted" && (cooldown > 0 || latest?.state === "error") ? <button type="button" className={styles.retry} onClick={() => { setEngine("data"); setDraft(messagesRef.current.findLast(message => message.role === "user")?.content || ""); }}>Continue with data answers</button> : null}
          <p className={styles.privacy}>{engine === "hosted" ? "Your message, page selections and attached snapshot are sent to the AI service." : "Your question, recent conversation, page selections and attached snapshot go to EDGAR Terminal for data retrieval. Browser AI writes its answer on your device."} Do not enter sensitive information. Conversation stays in this tab and clears on reload. Check dates and supporting data.</p>
        </form>
      </div>
    </dialog>,
    document.body,
  );
}
