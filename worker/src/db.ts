import { Env, Agent, Message, InboxIndex, Conversation, ConversationMessages } from './types';

const SEVEN_DAYS = 7 * 24 * 60 * 60;
const AGENT_INDEX_KEY = '__agent_index__';

// ── Agent operations ──

export async function listAgents(env: Env, limit = 20, offset = 0): Promise<{ agents: Agent[]; total: number }> {
  const index = await getAgentIndex(env);
  const total = index.length;
  const slice = index.slice(offset, offset + limit);
  
  const agents: Agent[] = [];
  for (const entry of slice) {
    const agent = await env.AGENTS.get<Agent>(`agent:${entry}`, 'json');
    if (agent) agents.push(agent);
  }
  
  return { agents, total };
}

export async function getAgent(env: Env, address: string): Promise<Agent | null> {
  return await env.AGENTS.get<Agent>(`agent:${address}`, 'json');
}

export async function upsertAgent(env: Env, agent: Agent): Promise<void> {
  await env.AGENTS.put(`agent:${agent.address}`, JSON.stringify(agent));
  
  if (agent.name) {
    await env.AGENTS.put(`name:${agent.name.toLowerCase()}`, agent.address);
  }
  
  const index = await getAgentIndex(env);
  if (!index.includes(agent.address)) {
    index.push(agent.address);
    await env.AGENTS.put(AGENT_INDEX_KEY, JSON.stringify(index));
  }
}

export async function getAgentByName(env: Env, name: string): Promise<Agent | null> {
  const address = await env.AGENTS.get(`name:${name.toLowerCase()}`);
  if (!address) return null;
  return getAgent(env, address);
}

export async function searchAgents(env: Env, query: string): Promise<Agent[]> {
  const q = query.toLowerCase();
  const index = await getAgentIndex(env);
  const results: Agent[] = [];
  
  for (const address of index) {
    const agent = await env.AGENTS.get<Agent>(`agent:${address}`, 'json');
    if (!agent) continue;
    
    const matchAddress = agent.address.toLowerCase().includes(q);
    const matchDesc = agent.description?.toLowerCase().includes(q);
    const matchSkills = agent.skills?.some(s => s.toLowerCase().includes(q));
    
    if (matchAddress || matchDesc || matchSkills) {
      results.push(agent);
    }
    
    if (results.length >= 50) break;
  }
  
  return results;
}

async function getAgentIndex(env: Env): Promise<string[]> {
  const index = await env.AGENTS.get<string[]>(AGENT_INDEX_KEY, 'json');
  return index || [];
}

// ── Conversation operations ──

export async function createConversation(env: Env, conv: Conversation): Promise<void> {
  await env.MESSAGES.put(`conv:${conv.id}`, JSON.stringify(conv));
  // Initialize empty message list
  await env.MESSAGES.put(`conv-msgs:${conv.id}`, JSON.stringify({ message_ids: [] }));
}

export async function getConversation(env: Env, id: string): Promise<Conversation | null> {
  return await env.MESSAGES.get<Conversation>(`conv:${id}`, 'json');
}

export async function updateConversation(env: Env, conv: Conversation): Promise<void> {
  await env.MESSAGES.put(`conv:${conv.id}`, JSON.stringify(conv));
}

export async function addMessageToConversation(env: Env, convId: string, msgId: string): Promise<void> {
  const key = `conv-msgs:${convId}`;
  const data = await env.MESSAGES.get<ConversationMessages>(key, 'json') || { message_ids: [] };
  data.message_ids.push(msgId);
  await env.MESSAGES.put(key, JSON.stringify(data));
}

export async function getConversationMessages(env: Env, convId: string): Promise<Message[]> {
  const key = `conv-msgs:${convId}`;
  const data = await env.MESSAGES.get<ConversationMessages>(key, 'json') || { message_ids: [] };
  
  const messages: Message[] = [];
  const validIds: string[] = [];
  
  for (const id of data.message_ids) {
    const msg = await env.MESSAGES.get<Message>(`msg:${id}`, 'json');
    if (msg) {
      messages.push(msg);
      validIds.push(id);
    }
  }
  
  // Clean up expired messages from the list
  if (validIds.length !== data.message_ids.length) {
    await env.MESSAGES.put(key, JSON.stringify({ message_ids: validIds }));
  }
  
  return messages.sort((a, b) => a.created_at - b.created_at);
}

export async function addConversationToInbox(env: Env, address: string, convId: string): Promise<void> {
  const inboxKey = `inbox:${address}`;
  const inbox = await env.MESSAGES.get<InboxIndex>(inboxKey, 'json') || {};
  
  // Ensure new format
  if (!inbox.conversation_ids) {
    inbox.conversation_ids = [];
  }
  
  // Don't duplicate
  if (!inbox.conversation_ids.includes(convId)) {
    inbox.conversation_ids.push(convId);
    await env.MESSAGES.put(inboxKey, JSON.stringify(inbox));
  }
}

export async function getInboxConversations(env: Env, address: string): Promise<{ conversations: (Conversation & { unread_count: number })[] }> {
  const inboxKey = `inbox:${address}`;
  const inbox = await env.MESSAGES.get<InboxIndex>(inboxKey, 'json') || {};
  
  const conversations: (Conversation & { unread_count: number })[] = [];
  const validConvIds: string[] = [];
  
  // Handle new format: conversation_ids
  if (inbox.conversation_ids && inbox.conversation_ids.length > 0) {
    for (const convId of inbox.conversation_ids) {
      const conv = await getConversation(env, convId);
      if (!conv) continue;
      
      // Count unread messages in this conversation for this user
      const msgs = await getConversationMessages(env, convId);
      const unreadCount = msgs.filter(m => !m.read_at && m.sender !== address).length;
      
      validConvIds.push(convId);
      conversations.push({ ...conv, unread_count: unreadCount, message_count: msgs.length });
    }
  }
  
  // Handle legacy format: message_ids (convert to conversations on the fly)
  if (inbox.message_ids && inbox.message_ids.length > 0) {
    // Group old messages by sender+recipient pair to create conversations
    const legacyGroups: Record<string, Message[]> = {};
    
    for (const msgId of inbox.message_ids) {
      const msg = await env.MESSAGES.get<Message>(`msg:${msgId}`, 'json');
      if (!msg) continue;
      
      // Create a consistent key for the conversation (sorted participants)
      const participants = [msg.sender, msg.recipient || address].sort();
      const groupKey = participants.join(':');
      
      if (!legacyGroups[groupKey]) {
        legacyGroups[groupKey] = [];
      }
      legacyGroups[groupKey].push(msg);
    }
    
    // Convert each group into a conversation
    for (const [groupKey, msgs] of Object.entries(legacyGroups)) {
      const participants = groupKey.split(':');
      const sorted = msgs.sort((a, b) => a.created_at - b.created_at);
      const lastMsg = sorted[sorted.length - 1];
      
      // Generate a deterministic conversation ID from the group key
      const convId = 'legacy-' + groupKey.replace(/[^a-zA-Z0-9]/g, '-');
      
      // Create the conversation in KV
      const conv: Conversation = {
        id: convId,
        participants,
        last_message_at: lastMsg.created_at,
        last_preview: extractPreview(lastMsg.encrypted_payload),
        message_count: msgs.length,
      };
      
      await env.MESSAGES.put(`conv:${convId}`, JSON.stringify(conv));
      
      // Store message IDs in conv-msgs
      await env.MESSAGES.put(`conv-msgs:${convId}`, JSON.stringify({ message_ids: msgs.map(m => m.id) }));
      
      // Update each message with conversation_id and recipients
      for (const msg of msgs) {
        msg.conversation_id = convId;
        msg.recipients = participants;
        await env.MESSAGES.put(`msg:${msg.id}`, JSON.stringify(msg), { expirationTtl: SEVEN_DAYS });
      }
      
      validConvIds.push(convId);
      
      const unreadCount = msgs.filter(m => !m.read_at && m.sender !== address).length;
      conversations.push({ ...conv, unread_count: unreadCount });
    }
    
    // Migrate inbox to new format
    await env.MESSAGES.put(inboxKey, JSON.stringify({ conversation_ids: validConvIds }));
  }
  
  // Clean up if some conversations disappeared
  if (inbox.conversation_ids && validConvIds.length !== inbox.conversation_ids.length && !inbox.message_ids) {
    await env.MESSAGES.put(inboxKey, JSON.stringify({ conversation_ids: validConvIds }));
  }
  
  // Sort by last_message_at descending (most recent first)
  conversations.sort((a, b) => b.last_message_at - a.last_message_at);
  
  return { conversations };
}

// ── Message operations ──

function extractPreview(payload: string): string {
  try {
    const p = JSON.parse(payload);
    if (p.content) return p.content.slice(0, 80);
    if (p.text) return p.text.slice(0, 80);
    if (p.encrypted) return '[encrypted]';
  } catch (e) {}
  return payload.slice(0, 80);
}

export async function createMessage(env: Env, msg: Message): Promise<{ conversation_id: string }> {
  // Store message
  await env.MESSAGES.put(`msg:${msg.id}`, JSON.stringify(msg), {
    expirationTtl: SEVEN_DAYS,
  });
  
  const convId = msg.conversation_id;
  
  // Check if conversation exists
  let conv = await getConversation(env, convId);
  
  if (conv) {
    // Update existing conversation
    conv.last_message_at = msg.created_at;
    conv.last_preview = extractPreview(msg.encrypted_payload);
    conv.message_count += 1;
    await updateConversation(env, conv);
  } else {
    // Create new conversation
    conv = {
      id: convId,
      participants: [...new Set([msg.sender, ...msg.recipients])],
      last_message_at: msg.created_at,
      last_preview: extractPreview(msg.encrypted_payload),
      message_count: 1,
    };
    await createConversation(env, conv);
  }
  
  // Add message to conversation's message list
  await addMessageToConversation(env, convId, msg.id);
  
  // Add conversation to each participant's inbox
  const allParticipants = [...new Set([msg.sender, ...msg.recipients])];
  for (const participant of allParticipants) {
    await addConversationToInbox(env, participant, convId);
  }
  
  // Increment message count for each recipient agent
  for (const recipient of msg.recipients) {
    const agent = await getAgent(env, recipient);
    if (agent) {
      agent.message_count = (agent.message_count || 0) + 1;
      await upsertAgent(env, agent);
    }
  }
  
  return { conversation_id: convId };
}

export async function getInbox(env: Env, address: string, since?: number): Promise<Message[]> {
  // Legacy function - still works but returns flat messages
  const { conversations } = await getInboxConversations(env, address);
  
  const messages: Message[] = [];
  for (const conv of conversations) {
    const convMsgs = await getConversationMessages(env, conv.id);
    for (const msg of convMsgs) {
      if (since && msg.created_at <= since) continue;
      messages.push(msg);
    }
  }
  
  return messages.sort((a, b) => a.created_at - b.created_at);
}

export async function markRead(env: Env, id: string): Promise<Message | null> {
  const msg = await env.MESSAGES.get<Message>(`msg:${id}`, 'json');
  if (!msg) return null;
  
  msg.read_at = Math.floor(Date.now() / 1000);
  await env.MESSAGES.put(`msg:${id}`, JSON.stringify(msg), {
    expirationTtl: SEVEN_DAYS,
  });
  
  return msg;
}

export async function markConversationRead(env: Env, convId: string, address: string): Promise<number> {
  const msgs = await getConversationMessages(env, convId);
  let marked = 0;
  const now = Math.floor(Date.now() / 1000);
  
  for (const msg of msgs) {
    if (!msg.read_at && msg.sender !== address) {
      msg.read_at = now;
      await env.MESSAGES.put(`msg:${msg.id}`, JSON.stringify(msg), { expirationTtl: SEVEN_DAYS });
      marked++;
    }
  }
  
  return marked;
}

export async function deleteMessage(env: Env, id: string): Promise<boolean> {
  const msg = await env.MESSAGES.get<Message>(`msg:${id}`, 'json');
  if (!msg) return false;
  
  await env.MESSAGES.delete(`msg:${id}`);
  
  // Remove from conversation message list
  if (msg.conversation_id) {
    const key = `conv-msgs:${msg.conversation_id}`;
    const data = await env.MESSAGES.get<ConversationMessages>(key, 'json');
    if (data) {
      data.message_ids = data.message_ids.filter(mid => mid !== id);
      await env.MESSAGES.put(key, JSON.stringify(data));
    }
  }
  
  // Legacy: remove from recipient inbox
  if (msg.recipient) {
    const inboxKey = `inbox:${msg.recipient}`;
    const inbox = await env.MESSAGES.get<InboxIndex>(inboxKey, 'json');
    if (inbox?.message_ids) {
      inbox.message_ids = inbox.message_ids.filter(mid => mid !== id);
      await env.MESSAGES.put(inboxKey, JSON.stringify(inbox));
    }
  }
  
  return true;
}

export async function getMessage(env: Env, id: string): Promise<Message | null> {
  return await env.MESSAGES.get<Message>(`msg:${id}`, 'json');
}

// ── Rate limiting ──

export async function checkRateLimit(env: Env, address: string, limit = 10): Promise<{ allowed: boolean; remaining: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const key = `ratelimit:${address}:${today}`;
  const count = parseInt(await env.MESSAGES.get(key) || '0');
  if (count >= limit) return { allowed: false, remaining: 0 };
  await env.MESSAGES.put(key, (count + 1).toString(), { expirationTtl: 172800 });
  return { allowed: true, remaining: limit - count - 1 };
}
