"use client";

import { useState } from "react";
import { Download, Cpu, Trash2, CheckCircle2 } from "lucide-react";
import styles from "./Chat.module.css";

type Props = {
  snapshot: { state: string; progress: number; message: string; cached: boolean };
  onLoad: () => Promise<void>;
  onCancel: () => void;
  onClear: () => Promise<void>;
  busy: boolean;
};

export default function BrowserChatSetup({ snapshot, onLoad, onCancel, onClear, busy }: Props) {
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false);
  const loading = snapshot.state === "loading";
  const ready = snapshot.state === "ready" || snapshot.state === "generating";
  const unsupported = snapshot.state === "unsupported";
  const checking = snapshot.state === "checking";
  const progress = Math.round(Math.min(1, Math.max(0, snapshot.progress || 0)) * 100);
  const load = async () => { setError(""); try { await onLoad(); } catch (error) { if (!(error instanceof Error && error.name === "AbortError")) setError("Browser AI could not load. You can keep using data answers below."); } };
  const clear = async () => { setError(""); setClearing(true); try { await onClear(); } catch { setError("The model cache could not be fully removed. You can also clear this site's data in browser settings."); } finally { setClearing(false); } };
  return <section className={styles.browserSetup} aria-label="Browser AI setup">
    <div className={styles.browserTitle}>
      {ready ? <CheckCircle2 size={18} aria-hidden="true" /> : <Cpu size={18} aria-hidden="true" />}
      <div><strong>Qwen3-1.7B</strong><span>{ready ? "Ready on your device" : "An optional AI download"}</span></div>
      <span className={styles.pilotBadge}>PILOT</span>
    </div>
    {ready ? <p>Answers run locally. For complex research, Hosted AI remains available. Check figures against the research snapshot.</p>
      : <p>About 1 GB to download and roughly 2 GB of graphics memory. Uses your device’s processing power and battery. Best tried on a computer with an unmetered connection.</p>}
    {unsupported ? <p className={styles.setupNotice} role="status">{snapshot.message || "This device cannot run the pilot. Data answers are available below."}</p> : null}
    {loading ? <div className={styles.downloadProgress}>
      <progress value={progress} max={100} aria-label="Loading browser AI" />
      <span role="status">{snapshot.message || `Loading model · ${progress}%`}</span>
    </div> : null}
    {!ready && !loading && !unsupported ? <p className={styles.downloadNote}>Downloads from Hugging Face and the WebLLM project. Files are cached in this browser when space allows. No installation or AI account required.</p> : null}
    <div className={styles.setupActions}>
      {loading ? <button type="button" onClick={onCancel}>Cancel download</button>
        : !ready && !unsupported ? <button type="button" className={styles.loadModel} onClick={() => void load()} disabled={checking || busy || clearing}><Download size={14} aria-hidden="true" />{checking ? "Checking device…" : snapshot.cached ? "Load saved model" : "Download & enable"}</button> : null}
      {!loading && !checking ? <button type="button" onClick={() => void clear()} disabled={busy || clearing}><Trash2 size={13} aria-hidden="true" />{clearing ? "Removing…" : "Remove model files"}</button> : null}
    </div>
    {!ready && !loading ? <small>You can ask questions now for data answers, without downloading.</small> : null}
    {error || snapshot.state === "error" ? <p className={styles.setupNotice} role="alert">{error || snapshot.message}</p> : null}
  </section>;
}
