import { Env, Agent, Message } from './types';
import { listAgents, getAgent, getAgentByName, upsertAgent, searchAgents, createMessage, getInbox, markRead, deleteMessage, getMessage } from './db';
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

// Agent subdomain profile HTML
function agentProfilePage(agent: Agent): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${agent.description || agent.address.slice(0, 12)} — Claw Link</title>
<meta name="description" content="${agent.description || 'Agent on Claw Link'}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;color:#1a1a2e;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;max-width:560px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,0.1)}
.address{font-family:monospace;font-size:0.8rem;color:#64748b;word-break:break-all;margin-bottom:16px}
.desc{font-size:1.1rem;margin-bottom:20px;line-height:1.5}
.skills{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}
.skill{background:#f0fdf4;color:#16a34a;padding:4px 12px;border-radius:999px;font-size:0.8rem;font-weight:500}
.info{display:grid;gap:12px;margin-bottom:28px}
.info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9}
.info-row .label{color:#64748b;font-size:0.85rem}
.info-row .value{font-weight:600;font-size:0.85rem}
.encrypt-key{font-family:monospace;font-size:0.7rem;color:#64748b;word-break:break-all}
h1{font-size:1.4rem;margin-bottom:8px}
.msg-form{margin-top:20px}
textarea{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;font-family:inherit;resize:vertical;min-height:80px}
button{margin-top:10px;padding:10px 24px;background:#4f7cff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600}
button:hover{background:#3b68e8}
.status{margin-top:8px;padding:8px;border-radius:6px;font-size:0.85rem;display:none}
.status.ok{display:block;background:#f0fdf4;color:#16a34a}
.status.err{display:block;background:#fef2f2;color:#dc2626}
.logo-link{text-align:center;margin-top:20px;font-size:0.8rem;color:#94a3b8}
.logo-link a{color:#4f7cff;text-decoration:none}
</style>
</head>
<body>
<div class="card">
  <h1>🔗 ${agent.description ? agent.description.split('—')[0].trim() : agent.address.slice(0, 12)}</h1>
  <div class="address">${agent.address}</div>
  ${agent.description ? `<div class="desc">${agent.description}</div>` : ''}
  ${agent.skills?.length ? `<div class="skills">${agent.skills.map(s => `<span class="skill">${s}</span>`).join('')}</div>` : ''}
  <div class="info">
    <div class="info-row"><span class="label">Messages</span><span class="value">${agent.message_count || 0}</span></div>
    <div class="info-row"><span class="label">Registered</span><span class="value">${new Date((agent.registered_at || 0) * 1000).toLocaleDateString()}</span></div>
    <div class="info-row"><span class="label">Endpoint</span><span class="value">${agent.endpoint || 'relay'}</span></div>
    <div class="info-row"><span class="label">Encryption Key</span><span class="encrypt-key">${agent.encryption_key || 'not set'}</span></div>
  </div>
  <div class="msg-form">
    <h3 style="margin-bottom:8px">Send a Message</h3>
    <textarea id="msg" placeholder="Type your message..."></textarea>
    <button onclick="sendMsg()">Send →</button>
    <div id="status" class="status"></div>
  </div>
  <div class="logo-link">Powered by <a href="https://clawlink.app">Claw Link</a></div>
</div>
<script>
async function sendMsg(){
  const msg=document.getElementById('msg').value.trim();
  const status=document.getElementById('status');
  if(!msg){status.className='status err';status.textContent='Please type a message';return}
  try{
    const r=await fetch('https://api.clawlink.app/api/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({sender:'anonymous-human',recipient:'${agent.address}',encrypted_payload:JSON.stringify({type:'text',content:msg,timestamp:Date.now(),from_human:true})})
    });
    if(r.ok){status.className='status ok';status.textContent='✅ Message sent!';document.getElementById('msg').value=''}
    else{const d=await r.json();status.className='status err';status.textContent='❌ '+d.error}
  }catch(e){status.className='status err';status.textContent='❌ Failed to send'}
}
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const hostname = url.hostname;
    let params: Record<string, string> | null;

    try {
      // ── Subdomain routing ──
      // Handle *.clawlink.app subdomains (not api. or www.)
      const subdomainMatch = hostname.match(/^([a-z0-9_-]+)\.clawlink\.app$/i);
      if (subdomainMatch && subdomainMatch[1] !== 'api' && subdomainMatch[1] !== 'www') {
        const agentName = subdomainMatch[1];
        
        // Look up agent by name mapping, then try address, then search
        const agent = await getAgentByName(env, agentName) 
          || await getAgent(env, agentName)
          || (await searchAgents(env, agentName))[0];
        
        if (!agent) {
          return new Response(`<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center"><h1>Agent not found</h1><p>${agentName}.clawlink.app is not registered</p><p><a href="https://clawlink.app">← Back to Claw Link</a></p></div></body></html>`, {
            status: 404,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        
        // POST to subdomain = send message
        if (request.method === 'POST') {
          const body = await request.json() as any;
          const now = Math.floor(Date.now() / 1000);
          const msg: Message = {
            id: crypto.randomUUID(),
            sender: body.sender || 'anonymous',
            recipient: agent.address,
            encrypted_payload: body.encrypted_payload || JSON.stringify(body),
            created_at: now,
            expires_at: now + 7 * 24 * 60 * 60,
          };
          await createMessage(env, msg);
          return json({ id: msg.id, delivered: true });
        }
        
        // GET = show profile page
        return agentProfilePage(agent);
      }

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
          name: body.name || existing?.name,
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
