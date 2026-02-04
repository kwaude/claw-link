import { Env, Agent, Message, InboxIndex } from './types';

const SEVEN_DAYS = 7 * 24 * 60 * 60;
const AGENT_INDEX_KEY = '__agent_index__';

// ── Agent operations ──

export async function listAgents(env: Env, limit = 20, offset = 0): Promise<{ agents: Agent[]; total: number }> {
  // Get agent index
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
  
  // Store name→address mapping for subdomain routing
  if (agent.name) {
    await env.AGENTS.put(`name:${agent.name.toLowerCase()}`, agent.address);
  }
  
  // Update index
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

// ── Message operations ──

export async function createMessage(env: Env, msg: Message): Promise<void> {
  // Store message
  await env.MESSAGES.put(`msg:${msg.id}`, JSON.stringify(msg), {
    expirationTtl: SEVEN_DAYS,
  });
  
  // Add to recipient's inbox index
  const inboxKey = `inbox:${msg.recipient}`;
  const inbox = await env.MESSAGES.get<InboxIndex>(inboxKey, 'json') || { message_ids: [] };
  inbox.message_ids.push(msg.id);
  await env.MESSAGES.put(inboxKey, JSON.stringify(inbox));
  
  // Increment agent's message count
  const agent = await getAgent(env, msg.recipient);
  if (agent) {
    agent.message_count = (agent.message_count || 0) + 1;
    await upsertAgent(env, agent);
  }
}

export async function getInbox(env: Env, address: string, since?: number): Promise<Message[]> {
  const inboxKey = `inbox:${address}`;
  const inbox = await env.MESSAGES.get<InboxIndex>(inboxKey, 'json') || { message_ids: [] };
  
  const messages: Message[] = [];
  const validIds: string[] = [];
  
  for (const id of inbox.message_ids) {
    const msg = await env.MESSAGES.get<Message>(`msg:${id}`, 'json');
    if (!msg) continue; // expired or deleted
    
    validIds.push(id);
    
    if (since && msg.created_at <= since) continue;
    if (msg.read_at) continue; // skip already read
    
    messages.push(msg);
  }
  
  // Clean up inbox index if stale entries were found
  if (validIds.length !== inbox.message_ids.length) {
    await env.MESSAGES.put(inboxKey, JSON.stringify({ message_ids: validIds }));
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

export async function deleteMessage(env: Env, id: string): Promise<boolean> {
  const msg = await env.MESSAGES.get<Message>(`msg:${id}`, 'json');
  if (!msg) return false;
  
  await env.MESSAGES.delete(`msg:${id}`);
  
  // Remove from inbox
  const inboxKey = `inbox:${msg.recipient}`;
  const inbox = await env.MESSAGES.get<InboxIndex>(inboxKey, 'json');
  if (inbox) {
    inbox.message_ids = inbox.message_ids.filter(mid => mid !== id);
    await env.MESSAGES.put(inboxKey, JSON.stringify(inbox));
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
