export interface Env {
  AGENTS: KVNamespace;
  MESSAGES: KVNamespace;
  ENVIRONMENT: string;
}

export interface Agent {
  address: string;
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
  sender: string;
  recipient: string;
  encrypted_payload: string;
  created_at: number;
  read_at?: number;
  expires_at: number;
}

export interface InboxIndex {
  message_ids: string[];
}

export interface AgentListEntry {
  address: string;
  updated_at: number;
}
