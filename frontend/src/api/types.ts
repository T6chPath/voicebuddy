export interface User { id: string; email: string; name: string }

export interface ModelInfo { id: string; label: string; vision: boolean; description: string }

export interface Attachment { id: string; name: string; mime: string; size: number; kind: "text" | "pdf" | "image" }

export type MessageStatus = "complete" | "streaming" | "stopped" | "error";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  status: MessageStatus;
  error: string | null;
  attachments: Attachment[];
  created_at: number;
  /** client-only: message not yet confirmed by the server */
  pending?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  pinned: boolean;
  created_at: number;
  updated_at: number;
}

export interface ConversationDetail extends Conversation { messages: Message[] }

export interface UserSettings {
  theme: "system" | "light" | "dark";
  default_model: string;
  temperature: number;
  system_prompt: string;
  font_size: "small" | "medium" | "large";
  send_on_enter: boolean;
  show_timestamps: boolean;
  /** standalone app only: OpenAI-compatible server to talk to directly */
  server_url?: string;
  api_key?: string;
}

export interface UploadedFile extends Attachment { chars: number; truncated: boolean }
