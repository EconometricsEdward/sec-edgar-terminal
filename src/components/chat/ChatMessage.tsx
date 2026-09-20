import { Fragment, memo, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { safeChatUrl } from "./chatClient.js";
import styles from "./Chat.module.css";

export type ChatSource = { id: string; title: string; url: string; asOf?: string };
export type ChatMessageData = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatSource[];
  state?: "streaming" | "complete" | "stopped" | "error";
  page?: string;
  error?: string;
};

// A deliberately small Markdown subset: React escapes all other text, including HTML.
function inlineText(text: string): ReactNode[] {
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]{1,180}\]\([^\s)]{1,2048}\))/g;
  return text.split(pattern).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const match = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    const href = match ? safeChatUrl(match[2]) : null;
    if (match && href) return <a key={index} href={href} target="_blank" rel="noopener noreferrer">{match[1]}</a>;
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function AnswerText({ content }: { content: string }) {
  return content.split(/\n\s*\n/).map((block, index) => {
    const lines = block.split("\n");
    if (lines.every(line => /^\s*[-*]\s+/.test(line))) {
      return <ul key={index}>{lines.map((line, item) => <li key={item}>{inlineText(line.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
    }
    return <p key={index}>{lines.map((line, item) => <Fragment key={item}>{item ? <br /> : null}{inlineText(line.replace(/^#{1,6}\s+/, ""))}</Fragment>)}</p>;
  });
}

function ChatMessage({ message }: { message: ChatMessageData }) {
  return (
    <article className={message.role === "user" ? styles.userMessage : styles.answer} aria-label={message.role === "user" ? "Your question" : "EDGAR Terminal answer"}>
      <div className={styles.messageLabel}>
        <strong>{message.role === "user" ? "You" : "EDGAR Terminal"}</strong>
        {message.page ? <span>{message.page}</span> : null}
      </div>
      <div className={styles.messageText}>
        {message.role === "user" ? <p>{message.content}</p> : <AnswerText content={message.content} />}
      </div>
      {message.state === "stopped" ? <p className={styles.messageNote}>Stopped{message.content ? " · This answer is incomplete." : " before an answer was received."}</p> : null}
      {message.error ? <p className={styles.messageError} role="alert">{message.error}</p> : null}
      {message.sources?.length ? (
        <details className={styles.sources}>
          <summary>Supporting data <span>{message.sources.length}</span></summary>
          <ol>{message.sources.map(source => (
            <li key={source.id + source.url}>
              <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}<ExternalLink size={12} aria-hidden="true" /></a>
              {source.asOf ? <small>As of {source.asOf}</small> : null}
            </li>
          ))}</ol>
        </details>
      ) : null}
    </article>
  );
}

export default memo(ChatMessage);
