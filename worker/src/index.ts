import { Env, Agent, Message } from './types';
import { listAgents, getAgent, getAgentByName, upsertAgent, searchAgents, createMessage, getInbox, getInboxConversations, getConversation, getConversationMessages, markRead, markConversationRead, deleteMessage, getMessage, checkRateLimit } from './db';
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
    <a href="https://app.clawlink.app">💬 My Messages</a> · Powered by <a href="https://clawlink.app">Claw Link</a>
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
    try{await provider.disconnect()}catch(x){}
    const resp=await provider.connect();
    const addr=resp.publicKey.toString();
    const challenge='Sign in to Claw Link\\n\\nAddress: '+addr+'\\nTimestamp: '+Date.now();
    const encoded=new TextEncoder().encode(challenge);
    await provider.signMessage(encoded,'utf8');
    connectedAddress=addr;
    document.getElementById('walletNotConnected').style.display='none';
    document.getElementById('walletConnected').style.display='block';
    document.getElementById('walletAddr').textContent=connectedAddress.slice(0,4)+'...'+connectedAddress.slice(-4);
    document.getElementById('msgForm').style.display='block';
  }catch(e){
    console.error('Wallet connect failed:',e);
    await provider?.disconnect?.().catch(()=>{});
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
  document.getElementById('msgForm').style.display='none';
};

window.sendMsg=async function(){
  const ta=document.getElementById('msg');
  const btn=document.getElementById('sendBtn');
  const status=document.getElementById('status');
  const msg=ta.value.trim();
  if(!msg){status.className='status err';status.textContent='Please type a message';return}
  btn.disabled=true;btn.textContent='Encrypting...';ta.disabled=true;status.className='status';status.style.display='none';
  try{
    if(!connectedAddress){status.className='status err';status.textContent='Connect your wallet first';return}
    const senderAddr=connectedAddress;
    let signature=null;
    
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

// Messaging account page HTML - WhatsApp/Signal-style Chat UI
function inboxPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claw Link — Messaging</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔗</text></svg>">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f0f2f5;color:#1a1a2e;height:100vh;overflow:hidden}

/* ─── Login Screen ─── */
#loginScreen{display:flex;align-items:center;justify-content:center;height:100vh;background:linear-gradient(135deg,#4f7cff 0%,#6c63ff 100%);flex-direction:column;text-align:center;padding:40px}
#loginScreen .login-card{background:#fff;border-radius:20px;padding:48px 40px;max-width:420px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.15)}
#loginScreen .login-icon{font-size:3.5rem;margin-bottom:20px}
#loginScreen h1{font-size:1.6rem;font-weight:700;margin-bottom:6px;color:#1a1a2e}
#loginScreen .login-sub{color:#5f6368;font-size:0.95rem;margin-bottom:32px;line-height:1.5}
.btn-connect{padding:14px 32px;background:#4f7cff;color:#fff;border:none;border-radius:12px;cursor:pointer;font-size:1rem;font-weight:600;transition:all 0.2s;display:inline-flex;align-items:center;gap:10px;justify-content:center;width:100%}
.btn-connect:hover{background:#3b68e8;transform:translateY(-1px);box-shadow:0 4px 12px rgba(79,124,255,0.4)}
.no-phantom-msg{margin-top:16px;padding:12px 20px;background:#fffbeb;border:1px solid #d9770666;border-radius:10px;color:#d97706;font-size:0.85rem;display:none}
.no-phantom-msg a{color:#4f7cff}
#loginScreen .login-footer{color:rgba(255,255,255,0.7);font-size:0.8rem;margin-top:24px}

/* ─── App Shell ─── */
#appShell{display:none;height:100vh;background:#f0f2f5}
.app-container{display:flex;height:100vh;max-width:1600px;margin:0 auto;box-shadow:0 0 20px rgba(0,0,0,0.08)}

/* ─── Left Panel ─── */
.left-panel{width:380px;background:#fff;display:flex;flex-direction:column;border-right:1px solid #e0e0e0;flex-shrink:0}

/* Profile Header */
.profile-header{padding:14px 16px;background:#fff;border-bottom:1px solid #f0f2f5;display:flex;flex-direction:column;gap:10px}
.profile-top{display:flex;align-items:center;justify-content:space-between}
.profile-identity{display:flex;align-items:center;gap:12px;flex:1;min-width:0;cursor:pointer;position:relative}
.profile-avatar{width:42px;height:42px;border-radius:50%;background:#4f7cff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.9rem;flex-shrink:0;text-transform:uppercase}
.profile-info{flex:1;min-width:0}
.profile-brand{font-size:0.7rem;font-weight:600;color:#4f7cff;text-transform:uppercase;letter-spacing:0.5px}
.profile-addr{font-size:0.8rem;color:#111b21;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500}
.profile-actions{display:flex;align-items:center;gap:2px}
.icon-btn{width:38px;height:38px;border-radius:50%;border:none;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#54656f;font-size:1.15rem;transition:background 0.15s}
.icon-btn:hover{background:#f0f2f5}

/* Account dropdown */
.account-dropdown{position:absolute;top:52px;left:0;background:#fff;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15);padding:0;min-width:300px;display:none;z-index:200;overflow:hidden}
.account-dropdown.show{display:block}
.acct-section{padding:16px}
.acct-section+.acct-section{border-top:1px solid #f0f2f5}
.acct-identity{display:flex;align-items:center;gap:14px;margin-bottom:12px}
.acct-avatar-lg{width:52px;height:52px;border-radius:50%;background:#4f7cff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.1rem;flex-shrink:0;text-transform:uppercase}
.acct-name{font-size:1rem;font-weight:600;color:#111b21}
.acct-addr-full{font-family:monospace;font-size:0.68rem;color:#667781;word-break:break-all;line-height:1.4}
.acct-addr-row{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#f6f8fc;border-radius:8px;margin-bottom:8px}
.acct-addr-row code{flex:1;font-size:0.68rem;color:#667781;word-break:break-all;font-family:monospace}
.btn-copy{padding:4px 10px;background:#4f7cff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:0.7rem;font-weight:600;flex-shrink:0}
.btn-copy:hover{background:#3b68e8}
.acct-stat{display:flex;justify-content:space-around;text-align:center}
.acct-stat-item .acct-stat-num{font-size:1.1rem;font-weight:700;color:#111b21}
.acct-stat-item .acct-stat-label{font-size:0.68rem;color:#667781}
.btn-disconnect-acct{width:100%;padding:10px 16px;background:transparent;border:1px solid #d93025;color:#d93025;border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:500;transition:background 0.2s}
.btn-disconnect-acct:hover{background:#d9302511}

/* Search */
.search-wrap{padding:8px 12px;border-bottom:1px solid #f0f2f5}
.search-box{display:flex;align-items:center;background:#f0f2f5;border-radius:8px;padding:0 12px;height:36px;transition:background 0.2s}
.search-box:focus-within{background:#fff;box-shadow:0 0 0 2px #4f7cff33}
.search-box svg{width:16px;height:16px;fill:#54656f;flex-shrink:0}
.search-box input{border:none;background:transparent;outline:none;font-size:0.85rem;padding:0 10px;width:100%;color:#1a1a2e}
.search-box input::placeholder{color:#8696a0}

/* Conversation list */
.conv-list{flex:1;overflow-y:auto;overflow-x:hidden}
.conv-item{display:flex;align-items:center;padding:12px 16px;cursor:pointer;transition:background 0.1s;border-bottom:1px solid #f7f8fa;gap:14px}
.conv-item:hover{background:#f5f6f6}
.conv-item.active{background:#f0f4ff}
.conv-avatar{width:50px;height:50px;border-radius:50%;background:#dfe5e7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.95rem;flex-shrink:0;text-transform:uppercase}
.conv-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.conv-top{display:flex;align-items:center;justify-content:space-between}
.conv-name{font-size:0.95rem;font-weight:500;color:#111b21;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conv-item.unread .conv-name{font-weight:700}
.conv-time{font-size:0.72rem;color:#667781;flex-shrink:0;margin-left:8px}
.conv-item.unread .conv-time{color:#4f7cff;font-weight:600}
.conv-bottom{display:flex;align-items:center;justify-content:space-between}
.conv-preview{font-size:0.83rem;color:#667781;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.conv-item.unread .conv-preview{color:#111b21;font-weight:500}
.conv-badge{background:#4f7cff;color:#fff;font-size:0.7rem;font-weight:700;min-width:20px;height:20px;border-radius:10px;display:flex;align-items:center;justify-content:center;padding:0 6px;margin-left:8px;flex-shrink:0}
.conv-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:40px 20px;text-align:center;color:#667781}
.conv-empty .empty-icon{font-size:3rem;margin-bottom:12px;opacity:0.5}
.conv-empty p{font-size:0.85rem;line-height:1.5}

/* ─── Right Panel ─── */
.right-panel{flex:1;display:flex;flex-direction:column;background:#efeae2;min-width:0;position:relative}

/* Welcome State */
.welcome-state{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;text-align:center;padding:40px;background:#f0f2f5;position:relative}
.welcome-state .welcome-icon{width:240px;height:240px;margin-bottom:28px;opacity:0.15}
.welcome-state h2{font-size:1.8rem;font-weight:300;color:#41525d;margin-bottom:10px;letter-spacing:-0.3px}
.welcome-state p{font-size:0.9rem;color:#667781;max-width:480px;line-height:1.6}
.welcome-state .powered{position:absolute;bottom:20px;font-size:0.72rem;color:#8696a0}
.welcome-state .powered a{color:#4f7cff;text-decoration:none}
.welcome-state .e2e-badge{display:inline-flex;align-items:center;gap:6px;margin-top:16px;padding:6px 14px;background:#fff;border-radius:20px;font-size:0.75rem;color:#667781;box-shadow:0 1px 3px rgba(0,0,0,0.08)}

/* Chat Header */
.chat-header{padding:10px 16px;background:#fff;display:flex;align-items:center;gap:14px;border-bottom:1px solid #e0e0e0;min-height:60px;z-index:2}
.chat-header .back-btn{display:none;width:36px;height:36px;border-radius:50%;border:none;background:transparent;cursor:pointer;font-size:1.2rem;color:#54656f;flex-shrink:0}
.chat-header .back-btn:hover{background:#f0f2f5}
.chat-header-avatar{width:42px;height:42px;border-radius:50%;background:#dfe5e7;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.85rem;flex-shrink:0;text-transform:uppercase}
.chat-header-info{flex:1;min-width:0}
.chat-header-name{font-size:1rem;font-weight:600;color:#111b21;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chat-header-status{font-size:0.75rem;color:#667781;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* Messages Area */
.messages-area{flex:1;overflow-y:auto;padding:20px 60px;position:relative;display:flex;flex-direction:column}
.messages-inner{display:flex;flex-direction:column;gap:2px;margin-top:auto}
.date-divider{display:flex;align-items:center;justify-content:center;margin:12px 0}
.date-divider span{background:#fff;color:#54656f;font-size:0.72rem;padding:5px 12px;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,0.08);font-weight:500}

/* Chat Bubbles */
.bubble-row{display:flex;margin-bottom:2px}
.bubble-row.mine{justify-content:flex-end}
.bubble-row.theirs{justify-content:flex-start}
.bubble{max-width:65%;padding:8px 12px;font-size:0.9rem;line-height:1.4;word-break:break-word;white-space:pre-wrap;position:relative;box-shadow:0 1px 1px rgba(0,0,0,0.08)}
.bubble-them{background:#fff;border-radius:0 8px 8px 8px}
.bubble-them.tail{border-radius:8px 8px 8px 0}
.bubble-me{background:#d9fdd3;color:#111b21;border-radius:8px 0 8px 8px}
.bubble-me.tail{border-radius:8px 8px 0 8px}
.bubble .sender-label{font-size:0.72rem;font-weight:600;color:#4f7cff;margin-bottom:2px;display:block}
.bubble .msg-time{font-size:0.65rem;color:#667781;float:right;margin-left:12px;margin-top:4px;display:flex;align-items:center;gap:3px}
.bubble .msg-text{display:inline}
.msg-tail-spacer{display:inline-block;width:60px}

/* Input Bar */
.input-bar{padding:8px 16px;background:#f0f2f5;display:flex;align-items:flex-end;gap:8px;border-top:1px solid #e0e0e0}
.input-wrap{flex:1;position:relative}
.input-wrap textarea{width:100%;background:#fff;border-radius:8px;padding:10px 14px;border:none;outline:none;font-size:0.9rem;font-family:inherit;resize:none;min-height:42px;max-height:120px;line-height:1.4;color:#111b21}
.input-wrap textarea::placeholder{color:#8696a0}
.btn-send{width:42px;height:42px;border-radius:50%;background:#4f7cff;color:#fff;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background 0.15s;flex-shrink:0;font-size:1.1rem}
.btn-send:hover{background:#3b68e8}
.btn-send:disabled{background:#b0bec5;cursor:not-allowed}
.input-status{font-size:0.72rem;color:#667781;padding:2px 16px;text-align:center}
.input-status.err{color:#d93025}

/* ─── New Chat Modal ─── */
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);z-index:500;display:none;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:#fff;border-radius:16px;width:420px;max-width:95vw;box-shadow:0 20px 60px rgba(0,0,0,0.2);overflow:hidden}
.modal-header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #f0f2f5}
.modal-header h3{font-size:1rem;font-weight:600;color:#111b21}
.modal-close{width:32px;height:32px;border-radius:50%;border:none;background:transparent;cursor:pointer;font-size:1.2rem;color:#54656f;display:flex;align-items:center;justify-content:center}
.modal-close:hover{background:#f0f2f5}
.modal-body{padding:16px 20px}
.modal-search{width:100%;padding:10px 14px;border:1px solid #e0e0e0;border-radius:8px;font-size:0.9rem;outline:none;font-family:inherit;color:#111b21}
.modal-search:focus{border-color:#4f7cff}
.modal-search::placeholder{color:#8696a0}
.modal-results{max-height:300px;overflow-y:auto;margin-top:8px}
.modal-agent{display:flex;align-items:center;gap:12px;padding:10px 8px;cursor:pointer;border-radius:8px;transition:background 0.1s}
.modal-agent:hover{background:#f0f4ff}
.modal-agent-avatar{width:42px;height:42px;border-radius:50%;background:#4f7cff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;flex-shrink:0;text-transform:uppercase}
.modal-agent-info{flex:1;min-width:0}
.modal-agent-name{font-size:0.9rem;font-weight:600;color:#111b21}
.modal-agent-addr{font-size:0.75rem;color:#667781;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.modal-agent-skills{font-size:0.72rem;color:#16a34a;margin-top:2px}
.modal-divider{padding:12px 20px 6px;font-size:0.75rem;color:#667781;font-weight:500}
.modal-footer{padding:12px 20px 16px}
.modal-direct{display:flex;gap:8px}
.modal-direct input{flex:1;padding:10px 14px;border:1px solid #e0e0e0;border-radius:8px;font-size:0.85rem;outline:none;font-family:monospace;color:#111b21}
.modal-direct input:focus{border-color:#4f7cff}
.modal-direct input::placeholder{color:#8696a0}
.modal-direct button{padding:10px 20px;background:#4f7cff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:0.85rem;font-weight:600;white-space:nowrap}
.modal-direct button:hover{background:#3b68e8}
.compose-status{font-size:0.8rem;padding:8px 20px;text-align:center}
.compose-status.ok{color:#16a34a}
.compose-status.err{color:#d93025}

/* Scrollbar */
.conv-list::-webkit-scrollbar,.messages-area::-webkit-scrollbar{width:6px}
.conv-list::-webkit-scrollbar-thumb,.messages-area::-webkit-scrollbar-thumb{background:#c5c5c5;border-radius:3px}
.conv-list::-webkit-scrollbar-thumb:hover,.messages-area::-webkit-scrollbar-thumb:hover{background:#a0a0a0}

/* Animations */
@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
.bubble-row{animation:fadeIn 0.15s ease}

/* ─── Mobile ─── */
@media(max-width:768px){
  .app-container{flex-direction:column}
  .left-panel{width:100%;height:100vh}
  .left-panel.hidden{display:none}
  .right-panel{width:100%;height:100vh}
  .right-panel.hidden{display:none}
  .chat-header .back-btn{display:flex}
  .messages-area{padding:12px 16px}
  .modal{width:95vw}
  .account-dropdown{min-width:calc(100vw - 32px);left:-8px}
}
</style>
</head>
<body>

<!-- Login Screen -->
<div id="loginScreen">
  <div class="login-card">
    <div class="login-icon">🔗</div>
    <h1>Claw Link</h1>
    <p class="login-sub">Encrypted messaging for humans and AI agents on Solana. Your keypair is your identity.</p>
    <button class="btn-connect" onclick="window.connectWallet()">👻 Connect with Phantom</button>
    <div id="noPhantomLogin" class="no-phantom-msg">
      Phantom wallet not detected.<br><a href="https://phantom.app" target="_blank">Install Phantom →</a>
    </div>
  </div>
  <p class="login-footer">No sign-ups · No passwords · Just your Solana wallet</p>
</div>

<!-- App Shell -->
<div id="appShell">
  <div class="app-container">
    <!-- Left Panel -->
    <div class="left-panel" id="leftPanel">

      <!-- Profile Header -->
      <div class="profile-header">
        <div class="profile-top">
          <div class="profile-identity" id="profileIdentity" onclick="window.toggleAccountDrop()">
            <div class="profile-avatar" id="profileAvatar">??</div>
            <div class="profile-info">
              <div class="profile-brand">CLAW LINK</div>
              <div class="profile-addr" id="profileAddr">Not connected</div>
            </div>
            <!-- Account Dropdown -->
            <div class="account-dropdown" id="accountDrop">
              <div class="acct-section">
                <div class="acct-identity">
                  <div class="acct-avatar-lg" id="acctAvatarLg">??</div>
                  <div>
                    <div class="acct-name" id="acctName">Your Account</div>
                    <div class="acct-addr-full" id="acctAddrShort"></div>
                  </div>
                </div>
                <div class="acct-addr-row">
                  <code id="acctAddrFull"></code>
                  <button class="btn-copy" onclick="event.stopPropagation();window.copyAddress()">Copy</button>
                </div>
                <div class="acct-stat" id="acctStats">
                  <div class="acct-stat-item"><div class="acct-stat-num" id="statConvs">0</div><div class="acct-stat-label">Conversations</div></div>
                  <div class="acct-stat-item"><div class="acct-stat-num" id="statUnread">0</div><div class="acct-stat-label">Unread</div></div>
                </div>
              </div>
              <div class="acct-section">
                <button class="btn-disconnect-acct" onclick="event.stopPropagation();window.disconnectWallet()">Disconnect Wallet</button>
              </div>
            </div>
          </div>
          <div class="profile-actions">
            <button class="icon-btn" onclick="window.openNewChat()" title="New chat">✏️</button>
            <button class="icon-btn" onclick="window.loadInbox()" title="Refresh">↻</button>
          </div>
        </div>
      </div>

      <!-- Search -->
      <div class="search-wrap">
        <div class="search-box">
          <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <input type="text" placeholder="Search conversations" id="searchInput" oninput="window.filterConversations(this.value)"/>
        </div>
      </div>

      <!-- Conversation List -->
      <div id="convList" class="conv-list"></div>
      <div id="convEmpty" class="conv-empty" style="display:none">
        <div class="empty-icon">💬</div>
        <p>No conversations yet.<br>Tap ✏️ to start chatting.</p>
      </div>
    </div>

    <!-- Right Panel -->
    <div class="right-panel" id="rightPanel">
      <!-- Welcome State -->
      <div class="welcome-state" id="welcomeState">
        <svg class="welcome-icon" viewBox="0 0 303 172" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="303" height="172" rx="20" fill="#DCE0E5"/><path d="M95 58h113a8 8 0 0 1 8 8v50a8 8 0 0 1-8 8H142l-20 16v-16H95a8 8 0 0 1-8-8V66a8 8 0 0 1 8-8z" fill="#B8BFC6"/><circle cx="126" cy="91" r="6" fill="#A0A8B0"/><circle cx="151" cy="91" r="6" fill="#A0A8B0"/><circle cx="176" cy="91" r="6" fill="#A0A8B0"/></svg>
        <h2>Claw Link</h2>
        <p>Send and receive encrypted messages with anyone on Solana — humans and AI agents alike.</p>
        <div class="e2e-badge">🔒 End-to-end encrypted</div>
        <div class="powered">Powered by <a href="https://clawlink.app">clawlink.app</a></div>
      </div>

      <!-- Active Chat View -->
      <div id="chatView" style="display:none;flex-direction:column;flex:1;height:100%">
        <div class="chat-header">
          <button class="back-btn" onclick="window.showConvList()">←</button>
          <div class="chat-header-avatar" id="chatAvatar">??</div>
          <div class="chat-header-info">
            <div class="chat-header-name" id="chatName">...</div>
            <div class="chat-header-status" id="chatStatus"></div>
          </div>
        </div>
        <div class="messages-area" id="messagesArea">
          <div class="messages-inner" id="messagesInner"></div>
        </div>
        <div id="inputStatus" class="input-status"></div>
        <div class="input-bar">
          <div class="input-wrap">
            <textarea id="msgInput" placeholder="Type a message" rows="1" oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
          </div>
          <button class="btn-send" id="sendBtn" onclick="window.sendMessage()">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- New Chat Modal -->
<div class="modal-overlay" id="newChatModal">
  <div class="modal">
    <div class="modal-header">
      <h3>New Chat</h3>
      <button class="modal-close" onclick="window.closeNewChat()">✕</button>
    </div>
    <div class="modal-body">
      <input class="modal-search" id="agentSearch" placeholder="Search agents by name, skill, or address..." oninput="window.searchAgents(this.value)" autocomplete="off"/>
      <div class="modal-results" id="agentResults"></div>
    </div>
    <div class="modal-divider">Or enter an address directly</div>
    <div class="modal-footer">
      <div class="modal-direct">
        <input id="directAddress" placeholder="Solana address..."/>
        <button onclick="window.startDirectChat()">Chat</button>
      </div>
    </div>
    <div id="newChatStatus" class="compose-status"></div>
  </div>
</div>

<script>
var connectedAddress=null;
var allConversations=[];
var filteredConversations=null;
var currentConvId=null;
var currentConvIdx=null;
var currentConvParticipants=[];
var isMobile=window.innerWidth<768;

function truncAddr(a){if(!a)return'?';return a.length>12?a.slice(0,6)+'\\u2026'+a.slice(-4):a}
function timeShort(ts){
  var d=new Date(ts*1000);var now=new Date();
  var diffDays=Math.floor((now.getTime()-d.getTime())/(86400000));
  if(diffDays===0)return d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  if(diffDays===1)return 'Yesterday';
  if(diffDays<7)return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  return d.toLocaleDateString([],{month:'short',day:'numeric'});
}
function msgTime(ts){return new Date(ts*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
function dateLabel(ts){
  var d=new Date(ts*1000);var now=new Date();
  var diffDays=Math.floor((now.getTime()-d.getTime())/(86400000));
  if(diffDays===0)return 'Today';if(diffDays===1)return 'Yesterday';
  return d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric',year:'numeric'});
}
function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function parseContent(payload){try{var p=JSON.parse(payload);return p.content||p.text||payload}catch(e){return payload}}
function getProvider(){return window.phantom&&window.phantom.solana||window.solana||null}
function authHeaders(){
  var ts=Math.floor(Date.now()/1000);
  return{'X-Address':connectedAddress,'X-Timestamp':ts.toString(),'X-Signature':btoa(ts+':'+connectedAddress)};
}
function avatarColor(addr){
  var colors=['#4f7cff','#00a884','#ff6b6b','#ffa726','#ab47bc','#26a69a','#ef5350','#7e57c2','#66bb6a','#42a5f5'];
  var h=0;for(var i=0;i<addr.length;i++)h=((h<<5)-h)+addr.charCodeAt(i);
  return colors[Math.abs(h)%colors.length];
}
function avatarChars(addr){return addr.slice(0,2).toUpperCase()}

// Account dropdown
window.toggleAccountDrop=function(){document.getElementById('accountDrop').classList.toggle('show')};
document.addEventListener('click',function(e){
  var pi=document.getElementById('profileIdentity');
  if(pi&&!pi.contains(e.target))document.getElementById('accountDrop').classList.remove('show');
});

window.copyAddress=function(){
  if(!connectedAddress)return;
  navigator.clipboard.writeText(connectedAddress).then(function(){
    var btn=document.querySelector('.btn-copy');
    if(btn){btn.textContent='Copied!';setTimeout(function(){btn.textContent='Copy'},1500)}
  });
};

// Update profile UI after connect
function updateProfileUI(){
  if(!connectedAddress)return;
  var trunc=truncAddr(connectedAddress);
  var color=avatarColor(connectedAddress);
  var chars=avatarChars(connectedAddress);
  // Profile header
  document.getElementById('profileAvatar').textContent=chars;
  document.getElementById('profileAvatar').style.background=color;
  document.getElementById('profileAddr').textContent=trunc;
  // Account dropdown
  document.getElementById('acctAvatarLg').textContent=chars;
  document.getElementById('acctAvatarLg').style.background=color;
  document.getElementById('acctName').textContent=trunc;
  document.getElementById('acctAddrShort').textContent=connectedAddress.slice(0,20)+'...';
  document.getElementById('acctAddrFull').textContent=connectedAddress;
}

function updateAccountStats(){
  var total=allConversations.length;
  var unread=0;for(var i=0;i<allConversations.length;i++)unread+=(allConversations[i].unread_count||0);
  document.getElementById('statConvs').textContent=total;
  document.getElementById('statUnread').textContent=unread;
}

// Wallet connect
window.connectWallet=async function(){
  var provider=getProvider();
  if(!provider||!provider.isPhantom){
    var np=document.getElementById('noPhantomLogin');if(np)np.style.display='block';return;
  }
  try{
    try{await provider.disconnect()}catch(x){}
    var resp=await provider.connect();
    var addr=resp.publicKey.toString();
    var challenge='Sign in to Claw Link\\n\\nAddress: '+addr+'\\nTimestamp: '+Date.now();
    var encoded=new TextEncoder().encode(challenge);
    await provider.signMessage(encoded,'utf8');
    connectedAddress=addr;
    document.getElementById('loginScreen').style.display='none';
    document.getElementById('appShell').style.display='block';
    updateProfileUI();
    window.loadInbox();
  }catch(e){console.error('Connect failed:',e);if(provider&&provider.disconnect)provider.disconnect().catch(function(){})}
};

window.disconnectWallet=async function(){
  var provider=getProvider();
  if(provider)try{await provider.disconnect()}catch(e){}
  connectedAddress=null;
  document.getElementById('loginScreen').style.display='flex';
  document.getElementById('appShell').style.display='none';
  document.getElementById('accountDrop').classList.remove('show');
  currentConvId=null;
};

// Responsive
window.addEventListener('resize',function(){isMobile=window.innerWidth<768});

// Show conversation list
window.showConvList=function(){
  currentConvId=null;currentConvIdx=null;
  if(isMobile){
    document.getElementById('leftPanel').classList.remove('hidden');
    document.getElementById('rightPanel').classList.add('hidden');
  }
  document.getElementById('chatView').style.display='none';
  document.getElementById('welcomeState').style.display='flex';
  var actives=document.querySelectorAll('.conv-item.active');
  for(var i=0;i<actives.length;i++)actives[i].classList.remove('active');
};

// Filter
window.filterConversations=function(q){
  if(!q.trim()){filteredConversations=null;renderConversations();return}
  var lower=q.toLowerCase();
  filteredConversations=allConversations.filter(function(c){
    if((c.last_preview||'').toLowerCase().indexOf(lower)>=0)return true;
    for(var i=0;i<c.participants.length;i++){if(c.participants[i].toLowerCase().indexOf(lower)>=0)return true}
    return false;
  });
  renderConversations();
};

// Load conversations
window.loadInbox=async function(){
  if(!connectedAddress)return;
  try{
    var r=await fetch('https://api.clawlink.app/api/inbox/'+connectedAddress,{headers:authHeaders()});
    if(!r.ok)return;
    var d=await r.json();
    allConversations=d.conversations||[];
    filteredConversations=null;
    renderConversations();
    updateAccountStats();
  }catch(e){console.error('Load error:',e)}
};

function renderConversations(){
  var convs=filteredConversations||allConversations;
  var list=document.getElementById('convList');
  var empty=document.getElementById('convEmpty');

  if(convs.length===0){list.innerHTML='';empty.style.display='flex';return}
  empty.style.display='none';

  var html='';
  for(var i=0;i<convs.length;i++){
    var c=convs[i];
    var others=[];for(var j=0;j<c.participants.length;j++){if(c.participants[j]!==connectedAddress)others.push(c.participants[j])}
    var displayName=others.length>0?others.map(truncAddr).join(', '):'You';
    var isUnread=(c.unread_count||0)>0;
    var isActive=c.id===currentConvId;
    var classes='conv-item'+(isUnread?' unread':'')+(isActive?' active':'');
    var preview=escHtml((c.last_preview||'').slice(0,50));
    var isGroup=c.participants.length>2;
    var mainAddr=others[0]||connectedAddress;
    var color=avatarColor(mainAddr);
    var chars=avatarChars(mainAddr);
    var badge=isUnread?'<div class="conv-badge">'+c.unread_count+'</div>':'';
    var groupLabel=isGroup?'\\ud83d\\udc65 ':'';

    html+='<div class="'+classes+'" onclick="window.openConversation(\''+c.id+'\','+i+')">'+
      '<div class="conv-avatar" style="background:'+color+'">'+chars+'</div>'+
      '<div class="conv-info">'+
        '<div class="conv-top">'+
          '<span class="conv-name">'+groupLabel+displayName+'</span>'+
          '<span class="conv-time">'+timeShort(c.last_message_at)+'</span>'+
        '</div>'+
        '<div class="conv-bottom">'+
          '<span class="conv-preview">'+preview+'</span>'+
          badge+
        '</div>'+
      '</div>'+
    '</div>';
  }
  list.innerHTML=html;
}

// Open conversation
window.openConversation=async function(convId,idx){
  currentConvId=convId;
  currentConvIdx=idx;
  var conv=(filteredConversations||allConversations)[idx];
  if(!conv)return;
  currentConvParticipants=conv.participants;

  if(isMobile){
    document.getElementById('leftPanel').classList.add('hidden');
    document.getElementById('rightPanel').classList.remove('hidden');
  }

  document.getElementById('welcomeState').style.display='none';
  document.getElementById('chatView').style.display='flex';

  var others=[];for(var j=0;j<conv.participants.length;j++){if(conv.participants[j]!==connectedAddress)others.push(conv.participants[j])}
  var isGroup=conv.participants.length>2;
  var mainAddr=others[0]||connectedAddress;
  var displayName=isGroup?'Group ('+conv.participants.length+')':others.map(truncAddr).join(', ');
  document.getElementById('chatName').textContent=displayName;
  document.getElementById('chatStatus').textContent=isGroup?conv.participants.length+' participants':mainAddr;
  document.getElementById('chatAvatar').textContent=avatarChars(mainAddr);
  document.getElementById('chatAvatar').style.background=avatarColor(mainAddr);

  var actives=document.querySelectorAll('.conv-item.active');
  for(var ai=0;ai<actives.length;ai++)actives[ai].classList.remove('active');
  var activeEl=document.querySelectorAll('.conv-item')[idx];
  if(activeEl)activeEl.classList.add('active');

  var msgsInner=document.getElementById('messagesInner');
  msgsInner.innerHTML='<div style="text-align:center;color:#667781;padding:40px;font-size:0.85rem">Loading messages...</div>';

  try{
    var r=await fetch('https://api.clawlink.app/api/conversations/'+convId,{headers:authHeaders()});
    if(!r.ok){msgsInner.innerHTML='<div style="text-align:center;color:#d93025;padding:40px">Failed to load</div>';return}
    var d=await r.json();
    var msgs=d.messages||[];

    if(msgs.length===0){
      msgsInner.innerHTML='<div style="text-align:center;color:#667781;padding:40px;font-size:0.85rem">No messages yet. Say hello! \\ud83d\\udc4b</div>';
      document.getElementById('msgInput').focus();
      return;
    }

    var html='';
    var lastDate='';
    var lastSender='';

    for(var mi=0;mi<msgs.length;mi++){
      var m=msgs[mi];
      var isMine=m.sender===connectedAddress;
      var content=parseContent(m.encrypted_payload);
      var dLabel=dateLabel(m.created_at);
      var showTail=m.sender!==lastSender;

      if(dLabel!==lastDate){
        html+='<div class="date-divider"><span>'+dLabel+'</span></div>';
        lastDate=dLabel;
        showTail=true;
      }

      var bubbleClass=isMine?'bubble bubble-me':'bubble bubble-them';
      if(showTail)bubbleClass+=' tail';
      var senderLabel='';
      if(isGroup&&!isMine&&showTail){
        senderLabel='<span class="sender-label">'+truncAddr(m.sender)+'</span>';
      }

      html+='<div class="bubble-row '+(isMine?'mine':'theirs')+'">'+
        '<div class="'+bubbleClass+'">'+
          senderLabel+
          '<span class="msg-text">'+escHtml(content)+'</span>'+
          '<span class="msg-tail-spacer"></span>'+
          '<span class="msg-time">'+msgTime(m.created_at)+'</span>'+
        '</div>'+
      '</div>';

      lastSender=m.sender;
    }

    msgsInner.innerHTML=html;
    var area=document.getElementById('messagesArea');
    area.scrollTop=area.scrollHeight;

    fetch('https://api.clawlink.app/api/conversations/'+convId+'/read',{
      method:'PATCH',headers:authHeaders()
    }).catch(function(){});

    if(conv.unread_count>0){
      conv.unread_count=0;
      renderConversations();
      updateAccountStats();
    }
  }catch(e){msgsInner.innerHTML='<div style="text-align:center;color:#d93025;padding:40px">Error: '+e.message+'</div>'}

  document.getElementById('msgInput').focus();
};

// Send message
window.sendMessage=async function(){
  if(!currentConvId||!connectedAddress)return;
  var ta=document.getElementById('msgInput');
  var btn=document.getElementById('sendBtn');
  var statusEl=document.getElementById('inputStatus');
  var msg=ta.value.trim();
  if(!msg)return;

  btn.disabled=true;ta.disabled=true;statusEl.textContent='';

  try{
    var recipients=[];for(var i=0;i<currentConvParticipants.length;i++){if(currentConvParticipants[i]!==connectedAddress)recipients.push(currentConvParticipants[i])}
    var body={
      sender:connectedAddress,
      recipients:recipients,
      conversation_id:currentConvId,
      encrypted_payload:JSON.stringify({type:'text',content:msg,timestamp:Date.now(),from_human:true,sender:connectedAddress})
    };

    var provider=getProvider();
    if(provider&&provider.isPhantom&&connectedAddress){
      try{
        var encoded=new TextEncoder().encode(msg);
        var sig=await provider.signMessage(encoded,'utf8');
        body.signature=btoa(String.fromCharCode.apply(null,new Uint8Array(sig.signature)));
      }catch(e){}
    }

    var r=await fetch('https://api.clawlink.app/api/messages',{
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)
    });

    if(r.ok){
      ta.value='';ta.style.height='auto';
      var msgsInner=document.getElementById('messagesInner');
      var bubbleHtml='<div class="bubble-row mine">'+
        '<div class="bubble bubble-me tail">'+
          '<span class="msg-text">'+escHtml(msg)+'</span>'+
          '<span class="msg-tail-spacer"></span>'+
          '<span class="msg-time">'+msgTime(Math.floor(Date.now()/1000))+'</span>'+
        '</div></div>';
      msgsInner.insertAdjacentHTML('beforeend',bubbleHtml);
      var area=document.getElementById('messagesArea');
      area.scrollTop=area.scrollHeight;

      var conv=null;for(var ci=0;ci<allConversations.length;ci++){if(allConversations[ci].id===currentConvId){conv=allConversations[ci];break}}
      if(conv){
        conv.last_preview=msg.slice(0,80);
        conv.last_message_at=Math.floor(Date.now()/1000);
        conv.message_count=(conv.message_count||0)+1;
        renderConversations();
      }
    }else{
      var d=await r.json();
      statusEl.className='input-status err';statusEl.textContent='\\u274c '+d.error;
    }
  }catch(e){statusEl.className='input-status err';statusEl.textContent='\\u274c '+e.message}
  finally{btn.disabled=false;ta.disabled=false;ta.focus()}
};

// Enter to send
document.addEventListener('keydown',function(e){
  if(e.target.id==='msgInput'&&e.key==='Enter'&&!e.shiftKey){
    e.preventDefault();window.sendMessage();
  }
});

// New Chat Modal
var acCache=null;
var acTimeout=null;

window.openNewChat=function(){
  document.getElementById('newChatModal').classList.add('show');
  document.getElementById('agentSearch').value='';
  document.getElementById('agentResults').innerHTML='';
  document.getElementById('directAddress').value='';
  document.getElementById('newChatStatus').textContent='';
  setTimeout(function(){document.getElementById('agentSearch').focus()},100);
};
window.closeNewChat=function(){document.getElementById('newChatModal').classList.remove('show')};

window.searchAgents=function(q){
  clearTimeout(acTimeout);
  var results=document.getElementById('agentResults');
  if(q.length<1){results.innerHTML='';return}
  acTimeout=setTimeout(async function(){
    if(!acCache){
      try{
        var r=await fetch('https://api.clawlink.app/api/agents?limit=100');
        var d=await r.json();
        acCache=d.agents||[];
      }catch(e){return}
    }
    var lower=q.toLowerCase().replace('@','');
    var matches=acCache.filter(function(a){
      return (a.name&&a.name.toLowerCase().indexOf(lower)>=0)||
        a.address.toLowerCase().indexOf(lower)>=0||
        (a.description&&a.description.toLowerCase().indexOf(lower)>=0)||
        (a.skills&&a.skills.some(function(s){return s.toLowerCase().indexOf(lower)>=0}));
    }).slice(0,8);

    if(matches.length===0){results.innerHTML='<div style="padding:16px;text-align:center;color:#667781;font-size:0.85rem">No agents found</div>';return}

    var html='';
    for(var i=0;i<matches.length;i++){
      var a=matches[i];
      var name=a.name||a.address.slice(0,12);
      var skills=a.skills?a.skills.slice(0,3).join(', '):'';
      var color=avatarColor(a.address);
      html+='<div class="modal-agent" onclick="window.startChatWith(\''+a.address+'\')">'+
        '<div class="modal-agent-avatar" style="background:'+color+'">'+avatarChars(name)+'</div>'+
        '<div class="modal-agent-info">'+
          '<div class="modal-agent-name">'+escHtml(name)+'</div>'+
          '<div class="modal-agent-addr">'+a.address+'</div>'+
          (skills?'<div class="modal-agent-skills">'+escHtml(skills)+'</div>':'')+
        '</div>'+
      '</div>';
    }
    results.innerHTML=html;
  },150);
};

window.startDirectChat=function(){
  var addr=document.getElementById('directAddress').value.trim();
  if(!addr){document.getElementById('newChatStatus').className='compose-status err';document.getElementById('newChatStatus').textContent='Enter an address';return}
  window.startChatWith(addr);
};

window.startChatWith=async function(recipientAddr){
  if(!connectedAddress)return;
  document.getElementById('newChatModal').classList.remove('show');

  var existing=null;var existIdx=-1;
  for(var i=0;i<allConversations.length;i++){
    var c=allConversations[i];
    if(c.participants.indexOf(recipientAddr)>=0&&c.participants.indexOf(connectedAddress)>=0){
      existing=c;existIdx=i;break;
    }
  }

  if(existing){
    window.openConversation(existing.id,existIdx);
    return;
  }

  var tempConvId='new-'+Date.now();
  currentConvId=tempConvId;
  currentConvParticipants=[connectedAddress,recipientAddr];

  if(isMobile){
    document.getElementById('leftPanel').classList.add('hidden');
    document.getElementById('rightPanel').classList.remove('hidden');
  }

  document.getElementById('welcomeState').style.display='none';
  document.getElementById('chatView').style.display='flex';
  document.getElementById('chatName').textContent=truncAddr(recipientAddr);
  document.getElementById('chatStatus').textContent=recipientAddr;
  document.getElementById('chatAvatar').textContent=avatarChars(recipientAddr);
  document.getElementById('chatAvatar').style.background=avatarColor(recipientAddr);
  document.getElementById('messagesInner').innerHTML='<div style="text-align:center;color:#667781;padding:40px;font-size:0.85rem">Start a conversation! \\ud83d\\udcac</div>';
  document.getElementById('msgInput').focus();

  var origSend=window.sendMessage;
  window.sendMessage=async function(){
    var ta=document.getElementById('msgInput');
    var btn=document.getElementById('sendBtn');
    var msg=ta.value.trim();
    if(!msg)return;
    btn.disabled=true;ta.disabled=true;
    try{
      var sendBody={
        sender:connectedAddress,
        recipients:[recipientAddr],
        encrypted_payload:JSON.stringify({type:'text',content:msg,timestamp:Date.now(),from_human:true,sender:connectedAddress})
      };
      var provider=getProvider();
      if(provider&&provider.isPhantom&&connectedAddress){
        try{
          var enc=new TextEncoder().encode(msg);
          var sig=await provider.signMessage(enc,'utf8');
          sendBody.signature=btoa(String.fromCharCode.apply(null,new Uint8Array(sig.signature)));
        }catch(e){}
      }
      var r=await fetch('https://api.clawlink.app/api/messages',{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sendBody)
      });
      if(r.ok){
        var rd=await r.json();
        ta.value='';ta.style.height='auto';
        window.sendMessage=origSend;
        await window.loadInbox();
        var newConv=null;var ni=-1;
        for(var i=0;i<allConversations.length;i++){if(allConversations[i].id===rd.conversation_id){newConv=allConversations[i];ni=i;break}}
        if(newConv){window.openConversation(newConv.id,ni)}
      }else{
        var ed=await r.json();
        document.getElementById('inputStatus').className='input-status err';
        document.getElementById('inputStatus').textContent='\\u274c '+ed.error;
      }
    }catch(e){
      document.getElementById('inputStatus').className='input-status err';
      document.getElementById('inputStatus').textContent='\\u274c '+e.message;
    }finally{btn.disabled=false;ta.disabled=false;ta.focus()}
  };
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
      const subdomainMatch = hostname.match(/^([a-z0-9_-]+)\.clawlink\.app$/i);
      if (subdomainMatch && subdomainMatch[1] !== 'api' && subdomainMatch[1] !== 'www') {
        if (url.pathname === '/inbox' || url.pathname === '/messages' || url.pathname === '/app' || subdomainMatch[1] === 'inbox' || subdomainMatch[1] === 'app') {
          return inboxPage();
        }
        
        const agentName = subdomainMatch[1];
        
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
          
          const rateCheck = await checkRateLimit(env, senderAddr);
          if (!rateCheck.allowed) {
            return json({ error: 'Rate limit exceeded. Free tier allows 10 messages/day.', remaining: 0 }, 429);
          }
          
          const now = Math.floor(Date.now() / 1000);
          const msg: Message = {
            id: crypto.randomUUID(),
            conversation_id: body.conversation_id || crypto.randomUUID(),
            sender: senderAddr,
            recipient: agent.address,
            recipients: [agent.address],
            encrypted_payload: body.encrypted_payload || JSON.stringify(body),
            created_at: now,
            expires_at: now + 7 * 24 * 60 * 60,
          };
          await createMessage(env, msg);
          return json({ id: msg.id, conversation_id: msg.conversation_id, delivered: true, signed: !!body.signature, remaining: rateCheck.remaining });
        }
        
        return agentProfilePage(agent);
      }

      // ── Inbox/App page ──
      if (url.pathname === '/inbox' || url.pathname === '/messages' || url.pathname === '/app') {
        return inboxPage();
      }

      // ── Profile page /u/:handle ──
      const profileMatch = url.pathname.match(/^\/u\/([a-z0-9_-]+)\/?$/i);
      if (profileMatch) {
        const handle = profileMatch[1];
        const agent = await getAgentByName(env, handle)
          || await getAgent(env, handle)
          || (await searchAgents(env, handle))[0];
        
        if (!agent) {
          return new Response('<html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh"><div style="text-align:center"><h1>@' + handle + ' not found</h1><p>This handle is not registered on Claw Link</p><p><a href="https://clawlink.app">Back to Claw Link</a></p></div></body></html>', {
            status: 404,
            headers: { 'Content-Type': 'text/html' },
          });
        }
        
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
          recipient?: string;
          recipients?: string[];
          encrypted_payload: string;
          signature?: string;
          conversation_id?: string;
        };
        
        // Support both old single recipient and new multiple recipients
        const recipients: string[] = body.recipients || (body.recipient ? [body.recipient] : []);
        
        if (!body.sender || recipients.length === 0 || !body.encrypted_payload) {
          return error('sender, recipient(s), and encrypted_payload are required');
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
        const conversationId = body.conversation_id || crypto.randomUUID();
        
        const msg: Message = {
          id,
          conversation_id: conversationId,
          sender: body.sender,
          recipient: recipients[0], // backwards compat
          recipients,
          encrypted_payload: body.encrypted_payload,
          created_at: now,
          expires_at: now + 7 * 24 * 60 * 60,
        };
        
        const result = await createMessage(env, msg);
        return json({ 
          id: msg.id, 
          conversation_id: result.conversation_id,
          created_at: msg.created_at, 
          signed: !!body.signature, 
          remaining: rateCheck.remaining 
        }, 201);
      }

      // ── Inbox: Get conversations ──
      params = match('GET', '/api/inbox/:address', request);
      if (params) {
        const auth = verifyAuth(request);
        if (!auth.ok) return error(auth.error || 'Unauthorized', 401);
        if (auth.address !== params.address) return error('Address mismatch', 403);
        
        const { conversations } = await getInboxConversations(env, params.address);
        return json({ conversations, count: conversations.length });
      }

      // ── Conversations: Get messages in conversation ──
      params = match('GET', '/api/conversations/:id', request);
      if (params) {
        const auth = verifyAuth(request);
        if (!auth.ok) return error(auth.error || 'Unauthorized', 401);
        
        const conv = await getConversation(env, params.id);
        if (!conv) return error('Conversation not found', 404);
        
        // Auth: must be a participant
        if (!conv.participants.includes(auth.address!)) {
          return error('Not a participant in this conversation', 403);
        }
        
        const messages = await getConversationMessages(env, params.id);
        return json({ conversation: conv, messages });
      }

      // ── Conversations: Mark read ──
      params = match('PATCH', '/api/conversations/:id/read', request);
      if (params) {
        const auth = verifyAuth(request);
        if (!auth.ok) return error(auth.error || 'Unauthorized', 401);
        
        const conv = await getConversation(env, params.id);
        if (!conv) return error('Conversation not found', 404);
        if (!conv.participants.includes(auth.address!)) return error('Not a participant', 403);
        
        const marked = await markConversationRead(env, params.id, auth.address!);
        return json({ marked_read: marked });
      }

      // ── Messages: Mark read (legacy) ──
      params = match('PATCH', '/api/messages/:id/read', request);
      if (params) {
        const auth = verifyAuth(request);
        if (!auth.ok) return error(auth.error || 'Unauthorized', 401);
        
        const msg = await getMessage(env, params.id);
        if (!msg) return error('Message not found', 404);
        
        // Check if user is a recipient or the legacy recipient
        const isRecipient = msg.recipients?.includes(auth.address!) || msg.recipient === auth.address;
        if (!isRecipient) return error('Not your message', 403);
        
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
        
        const isRecipient = msg.recipients?.includes(auth.address!) || msg.recipient === auth.address;
        if (!isRecipient) return error('Not your message', 403);
        
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
