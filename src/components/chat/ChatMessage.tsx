import { Fragment, memo, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { safeChatMessageUrl } from "./chatClient.js";
import styles from "./Chat.module.css";

export type ChatSource = { id: string; title: string; url: string; asOf?: string };
export type ChatMode = "fast" | "reasoning";
export type ChatMessageData = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  state?: "streaming" | "complete" | "stopped" | "error";
  page?: string;
  mode?: ChatMode;
  error?: string;
};

// A deliberately small Markdown subset: React escapes all other text, including HTML.
function inlineText(text: string, sources: ChatSource[]): ReactNode[] {
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]{1,180}\]\([^\s)]{1,2048}\))/g;
  return text.split(pattern).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    const href = match ? safeChatMessageUrl(match[2], sources) : null;
    if (match && href) return <a key={index} href={href} target="_blank" rel="noopener noreferrer">{match[1]}</a>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  const text = line.trim();
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\\" && (text[index + 1] === "|" || text[index + 1] === "\\")) {
      cell += text[++index];
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  if (text.startsWith("|") && cells[0] === "") cells.shift();
  if (text.endsWith("|") && cells.at(-1) === "") cells.pop();
  return cells;
}

function tableAt(lines: string[], start: number) {
  if (!lines[start]?.includes("|") || !lines[start + 1]?.includes("|")) return null;
  const headers = tableCells(lines[start]);
  const separators = tableCells(lines[start + 1]);
  if (headers.length < 2 || !headers.some(Boolean) || separators.length !== headers.length || !separators.every(cell => /^:?-{3,}:?$/.test(cell))) return null;
  const rows: string[][] = [];
  let end = start + 2;
  while (end < lines.length && lines[end].includes("|")) {
    const cells = tableCells(lines[end]);
    // Preserve malformed or partially streamed tables as ordinary escaped text.
    if (cells.length !== headers.length) return null;
    rows.push(cells);
    end++;
  }
  if (!rows.length) return null;
  const alignments = separators.map(cell => cell.endsWith(":") ? cell.startsWith(":") ? "center" as const : "right" as const : "left" as const);
  return { headers, rows, alignments, end };
}

function TextBlock({ lines, sources }: { lines: string[]; sources: ChatSource[] }) {
  if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
    return <ul>{lines.map((line, item) => <li key={item}>{inlineText(line.replace(/^\s*[-*]\s+/, ""), sources)}</li>)}</ul>;
  }
  return <p>{lines.map((line, item) => <Fragment key={item}>{item ? <br /> : null}{inlineText(line.replace(/^#{1,6}\s+/, ""), sources)}</Fragment>)}</p>;
}

function AnswerText({ content, sources }: { content: string; sources: ChatSource[] }) {
  return content.split(/\n\s*\n/).flatMap((block, index) => {
    const lines = block.split("\n");
    const parts: ReactNode[] = [];
    let textStart = 0;
    for (let line = 0; line < lines.length; line++) {
      const table = tableAt(lines, line);
      if (!table) continue;
      if (line > textStart) parts.push(<TextBlock key={`${index}-${textStart}-text`} lines={lines.slice(textStart, line)} sources={sources} />);
      parts.push(
        <div key={`${index}-${line}-table`} className={styles.tableScroll} role="region" aria-label="Data comparison table" tabIndex={0}>
          <table className={styles.comparisonTable}>
            <thead><tr>{table.headers.map((cell, column) => <th key={column} scope="col" style={{ textAlign: table.alignments[column] }}>{inlineText(cell, sources)}</th>)}</tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ textAlign: table.alignments[column] }}>{inlineText(cell, sources)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      textStart = table.end;
      line = table.end - 1;
    }
    if (textStart < lines.length) parts.push(<TextBlock key={`${index}-${textStart}-text`} lines={lines.slice(textStart)} sources={sources} />);
    return parts;
  });
}

function ChatMessage({ message }: { message: ChatMessageData }) {
  return (
    <article className={message.role === "user" ? styles.userMessage : styles.answer} aria-label={message.role === "user" ? "Your question" : "EDGAR Terminal answer"}>
      <div className={styles.messageLabel}>
        <strong>{message.role === "user" ? "You" : "EDGAR Terminal"}</strong>
        {message.role === "assistant" && message.mode ? <span className={styles.modeBadge}>{message.mode === "reasoning" ? "Reasoning" : "Fast"}</span> : null}
        {message.page ? <span>{message.page}</span> : null}
      </div>
      <div className={styles.messageText}>
        {message.role === "user" ? <p>{message.content}</p> : <AnswerText content={message.content} sources={message.sources || []} />}
      </div>
      {message.state === "stopped" ? <p className={styles.messageNote}>Stopped{message.content ? " · This answer is incomplete." : " before an answer was received."}</p> : null}
      {message.error ? <p className={styles.messageError} role="alert">{message.error}</p> : null}
      {message.sources?.length ? (
        <details className={styles.sources}>
          <summary>Supporting data <span>{message.sources.length}</span></summary>
          <ol>{message.sources.map(source => (
            <li key={source.id + source.url}>
              <a href={source.url} target="_blank" rel="noopener noreferrer"><span className={styles.sourceId}>[{source.id}]</span> {source.title}<ExternalLink size={12} aria-hidden="true" /></a>
              {source.asOf ? <small>As of {source.asOf}</small> : null}
            </li>
          ))}</ol>
        </details>
      ) : null}
    </article>
  );
}

export default memo(ChatMessage);
