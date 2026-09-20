import { normalizeChatContext } from '../../utils/chatContext.js';

/** One current public selection, held only in this JS tab. Unmounting a reader
 * removes it; route mismatches cannot reuse a stale selection. */
export function createChatPageSelectionStore() {
  let snapshot = null;
  const subscribers = new Set();
  const notify = () => subscribers.forEach(listener => listener());
  return {
    subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); },
    getSnapshot: () => snapshot,
    publish(input) {
      const normalized = normalizeChatContext(input);
      const next = { path: normalized.path, query: normalized.query };
      snapshot = next; notify();
      return () => { if (snapshot === next) { snapshot = null; notify(); } };
    },
    resolve(input) {
      const current = normalizeChatContext(input);
      if (snapshot?.path !== current.path) return current;
      const query = new URLSearchParams(current.query);
      for (const [key, value] of new URLSearchParams(snapshot.query)) query.set(key, value);
      return normalizeChatContext({ path: current.path, query: query.toString() });
    },
  };
}
export const chatPageSelection = createChatPageSelectionStore();
export const CHAT_SHARE_EVENT = 'edgar-chat-share-context';
