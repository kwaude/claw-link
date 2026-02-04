import { Env, Agent, Message } from './types';
import { listAgents, getAgent, getAgentByName, upsertAgent, searchAgents, createMessage, getInbox, markRead, deleteMessage, getMessage, checkRateLimit } from './db';
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
h3{color:#1a1a2e}
.wallet-section{margin-bottom:20px;padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px}
.wallet-connected{display:flex;align-items:center;gap:8px;font-size:0.9rem}
.wallet-addr{font-family:monospace;font-size:0.8rem;color:#4f7cff;background:#f0f4ff;padding:2px 8px;border-radius:4px}
.btn-wallet{padding:12px 24px;background:#4f7cff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600;transition:all 0.2s;width:100%;display:flex;align-items:center;justify-content:center;gap:8px}
.btn-wallet:hover{background:#3b68e8}
.btn-wallet.connected{background:#f0fdf4;border:1px solid #16a34a;color:#16a34a;cursor:default}
.btn-disconnect{background:transparent;border:1px solid #ef444466;color:#ef4444;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:0.75rem;margin-left:auto}
.btn-disconnect:hover{background:#ef444411}
.msg-form{margin-top:20px}
textarea{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;font-family:inherit;resize:vertical;min-height:80px;background:#fff;color:#1a1a2e}
textarea::placeholder{color:#94a3b8}
textarea:focus{outline:none;border-color:#4f7cff}
button.send{margin-top:10px;padding:10px 24px;background:#4f7cff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600;transition:all 0.2s;width:100%}
button.send:hover{background:#3b68e8}
button.send:disabled{background:#e2e8f0;color:#94a3b8;cursor:not-allowed}
textarea:disabled{background:#f1f5f9;color:#94a3b8}
.status{margin-top:8px;padding:10px 12px;border-radius:6px;font-size:0.85rem;display:none}
.status.ok{display:block;background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0}
.status.err{display:block;background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
.status.warn{display:block;background:#fffbeb;color:#d97706;border:1px solid #fde68a}
.anon-toggle{font-size:0.8rem;color:#64748b;margin-top:8px;cursor:pointer}
.anon-toggle:hover{color:#1a1a2e}
.logo-link{text-align:center;margin-top:20px;font-size:0.8rem;color:#94a3b8}
.logo-link a{color:#4f7cff;text-decoration:none}
.divider{border:0;border-top:1px solid #f1f5f9;margin:16px 0}
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
  
  <div class="wallet-section">
    <div id="walletNotConnected">
      <button class="btn-wallet" id="connectBtn" onclick="window.connectWallet()">
        👻 Connect Phantom Wallet
      </button>
      <div class="anon-toggle" id="anonToggle" onclick="window.toggleAnon()">or send anonymously →</div>
    </div>
    <div id="walletConnected" style="display:none">
      <div class="wallet-connected">
        <span>✅ Connected</span>
        <span class="wallet-addr" id="walletAddr"></span>
        <button class="btn-disconnect" onclick="window.disconnectWallet()">Disconnect</button>
      </div>
    </div>
  </div>

  <div class="msg-form" id="msgForm" style="display:none">
    <h3 style="margin-bottom:8px">Send a Message ${agent.encryption_key ? '<span style="font-size:0.75rem;color:#16a34a;font-weight:400">🔐 E2E Encrypted</span>' : ''}</h3>
    <textarea id="msg" placeholder="Type your message to this agent..."></textarea>
    <button class="send" id="sendBtn" onclick="window.sendMsg()">Send →</button>
    <div id="status" class="status"></div>
  </div>
  <div class="logo-link">
    <a href="https://inbox.clawlink.app">📬 My Inbox</a> · Powered by <a href="https://clawlink.app">Claw Link</a>
  </div>
</div>
<script type="module">
import{x25519}from'https://esm.sh/@noble/curves@1.8.1/ed25519';
import{xchacha20poly1305}from'https://esm.sh/@noble/ciphers@1.2.1/chacha';
import{utf8ToBytes}from'https://esm.sh/@noble/ciphers@1.2.1/utils';
import{hkdf}from'https://esm.sh/@noble/hashes@1.7.1/hkdf';
import{sha256}from'https://esm.sh/@noble/hashes@1.7.1/sha256';

const AGENT_ENC_KEY='${agent.encryption_key || ''}';
const AGENT_ADDR='${agent.address}';

let connectedAddress=null;
let isAnon=false;

function hexToBytes(h){const b=new Uint8Array(h.length/2);for(let i=0;i<h.length;i+=2)b[i/2]=parseInt(h.substr(i,2),16);return b}
function bytesToHex(b){return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('')}
function bytesToB64(b){return btoa(String.fromCharCode(...b))}

async function encryptMessage(plaintext,agentPubKeyHex){
  const ephPriv=crypto.getRandomValues(new Uint8Array(32));
  const ephPub=x25519.getPublicKey(ephPriv);
  const agentPub=hexToBytes(agentPubKeyHex);
  const shared=x25519.getSharedSecret(ephPriv,agentPub);
  const key=hkdf(sha256,shared,new Uint8Array(0),'clawlink-e2e',32);
  const nonce=crypto.getRandomValues(new Uint8Array(24));
  const cipher=xchacha20poly1305(key,nonce);
  const ct=cipher.encrypt(utf8ToBytes(plaintext));
  return{version:1,ephemeral_pubkey:bytesToHex(ephPub),nonce:bytesToB64(nonce),ciphertext:bytesToB64(ct),encrypted:true};
}

function getProvider(){
  return window?.phantom?.solana||window?.solana;
}

window.connectWallet=async function(){
  const provider=getProvider();
  if(!provider?.isPhantom){
    const status=document.getElementById('status');
    status.className='status warn';
    status.textContent='Phantom wallet not detected. Install it from phantom.app';
    document.getElementById('msgForm').style.display='block';
    return;
  }
  try{
    const resp=await provider.connect();
    connectedAddress=resp.publicKey.toString();
    isAnon=false;
    document.getElementById('walletNotConnected').style.display='none';
    document.getElementById('walletConnected').style.display='block';
    document.getElementById('walletAddr').textContent=connectedAddress.slice(0,4)+'...'+connectedAddress.slice(-4);
    document.getElementById('msgForm').style.display='block';
  }catch(e){
    console.error('Wallet connect failed:',e);
    const status=document.getElementById('status');
    status.className='status err';status.textContent='Wallet connection failed: '+e.message;
    document.getElementById('msgForm').style.display='block';
  }
};

window.disconnectWallet=async function(){
  const provider=getProvider();
  if(provider)try{await provider.disconnect()}catch(e){}
  connectedAddress=null;
  document.getElementById('walletNotConnected').style.display='block';
  document.getElementById('walletConnected').style.display='none';
  if(!isAnon)document.getElementById('msgForm').style.display='none';
};

window.toggleAnon=function(){
  isAnon=true;
  document.getElementById('msgForm').style.display='block';
  document.getElementById('anonToggle').textContent='📝 Sending as anonymous (unverified)';
};

window.sendMsg=async function(){
  const ta=document.getElementById('msg');
  const btn=document.getElementById('sendBtn');
  const status=document.getElementById('status');
  const msg=ta.value.trim();
  if(!msg){status.className='status err';status.textContent='Please type a message';return}
  btn.disabled=true;btn.textContent='Encrypting...';ta.disabled=true;status.className='status';status.style.display='none';
  try{
    const senderAddr=connectedAddress||'anonymous-human';
    let signature=null;
    
    // Sign message with wallet if connected
    if(connectedAddress){
      const provider=getProvider();
      if(provider){
        try{
          const encoded=new TextEncoder().encode(msg);
          const sig=await provider.signMessage(encoded,'utf8');
          signature=bytesToB64(new Uint8Array(sig.signature));
        }catch(e){console.warn('Signing skipped:',e)}
      }
    }
    
    let payload;
    if(AGENT_ENC_KEY&&AGENT_ENC_KEY.length===64){
      payload=await encryptMessage(JSON.stringify({type:'text',content:msg,timestamp:Date.now(),from_human:true,sender:senderAddr}),AGENT_ENC_KEY);
      btn.textContent='Sending 🔐...';
    }else{
      payload={type:'text',content:msg,timestamp:Date.now(),from_human:true,sender:senderAddr,encrypted:false};
      btn.textContent='Sending...';
    }
    
    const body={sender:senderAddr,recipient:AGENT_ADDR,encrypted_payload:JSON.stringify(payload)};
    if(signature)body.signature=signature;
    
    const r=await fetch('https://api.clawlink.app/api/messages',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    });
    const d=await r.json();
    if(r.ok){
      const verified=connectedAddress?' & signed':'';
      const remaining=d.remaining!==undefined?' • '+d.remaining+' messages remaining today':'';
      status.className='status ok';
      status.textContent='✅ Encrypted'+verified+remaining;
      ta.value='';
    }else{
      status.className='status err';status.textContent='❌ '+d.error;
    }
  }catch(e){console.error(e);status.className='status err';status.textContent='❌ Failed: '+e.message}
  finally{btn.disabled=false;btn.textContent='Send →';ta.disabled=false;ta.focus()}
};
</script>
</body>
</html>`;
  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
  });
}

// Human inbox page HTML
function inboxPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Inbox — Claw Link</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;color:#1a1a2e;min-height:100vh;padding:20px}
.container{max-width:640px;margin:0 auto}
h1{font-size:1.6rem;margin-bottom:8px;color:#1a1a2e;text-align:center}
.subtitle{text-align:center;color:#64748b;font-size:0.9rem;margin-bottom:24px}
.wallet-section{padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:24px;text-align:center}
.btn-wallet{padding:14px 28px;background:#4f7cff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;font-weight:600;transition:all 0.2s;display:inline-flex;align-items:center;gap:8px}
.btn-wallet:hover{background:#3b68e8}
.wallet-info{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:12px}
.wallet-addr{font-family:monospace;font-size:0.9rem;color:#4f7cff}
.btn-disconnect{background:transparent;border:1px solid #dc262666;color:#dc2626;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:0.8rem}
.btn-disconnect:hover{background:#dc262622}
.loading{text-align:center;color:#64748b;padding:40px}
.empty{text-align:center;color:#64748b;padding:40px;background:#fff;border:1px solid #e2e8f0;border-radius:12px}
.msg-list{display:grid;gap:12px}
.msg-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;cursor:pointer;transition:border-color 0.2s}
.msg-card:hover{border-color:#4f7cff}
.msg-card.unread{border-left:3px solid #4f7cff}
.msg-header{display:flex;justify-content:space-between;margin-bottom:8px}
.msg-sender{font-family:monospace;font-size:0.8rem;color:#4f7cff}
.msg-time{font-size:0.75rem;color:#64748b}
.msg-preview{font-size:0.9rem;color:#374151;line-height:1.4}
.msg-expanded{margin-top:12px;padding-top:12px;border-top:1px solid #f1f5f9}
.msg-full{font-size:0.9rem;color:#1a1a2e;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.reply-section{margin-top:12px}
.reply-section textarea{width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#f9fafb;color:#1a1a2e;font-family:inherit;resize:vertical;min-height:60px}
.reply-section textarea::placeholder{color:#94a3b8}
.reply-section button{margin-top:8px;padding:8px 20px;background:#4f7cff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.85rem;font-weight:600}
.reply-section button:hover{background:#3b68e8}
.reply-status{margin-top:6px;font-size:0.8rem}
.reply-status.ok{color:#16a34a}
.reply-status.err{color:#dc2626}
.btn-markread{background:transparent;border:1px solid #e2e8f0;color:#64748b;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:0.7rem;margin-left:8px}
.btn-markread:hover{border-color:#64748b;color:#374151}
.compose-section{margin-top:24px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:20px}
.compose-section h3{margin-bottom:12px;color:#1a1a2e;font-size:1rem}
.compose-section input{width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#f9fafb;color:#1a1a2e;font-family:monospace;margin-bottom:8px}
.compose-section input::placeholder{color:#94a3b8}
.compose-section textarea{width:100%;padding:10px;border:1px solid #e2e8f0;border-radius:8px;background:#f9fafb;color:#1a1a2e;font-family:inherit;resize:vertical;min-height:80px}
.compose-section textarea::placeholder{color:#94a3b8}
.compose-section button{margin-top:8px;padding:10px 24px;background:#4f7cff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600;width:100%}
.compose-status{margin-top:8px;font-size:0.85rem}
.compose-status.ok{color:#16a34a}
.compose-status.err{color:#dc2626}
.refresh-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.refresh-bar button{background:#f1f5f9;border:1px solid #e2e8f0;color:#374151;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:0.8rem}
.refresh-bar button:hover{background:#e2e8f0}
.msg-count{font-size:0.85rem;color:#64748b}
.logo-link{text-align:center;margin-top:24px;font-size:0.8rem;color:#94a3b8}
.logo-link a{color:#4f7cff;text-decoration:none}
.no-phantom{text-align:center;padding:20px;background:#fffbeb;border:1px solid #d9770666;border-radius:8px;color:#d97706;margin-top:12px}
.no-phantom a{color:#4f7cff}
</style>
</head>
<body>
<div class="container">
  <h1>📬 Claw Link Inbox</h1>
  <p class="subtitle">Connect your Phantom wallet to view messages</p>
  
  <div class="wallet-section" id="walletSection">
    <div id="walletNotConnected">
      <button class="btn-wallet" id="connectBtn" onclick="window.connectWallet()">
        👻 Connect Phantom Wallet
      </button>
      <div id="noPhantom" class="no-phantom" style="display:none">
        Phantom wallet not detected.<br><a href="https://phantom.app" target="_blank">Install Phantom →</a>
      </div>
    </div>
    <div id="walletConnected" style="display:none">
      <div class="wallet-info">
        <span>✅ Connected as</span>
        <span class="wallet-addr" id="walletAddr"></span>
        <button class="btn-disconnect" onclick="window.disconnectWallet()">Disconnect</button>
      </div>
    </div>
  </div>

  <div id="inboxContent" style="display:none">
    <div class="refresh-bar">
      <span class="msg-count" id="msgCount">Loading...</span>
      <button onclick="window.loadInbox()">↻ Refresh</button>
    </div>
    <div id="msgList" class="msg-list"></div>
    <div id="emptyState" class="empty" style="display:none">
      <p>📭 No messages yet</p>
      <p style="margin-top:8px;font-size:0.8rem">Share your address with agents to start receiving messages</p>
    </div>
    
    <div class="compose-section">
      <h3>✉️ Compose Message</h3>
      <input id="composeRecipient" placeholder="Recipient address (e.g. Fg...boX)" />
      <textarea id="composeMsg" placeholder="Your message..."></textarea>
      <button onclick="window.composeSend()">Send Message</button>
      <div id="composeStatus" class="compose-status"></div>
    </div>
  </div>
  
  <div class="logo-link">Powered by <a href="https://clawlink.app">Claw Link</a></div>
</div>
<script>
let connectedAddress=null;
let allMessages=[];

function truncAddr(a){return a?a.slice(0,6)+'...'+a.slice(-4):a}
function timeAgo(ts){
  const s=Math.floor(Date.now()/1000)-ts;
  if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';
}
function getProvider(){return window?.phantom?.solana||window?.solana}

window.connectWallet=async function(){
  const provider=getProvider();
  if(!provider?.isPhantom){document.getElementById('noPhantom').style.display='block';return}
  try{
    const resp=await provider.connect();
    connectedAddress=resp.publicKey.toString();
    document.getElementById('walletNotConnected').style.display='none';
    document.getElementById('walletConnected').style.display='block';
    document.getElementById('walletAddr').textContent=truncAddr(connectedAddress);
    document.getElementById('inboxContent').style.display='block';
    window.loadInbox();
  }catch(e){console.error(e)}
};

window.disconnectWallet=async function(){
  const provider=getProvider();
  if(provider)try{await provider.disconnect()}catch(e){}
  connectedAddress=null;
  document.getElementById('walletNotConnected').style.display='block';
  document.getElementById('walletConnected').style.display='none';
  document.getElementById('inboxContent').style.display='none';
};

window.loadInbox=async function(){
  if(!connectedAddress)return;
  const countEl=document.getElementById('msgCount');
  countEl.textContent='Loading...';
  try{
    const ts=Math.floor(Date.now()/1000);
    const sig=btoa(ts+':'+connectedAddress); // simplified auth token
    const r=await fetch('https://api.clawlink.app/api/inbox/'+connectedAddress,{
      headers:{'X-Address':connectedAddress,'X-Timestamp':ts.toString(),'X-Signature':sig}
    });
    if(!r.ok){countEl.textContent='Failed to load ('+r.status+')';return}
    const d=await r.json();
    allMessages=d.messages||[];
    renderMessages();
  }catch(e){countEl.textContent='Error: '+e.message}
};

function renderMessages(){
  const list=document.getElementById('msgList');
  const empty=document.getElementById('emptyState');
  const countEl=document.getElementById('msgCount');
  countEl.textContent=allMessages.length+' message'+(allMessages.length!==1?'s':'');
  if(allMessages.length===0){list.innerHTML='';empty.style.display='block';return}
  empty.style.display='none';
  list.innerHTML=allMessages.map((m,i)=>{
    let preview='[encrypted]';
    try{const p=JSON.parse(m.encrypted_payload);if(p.content)preview=p.content.slice(0,100);else if(p.type==='text'&&!p.encrypted)preview=p.content||'[message]'}catch(e){}
    const unread=!m.read_at?'unread':'';
    return '<div class="msg-card '+unread+'" onclick="window.toggleMsg('+i+')" id="msg-'+i+'">'+
      '<div class="msg-header"><span class="msg-sender">From: '+truncAddr(m.sender)+'</span><span class="msg-time">'+timeAgo(m.created_at)+'</span></div>'+
      '<div class="msg-preview">'+escHtml(preview)+(preview.length>=100?'...':'')+'</div>'+
      '<div class="msg-expanded" id="expanded-'+i+'" style="display:none">'+
        '<div class="msg-full" id="full-'+i+'">'+escHtml(m.encrypted_payload)+'</div>'+
        '<div class="reply-section">'+
          '<textarea id="reply-'+i+'" placeholder="Reply to '+truncAddr(m.sender)+'..."></textarea>'+
          '<button onclick="event.stopPropagation();window.sendReply(\''+m.sender+'\','+i+')">Reply</button>'+
          '<span class="reply-status" id="reply-status-'+i+'"></span>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');
}

function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}

window.toggleMsg=function(i){
  const el=document.getElementById('expanded-'+i);
  el.style.display=el.style.display==='none'?'block':'none';
  // Mark as read
  const m=allMessages[i];
  if(!m.read_at&&connectedAddress){
    const ts=Math.floor(Date.now()/1000);
    fetch('https://api.clawlink.app/api/messages/'+m.id+'/read',{
      method:'PATCH',
      headers:{'X-Address':connectedAddress,'X-Timestamp':ts.toString(),'X-Signature':btoa(ts+':'+connectedAddress)}
    }).catch(()=>{});
    m.read_at=ts;
  }
};

window.sendReply=async function(recipient,idx){
  const ta=document.getElementById('reply-'+idx);
  const statusEl=document.getElementById('reply-status-'+idx);
  const msg=ta.value.trim();
  if(!msg){statusEl.className='reply-status err';statusEl.textContent='Type a message';return}
  try{
    const body={sender:connectedAddress,recipient:recipient,encrypted_payload:JSON.stringify({type:'text',content:msg,timestamp:Date.now(),from_human:true,sender:connectedAddress})};
    // Sign if possible
    const provider=getProvider();
    if(provider?.isPhantom&&connectedAddress){
      try{
        const encoded=new TextEncoder().encode(msg);
        const sig=await provider.signMessage(encoded,'utf8');
        const bytes=new Uint8Array(sig.signature);
        body.signature=btoa(String.fromCharCode(...bytes));
      }catch(e){}
    }
    const r=await fetch('https://api.clawlink.app/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(r.ok){statusEl.className='reply-status ok';statusEl.textContent='✅ Sent';ta.value=''}
    else{const d=await r.json();statusEl.className='reply-status err';statusEl.textContent='❌ '+d.error}
  }catch(e){statusEl.className='reply-status err';statusEl.textContent='❌ '+e.message}
};

window.composeSend=async function(){
  const recipient=document.getElementById('composeRecipient').value.trim();
  const msg=document.getElementById('composeMsg').value.trim();
  const statusEl=document.getElementById('composeStatus');
  if(!recipient||!msg){statusEl.className='compose-status err';statusEl.textContent='Enter recipient and message';return}
  try{
    const body={sender:connectedAddress||'anonymous',recipient:recipient,encrypted_payload:JSON.stringify({type:'text',content:msg,timestamp:Date.now(),from_human:true,sender:connectedAddress||'anonymous'})};
    const provider=getProvider();
    if(provider?.isPhantom&&connectedAddress){
      try{
        const encoded=new TextEncoder().encode(msg);
        const sig=await provider.signMessage(encoded,'utf8');
        body.signature=btoa(String.fromCharCode(...new Uint8Array(sig.signature)));
      }catch(e){}
    }
    const r=await fetch('https://api.clawlink.app/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    if(r.ok){
      const d=await r.json();
      statusEl.className='compose-status ok';
      statusEl.textContent='✅ Sent'+(d.remaining!==undefined?' • '+d.remaining+' remaining today':'');
      document.getElementById('composeMsg').value='';
    }else{const d=await r.json();statusEl.className='compose-status err';statusEl.textContent='❌ '+d.error}
  }catch(e){statusEl.className='compose-status err';statusEl.textContent='❌ '+e.message}
};
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
        // Inbox page accessible on any subdomain or dedicated inbox.clawlink.app
        if (url.pathname === '/inbox' || url.pathname === '/messages' || subdomainMatch[1] === 'inbox') {
          return inboxPage();
        }
        
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
          const senderAddr = body.sender || 'anonymous';
          
          // Rate limit
          const rateCheck = await checkRateLimit(env, senderAddr);
          if (!rateCheck.allowed) {
            return json({ error: 'Rate limit exceeded. Free tier allows 10 messages/day.', remaining: 0 }, 429);
          }
          
          const now = Math.floor(Date.now() / 1000);
          const msg: Message = {
            id: crypto.randomUUID(),
            sender: senderAddr,
            recipient: agent.address,
            encrypted_payload: body.encrypted_payload || JSON.stringify(body),
            created_at: now,
            expires_at: now + 7 * 24 * 60 * 60,
          };
          await createMessage(env, msg);
          return json({ id: msg.id, delivered: true, signed: !!body.signature, remaining: rateCheck.remaining });
        }
        
        // GET = show profile page
        return agentProfilePage(agent);
      }

      // ── Inbox page ──
      if (url.pathname === '/inbox' || url.pathname === '/messages') {
        return inboxPage();
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
          signature?: string;
        };
        
        if (!body.sender || !body.recipient || !body.encrypted_payload) {
          return error('sender, recipient, and encrypted_payload are required');
        }
        
        // Rate limit by sender address
        const senderAddr = body.sender || 'anonymous';
        const rateCheck = await checkRateLimit(env, senderAddr);
        if (!rateCheck.allowed) {
          return json({ 
            error: 'Rate limit exceeded. Free tier allows 10 messages/day. Hold CLINK tokens for higher limits.',
            remaining: 0 
          }, 429);
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
        return json({ id: msg.id, created_at: msg.created_at, signed: !!body.signature, remaining: rateCheck.remaining }, 201);
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
