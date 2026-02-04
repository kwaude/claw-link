import { Env, Agent, Message } from './types';
import { listAgents, getAgent, upsertAgent, searchAgents, createMessage, getInbox, markRead, deleteMessage, getMessage } from './db';
import { verifyAuth } from './auth';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Address, X-Timestamp, X-Signature',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// Route matcher
function match(method: string, pattern: string, req: Request): Record<string, string> | null {
  if (req.method !== method && method !== '*') return null;
  
  const url = new URL(req.url);
  const path = url.pathname;
  
  // Convert pattern like /api/agents/:address to regex
  const paramNames: string[] = [];
  const regexStr = pattern.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  
  const regex = new RegExp(`^${regexStr}$`);
  const m = path.match(regex);
  if (!m) return null;
  
  const params: Record<string, string> = {};
  paramNames.forEach((name, i) => {
    params[name] = m[i + 1];
  });
  
  return params;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    let params: Record<string, string> | null;

    try {
      // ── Health check ──
      if (url.pathname === '/api/health') {
        return json({ status: 'ok', timestamp: Date.now() });
      }

      // ── Directory: Search agents ──
      params = match('GET', '/api/agents/search', request);
      if (params !== null) {
        const q = url.searchParams.get('q') || '';
        if (!q) return error('Missing search query ?q=');
        const agents = await searchAgents(env, q);
        return json({ agents, count: agents.length });
      }

      // ── Directory: List agents ──
      params = match('GET', '/api/agents', request);
      if (params !== null) {
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 100);
        const offset = parseInt(url.searchParams.get('offset') || '0');
        const { agents, total } = await listAgents(env, limit, offset);
        return json({ agents, total, limit, offset });
      }

      // ── Directory: Get agent ──
      params = match('GET', '/api/agents/:address', request);
      if (params) {
        const agent = await getAgent(env, params.address);
        if (!agent) return error('Agent not found', 404);
        return json({ agent });
      }

      // ── Directory: Sync/Register agent ──
      params = match('POST', '/api/agents/sync', request);
      if (params !== null) {
        const body = await request.json() as Partial<Agent>;
        if (!body.address) return error('address is required');
        
        const existing = await getAgent(env, body.address);
        const now = Math.floor(Date.now() / 1000);
        
        const agent: Agent = {
          address: body.address,
          endpoint: body.endpoint || existing?.endpoint || '',
          encryption_key: body.encryption_key || existing?.encryption_key || '',
          registered_at: existing?.registered_at || now,
          message_count: existing?.message_count || 0,
          skills: body.skills || existing?.skills || [],
          description: body.description || existing?.description || '',
          last_seen: now,
        };
        
        await upsertAgent(env, agent);
        return json({ agent, created: !existing });
      }

      // ── Messages: Send ──
      params = match('POST', '/api/messages', request);
      if (params !== null) {
        const body = await request.json() as {
          sender: string;
          recipient: string;
          encrypted_payload: string;
        };
        
        if (!body.sender || !body.recipient || !body.encrypted_payload) {
          return error('sender, recipient, and encrypted_payload are required');
        }
        
        const now = Math.floor(Date.now() / 1000);
        const id = crypto.randomUUID();
        
        const msg: Message = {
          id,
          sender: body.sender,
          recipient: body.recipient,
          encrypted_payload: body.encrypted_payload,
          created_at: now,
          expires_at: now + 7 * 24 * 60 * 60,
        };
        
        await createMessage(env, msg);
        return json({ id: msg.id, created_at: msg.created_at }, 201);
      }

      // ── Messages: Inbox ──
      params = match('GET', '/api/inbox/:address', request);
      if (params) {
        // Auth required for inbox
        const auth = verifyAuth(request);
        if (!auth.ok) return error(auth.error || 'Unauthorized', 401);
        if (auth.address !== params.address) return error('Address mismatch', 403);
        
        const since = url.searchParams.get('since');
        const sinceTs = since ? parseInt(since) : undefined;
        const messages = await getInbox(env, params.address, sinceTs);
        return json({ messages, count: messages.length });
      }

      // ── Messages: Mark read ──
      params = match('PATCH', '/api/messages/:id/read', request);
      if (params) {
        const auth = verifyAuth(request);
        if (!auth.ok) return error(auth.error || 'Unauthorized', 401);
        
        const msg = await getMessage(env, params.id);
        if (!msg) return error('Message not found', 404);
        if (msg.recipient !== auth.address) return error('Not your message', 403);
        
        const updated = await markRead(env, params.id);
        return json({ message: updated });
      }

      // ── Messages: Delete ──
      params = match('DELETE', '/api/messages/:id', request);
      if (params) {
        const auth = verifyAuth(request);
        if (!auth.ok) return error(auth.error || 'Unauthorized', 401);
        
        const msg = await getMessage(env, params.id);
        if (!msg) return error('Message not found', 404);
        if (msg.recipient !== auth.address) return error('Not your message', 403);
        
        await deleteMessage(env, params.id);
        return json({ deleted: true });
      }

      return error('Not found', 404);
    } catch (err) {
      console.error('Worker error:', err);
      return error('Internal server error', 500);
    }
  },
};
