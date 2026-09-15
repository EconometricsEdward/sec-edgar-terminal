import { highlightParts } from "../../utils/disclosureQuery.js";

export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  return <>{highlightParts(text || "", terms).map((part, index) => part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</>;
}
