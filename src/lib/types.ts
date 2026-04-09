/** Settings stored in chrome.storage.local. */
export interface Settings {
  host: string;
  port: number;
  path: string;
  tokenIssuePath: string;
  tokenIssueSecret: string;
  clientId: string;
}

/** A single message in a chat session. */
export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  done?: boolean;
}

/** A chat session with its message history. */
export interface Session {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}

/** Events emitted by NanobotWsClient. */
export type WsClientEvent = 'ready' | 'delta' | 'stream_end' | 'message' | 'close' | 'error' | 'unknown';

/** Server frame data. */
export interface ServerFrame {
  event: string;
  chat_id?: string;
  text?: string;
  [key: string]: unknown;
}
