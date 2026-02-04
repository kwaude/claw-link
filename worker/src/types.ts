export interface Env {
  AGENTS: KVNamespace;
  MESSAGES: KVNamespace;
  ENVIRONMENT: string;
}

export interface Agent {
  address: string;
  name?: string;          // subdomain name (e.g. "kwaude" → kwaude.clawlink.app)
  endpoint?: string;
  encryption_key?: string;
  registered_at: number;
  message_count: number;
  skills: string[];
  description?: string;
  last_seen: number;
}

export interface Message {
  id: string;
  conversation_id: string;  // groups messages into threads
  sender: string;
  recipient?: string;       // deprecated, kept for backwards compat
  recipients: string[];     // supports multiple recipients
  encrypted_payload: string;
  created_at: number;
  read_at?: number;
  expires_at: number;
}

export interface Conversation {
  id: string;
  participants: string[];
  last_message_at: number;
  last_preview: string;     // truncated last message for list view
  message_count: number;
}

export interface ConversationMessages {
  message_ids: string[];
}

export interface InboxIndex {
  message_ids?: string[];         // legacy format
  conversation_ids?: string[];    // new format
}

export interface AgentListEntry {
  address: string;
  updated_at: number;
}
