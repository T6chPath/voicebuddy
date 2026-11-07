export interface User { id: string; email: string; name: string }

export interface ModelInfo { id: string; label: string; vision: boolean; description: string }

export interface ImageMeta {
  op: ImageOp; prompt: string; seed: number | null; provider: string; model: string; parent_id: string | null;
  style?: string; aspect_ratio?: string; negative_prompt?: string; scene?: string;
}

export interface Attachment {
  id: string; name: string; mime: string; size: number; kind: "text" | "pdf" | "image";
  /** set on images the assistant made */
  generated?: boolean; width?: number; height?: number; meta?: ImageMeta;
}

export type ImageOp = "generate" | "edit" | "variations" | "style" | "inpaint" | "remove_object" | "remove_background" | "replace_background";

/** Image controls sent with a message. Without `op` the assistant decides from the text whether to make an image. */
export interface ImageOptions {
  op?: ImageOp; style?: string; aspect_ratio?: string; resolution?: number; n?: number; seed?: number;
  negative_prompt?: string; output_format?: "png" | "jpeg" | "webp"; strength?: number; source_id?: string; mask_id?: string;
}

export interface ImageCaps {
  available: boolean; reason: string | null; ops: ImageOp[]; styles: string[]; aspect_ratios: string[]; formats: string[];
  max_n: number; max_resolution: number;
  providers: { name: string; model: string; ready: boolean; reason: string | null; ops: ImageOp[]; negative_prompt: boolean; seed: boolean }[];
}

export interface ToolState { name: string; op: ImageOp; status: "running" | "done" | "failed"; fraction: number; text: string }

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
  /** client-only: image tool progress while the reply streams */
  tool?: ToolState;
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

export interface TTSCatalog {
  available: boolean; reason: string | null;
  engines: { name: string; model: string; ready: boolean; reason: string | null; speed: boolean; pitch: boolean; style: boolean; langs: string[]; notes: string[] }[];
  voices: { id: string; label: string; gender: "female" | "male" | "unspecified"; langs: string[]; engine: string }[];
  languages: { code: string; name: string }[];
  defaults: Record<string, Record<"female" | "male", string | null>>;
  max_chars: number;
}
