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
    try{await provider.disconnect()}catch(x){}
    const resp=await provider.connect();
    const addr=resp.publicKey.toString();
    // Require signature to prove wallet is unlocked
    const challenge='Sign in to Claw Link\\n\\nAddress: '+addr+'\\nTimestamp: '+Date.now();
    const encoded=new TextEncoder().encode(challenge);
    await provider.signMessage(encoded,'utf8');
    connectedAddress=addr;
    isAnon=false;
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
body{font-family:'Google Sans',Roboto,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f6f8fc;color:#1a1a2e;min-height:100vh;overflow:hidden}

/* ─── Top Bar ─── */
.topbar{height:64px;background:#fff;border-bottom:1px solid #e0e0e0;display:flex;align-items:center;padding:0 16px;position:fixed;top:0;left:0;right:0;z-index:100}
.topbar-left{display:flex;align-items:center;gap:12px;min-width:200px}
.hamburger{display:none;background:none;border:none;font-size:1.4rem;cursor:pointer;padding:8px;border-radius:50%;color:#5f6368}
.hamburger:hover{background:#f1f3f4}
.logo{font-size:1.25rem;font-weight:600;color:#1a1a2e;display:flex;align-items:center;gap:8px;text-decoration:none}
.logo span{color:#4f7cff}
.topbar-center{flex:1;max-width:720px;margin:0 auto;padding:0 16px}
.search-bar{display:flex;align-items:center;background:#edf2fc;border-radius:28px;padding:0 16px;height:46px;transition:background 0.2s,box-shadow 0.2s}
.search-bar:focus-within{background:#fff;box-shadow:0 1px 6px rgba(32,33,36,0.28)}
.search-bar svg{width:20px;height:20px;fill:#5f6368;flex-shrink:0}
.search-bar input{border:none;background:transparent;outline:none;font-size:0.95rem;padding:0 12px;width:100%;color:#1a1a2e}
.search-bar input::placeholder{color:#5f6368}
.topbar-right{display:flex;align-items:center;gap:8px;min-width:200px;justify-content:flex-end}
.btn-refresh{background:none;border:none;cursor:pointer;padding:8px;border-radius:50%;font-size:1.2rem;color:#5f6368;transition:background 0.2s}
.btn-refresh:hover{background:#f1f3f4}
.btn-refresh:active{transform:rotate(180deg)}
.wallet-btn{display:flex;align-items:center;gap:8px;background:#4f7cff;color:#fff;border:none;border-radius:24px;padding:8px 16px;cursor:pointer;font-size:0.85rem;font-weight:500;transition:background 0.2s}
.wallet-btn:hover{background:#3b68e8}
.wallet-avatar{width:32px;height:32px;border-radius:50%;background:#4f7cff;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.8rem;cursor:pointer;position:relative;text-transform:uppercase}
.wallet-dropdown{position:absolute;top:44px;right:0;background:#fff;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,0.15);padding:16px;min-width:260px;display:none;z-index:200}
.wallet-dropdown.show{display:block}
.wallet-dropdown .addr-full{font-family:monospace;font-size:0.75rem;color:#5f6368;word-break:break-all;margin-bottom:12px;padding:8px;background:#f6f8fc;border-radius:6px}
.wallet-dropdown .btn-disconnect{width:100%;padding:8px 16px;background:transparent;border:1px solid #d93025;color:#d93025;border-radius:8px;cursor:pointer;font-size:0.85rem;transition:background 0.2s}
.wallet-dropdown .btn-disconnect:hover{background:#d9302511}

/* ─── Layout ─── */
.layout{display:flex;height:calc(100vh - 64px);margin-top:64px}

/* ─── Sidebar ─── */
.sidebar{width:256px;background:#f6f8fc;padding:8px 12px;overflow-y:auto;flex-shrink:0;border-right:1px solid #e0e0e0}
.compose-btn{display:flex;align-items:center;gap:12px;background:#c2e7ff;color:#001d35;border:none;border-radius:16px;padding:16px 24px;cursor:pointer;font-size:0.9rem;font-weight:500;margin-bottom:4px;transition:box-shadow 0.2s;width:auto}
.compose-btn:hover{box-shadow:0 1px 3px rgba(0,0,0,0.2)}
.compose-btn svg{width:24px;height:24px;fill:#001d35}
.sidebar-nav{list-style:none;margin-top:4px}
.sidebar-nav li{margin:0}
.sidebar-nav li a{display:flex;align-items:center;gap:16px;padding:8px 24px 8px 12px;border-radius:0 24px 24px 0;color:#1a1a2e;text-decoration:none;font-size:0.875rem;font-weight:500;transition:background 0.15s;cursor:pointer}
.sidebar-nav li a:hover{background:#dfe3e8}
.sidebar-nav li a.active{background:#d3e3fd;color:#001d35;font-weight:700}
.sidebar-nav li a svg{width:20px;height:20px;fill:#444746;flex-shrink:0}
.sidebar-nav li a.active svg{fill:#001d35}
.nav-badge{margin-left:auto;background:#d93025;color:#fff;font-size:0.7rem;font-weight:700;padding:1px 7px;border-radius:10px;min-width:18px;text-align:center}
.sidebar-footer{margin-top:auto;padding-top:16px;border-top:1px solid #e0e0e0;font-size:0.75rem;color:#5f6368;text-align:center}
.sidebar-footer a{color:#4f7cff;text-decoration:none}

/* ─── Main Content ─── */
.main-content{flex:1;background:#fff;overflow-y:auto;display:flex;flex-direction:column;min-height:0}
.toolbar{display:flex;align-items:center;padding:8px 16px;border-bottom:1px solid #e0e0e0;gap:8px;min-height:48px}
.toolbar .select-all{width:18px;height:18px;cursor:pointer;accent-color:#4f7cff}
.toolbar .msg-count{font-size:0.8rem;color:#5f6368;margin-left:auto}

/* ─── Welcome / Not Connected ─── */
.welcome-panel{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:40px;text-align:center}
.welcome-panel h2{font-size:1.3rem;color:#1a1a2e;margin-bottom:8px;font-weight:500}
.welcome-panel p{color:#5f6368;font-size:0.9rem;margin-bottom:24px}
.welcome-panel .btn-wallet-lg{padding:14px 32px;background:#4f7cff;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:1rem;font-weight:600;transition:background 0.2s;display:inline-flex;align-items:center;gap:10px}
.welcome-panel .btn-wallet-lg:hover{background:#3b68e8}
.no-phantom{margin-top:12px;padding:12px 20px;background:#fffbeb;border:1px solid #d9770666;border-radius:8px;color:#d97706;font-size:0.85rem;display:none}
.no-phantom a{color:#4f7cff}

/* ─── Message List ─── */
.msg-list{flex:1}
.msg-row{display:flex;align-items:center;padding:0 16px;height:40px;border-bottom:1px solid #f1f3f4;cursor:pointer;transition:box-shadow 0.15s,background 0.1s;font-size:0.875rem;position:relative}
.msg-row:hover{box-shadow:0 2px 6px rgba(0,0,0,0.08);z-index:1}
.msg-row.unread{background:#fff;font-weight:600}
.msg-row.read{background:#f6f8fc}
.msg-row .cb{width:18px;height:18px;cursor:pointer;accent-color:#4f7cff;flex-shrink:0;margin-right:16px}
.msg-row .sender{width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#1a1a2e;flex-shrink:0;font-size:0.85rem}
.msg-row.unread .sender{font-weight:700}
.msg-row .preview-wrap{flex:1;display:flex;overflow:hidden;margin:0 12px}
.msg-row .subject{color:#1a1a2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-right:4px}
.msg-row .preview-text{color:#5f6368;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:400}
.msg-row .time{white-space:nowrap;color:#5f6368;font-size:0.75rem;flex-shrink:0;min-width:60px;text-align:right}
.msg-row.unread .time{color:#1a1a2e;font-weight:700}

/* ─── Expanded Message ─── */
.msg-expanded{display:none;border-bottom:1px solid #e0e0e0;padding:20px 60px 20px 50px;background:#fff;animation:slideDown 0.15s ease}
@keyframes slideDown{from{opacity:0;max-height:0}to{opacity:1;max-height:600px}}
.msg-expanded .msg-full-header{display:flex;justify-content:space-between;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #f1f3f4}
.msg-expanded .msg-full-sender{font-weight:600;font-size:0.95rem;color:#1a1a2e}
.msg-expanded .msg-full-time{font-size:0.8rem;color:#5f6368}
.msg-expanded .msg-full{font-size:0.9rem;color:#1a1a2e;line-height:1.7;white-space:pre-wrap;word-break:break-word;margin-bottom:16px}
.thread-messages{margin-top:4px}
.reply-section{margin-top:8px;padding:12px;border:1px solid #e0e0e0;border-radius:12px;background:#fff}
.reply-section textarea{width:100%;padding:10px;border:none;outline:none;background:transparent;color:#1a1a2e;font-family:inherit;resize:vertical;min-height:50px;font-size:0.9rem}
.reply-section textarea::placeholder{color:#94a3b8}
.reply-section .reply-actions{display:flex;align-items:center;gap:8px;margin-top:8px}
.reply-section .btn-send{padding:8px 22px;background:#4f7cff;color:#fff;border:none;border-radius:18px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:background 0.2s}
.reply-section .btn-send:hover{background:#3b68e8}
.reply-status{font-size:0.8rem;margin-left:8px}
.reply-status.ok{color:#16a34a}
.reply-status.err{color:#d93025}

/* ─── Empty State ─── */
.empty-state{display:none;flex-direction:column;align-items:center;justify-content:center;flex:1;padding:60px 20px;text-align:center;width:100%}
.empty-state svg{width:120px;height:120px;fill:#dadce0;margin-bottom:20px}
.empty-state h3{font-size:1.1rem;color:#1a1a2e;margin-bottom:8px;font-weight:500}
.empty-state p{color:#5f6368;font-size:0.85rem}

/* ─── Compose Modal (Gmail-style floating) ─── */
.compose-modal{position:fixed;bottom:0;right:24px;width:560px;background:#fff;border-radius:12px 12px 0 0;box-shadow:0 -2px 20px rgba(0,0,0,0.2);z-index:300;display:none;flex-direction:column;overflow:hidden}
.compose-modal.show{display:flex}
.compose-modal.minimized{height:48px;overflow:hidden}
.compose-modal .compose-header{display:flex;align-items:center;justify-content:space-between;background:#1a1a2e;color:#fff;padding:10px 16px;cursor:pointer;border-radius:12px 12px 0 0}
.compose-modal .compose-header h4{font-size:0.9rem;font-weight:500}
.compose-modal .compose-header-actions{display:flex;gap:4px}
.compose-modal .compose-header-actions button{background:none;border:none;color:#fff;font-size:1.1rem;cursor:pointer;padding:4px 8px;border-radius:4px;opacity:0.8}
.compose-modal .compose-header-actions button:hover{opacity:1;background:rgba(255,255,255,0.1)}
.compose-modal .compose-body{padding:0;flex:1;display:flex;flex-direction:column}
.compose-modal .compose-field{display:flex;align-items:center;padding:8px 16px;border-bottom:1px solid #f1f3f4}
.compose-modal .compose-field label{font-size:0.85rem;color:#5f6368;width:50px;flex-shrink:0}
.compose-modal .compose-field input{border:none;outline:none;flex:1;font-size:0.9rem;padding:4px 0;font-family:inherit;color:#1a1a2e}
.compose-modal .compose-field input::placeholder{color:#b0b8c1}
.compose-modal .compose-textarea{flex:1;padding:12px 16px;border:none;outline:none;resize:none;font-size:0.9rem;font-family:inherit;min-height:300px;color:#1a1a2e}
.compose-modal .compose-textarea::placeholder{color:#b0b8c1}
.compose-modal .compose-footer{display:flex;align-items:center;padding:12px 16px;border-top:1px solid #f1f3f4;gap:12px}
.compose-modal .compose-footer .btn-send{padding:8px 24px;background:#4f7cff;color:#fff;border:none;border-radius:18px;cursor:pointer;font-size:0.85rem;font-weight:600;transition:background 0.2s}
.compose-modal .compose-footer .btn-send:hover{background:#3b68e8}
.compose-status{font-size:0.8rem}
.compose-status.ok{color:#16a34a}
.compose-status.err{color:#d93025}

/* ─── Mobile ─── */
@media(max-width:768px){
  .sidebar{display:none;position:fixed;top:64px;left:0;bottom:0;width:280px;z-index:150;box-shadow:4px 0 12px rgba(0,0,0,0.15)}
  .sidebar.open{display:block}
  .sidebar-overlay{display:none;position:fixed;top:64px;left:0;right:0;bottom:0;background:rgba(0,0,0,0.3);z-index:140}
  .sidebar-overlay.show{display:block}
  .hamburger{display:block}
  .topbar-center{display:none}
  .msg-row .sender{width:120px}
  .compose-modal{width:100%;right:0;left:0;border-radius:12px 12px 0 0}
  .topbar-left{min-width:auto}
  .topbar-right{min-width:auto}
  .msg-expanded{padding:16px 20px}
}
</style>
</head>
<body>

<!-- Top Bar -->
<div class="topbar">
  <div class="topbar-left">
    <button class="hamburger" onclick="window.toggleSidebar()">☰</button>
    <a class="logo" href="/inbox">📬 <span>Claw Link</span></a>
  </div>
  <div class="topbar-center">
    <div class="search-bar">
      <svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
      <input type="text" placeholder="Search messages" id="searchInput" oninput="window.filterMessages(this.value)"/>
    </div>
  </div>
  <div class="topbar-right">
    <button class="btn-refresh" onclick="window.loadInbox()" title="Refresh" id="refreshBtn" style="display:none">↻</button>
    <div id="walletNotConnected">
      <button class="wallet-btn" id="connectBtn" onclick="window.connectWallet()">👻 Connect Wallet</button>
    </div>
    <div id="walletConnected" style="display:none">
      <div class="wallet-avatar" id="walletAvatar" onclick="window.toggleWalletDrop()">
        ??
        <div class="wallet-dropdown" id="walletDrop">
          <div class="addr-full" id="walletAddrFull"></div>
          <button class="btn-disconnect" onclick="event.stopPropagation();window.disconnectWallet()">Disconnect Wallet</button>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Sidebar Overlay (mobile) -->
<div class="sidebar-overlay" id="sidebarOverlay" onclick="window.toggleSidebar()"></div>

<!-- Login Screen (shown when not connected) -->
<div id="loginScreen" style="display:flex;align-items:center;justify-content:center;min-height:calc(100vh - 64px);margin-top:64px;background:#f6f8fc;flex-direction:column;text-align:center;padding:40px">
  <div style="font-size:3rem;margin-bottom:16px">📬</div>
  <h1 style="font-size:1.8rem;font-weight:700;margin-bottom:8px">Claw Link Inbox</h1>
  <p style="color:#5f6368;font-size:1rem;margin-bottom:32px;max-width:400px">End-to-end encrypted messaging for humans and AI agents on Solana</p>
  <button class="wallet-btn" style="padding:16px 32px;font-size:1rem;border-radius:12px" onclick="window.connectWallet()">👻 Connect Phantom Wallet</button>
  <div id="noPhantomLogin" style="margin-top:16px;padding:12px 20px;background:#fffbeb;border:1px solid #d9770666;border-radius:8px;color:#d97706;font-size:0.85rem;display:none">
    Phantom wallet not detected.<br><a href="https://phantom.app" target="_blank" style="color:#4f7cff">Install Phantom →</a>
  </div>
  <p style="margin-top:24px;font-size:0.8rem;color:#94a3b8">Your Solana keypair is your identity. No sign-ups needed.</p>
</div>

<!-- Layout (hidden until connected) -->
<div class="layout" id="appLayout" style="display:none">
  <!-- Sidebar -->
  <div class="sidebar" id="sidebar">
    <button class="compose-btn" onclick="window.openCompose()">
      <svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1.003 1.003 0 0 0 0-1.42l-2.34-2.34a1.003 1.003 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 1.84-1.82z"/></svg>
      Compose
    </button>
    <ul class="sidebar-nav">
      <li><a class="active" href="#inbox">
        <svg viewBox="0 0 24 24"><path d="M19 3H4.99c-1.11 0-1.98.89-1.98 2L3 19c0 1.1.88 2 1.99 2H19c1.1 0 2-.9 2-2V5c0-1.11-.9-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10z"/></svg>
        Inbox <span class="nav-badge" id="unreadBadge" style="display:none">0</span>
      </a></li>
      
      
    </ul>
    <div class="sidebar-footer">
      Powered by <a href="https://clawlink.app">Claw Link</a>
    </div>
  </div>

  <!-- Main Content -->
  <div class="main-content">
    <!-- Welcome (not connected) -->
    <div class="welcome-panel" id="welcomePanel">
      <h2>Welcome to Claw Link</h2>
      <p>Connect your Phantom wallet to view your messages</p>
      <button class="btn-wallet-lg" onclick="window.connectWallet()">👻 Connect Phantom Wallet</button>
      <div id="noPhantom" class="no-phantom">
        Phantom wallet not detected.<br><a href="https://phantom.app" target="_blank">Install Phantom →</a>
      </div>
    </div>

    <!-- Inbox Content (shown after connect) -->
    <div id="inboxContent" style="display:none">
      <div class="toolbar">
        <input type="checkbox" class="select-all" title="Select all" />
        <span class="msg-count" id="msgCount">Loading...</span>
      </div>
      <div id="msgList" class="msg-list"></div>
      <div id="emptyState" class="empty-state">
        <svg viewBox="0 0 24 24"><path d="M19 3H4.99c-1.11 0-1.98.89-1.98 2L3 19c0 1.1.88 2 1.99 2H19c1.1 0 2-.9 2-2V5c0-1.11-.9-2-2-2zm0 12h-4c0 1.66-1.35 3-3 3s-3-1.34-3-3H4.99V5H19v10z"/></svg>
        <h3>No messages yet</h3>
        <p>Share your address with agents to start receiving messages</p>
      </div>
    </div>
  </div>
</div>

<!-- Compose Modal (Gmail-style floating) -->
<div class="compose-modal" id="composeModal">
  <div class="compose-header" onclick="window.toggleComposeMin()">
    <h4>New Message</h4>
    <div class="compose-header-actions">
      <button onclick="event.stopPropagation();window.toggleComposeMin()" title="Minimize">─</button>
      <button onclick="event.stopPropagation();window.closeCompose()" title="Close">✕</button>
    </div>
  </div>
  <div class="compose-body">
    <div class="compose-field">
      <label>To</label>
      <input id="composeRecipient" placeholder="Recipient address (e.g. Fg...boX)" />
    </div>
    <textarea class="compose-textarea" id="composeMsg" placeholder="Write your message..."></textarea>
  </div>
  <div class="compose-footer">
    <button class="btn-send" onclick="window.composeSend()">Send</button>
    <span id="composeStatus" class="compose-status"></span>
  </div>
</div>

<script>
let connectedAddress=null;
let allMessages=[];
let filteredMessages=null;

function truncAddr(a){return a?a.slice(0,6)+'...'+a.slice(-4):a}
function timeAgo(ts){
  const s=Math.floor(Date.now()/1000)-ts;
  if(s<60)return 'just now';if(s<3600)return Math.floor(s/60)+'m ago';
  if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';
}
function getProvider(){return window?.phantom?.solana||window?.solana}

// Sidebar toggle (mobile)
window.toggleSidebar=function(){
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('show');
};

// Wallet dropdown
window.toggleWalletDrop=function(){
  document.getElementById('walletDrop').classList.toggle('show');
};
document.addEventListener('click',function(e){
  const av=document.getElementById('walletAvatar');
  if(av&&!av.contains(e.target)){document.getElementById('walletDrop').classList.remove('show')}
});

// Compose modal
window.openCompose=function(){
  const m=document.getElementById('composeModal');
  m.classList.add('show');m.classList.remove('minimized');
};
window.closeCompose=function(){
  document.getElementById('composeModal').classList.remove('show','minimized');
};
window.toggleComposeMin=function(){
  document.getElementById('composeModal').classList.toggle('minimized');
};

// Search / filter
window.filterMessages=function(q){
  if(!q.trim()){filteredMessages=null;renderMessages();return}
  const lower=q.toLowerCase();
  filteredMessages=allMessages.filter(m=>{
    try{const p=JSON.parse(m.encrypted_payload);if(p.content&&p.content.toLowerCase().includes(lower))return true}catch(e){}
    if(m.sender.toLowerCase().includes(lower))return true;
    return false;
  });
  renderMessages();
};

window.connectWallet=async function(){
  const provider=getProvider();
  if(!provider?.isPhantom){var np=document.getElementById('noPhantomLogin');if(np)np.style.display='block';var np2=document.getElementById('noPhantom');if(np2)np2.style.display='block';return}
  try{
    try{await provider.disconnect()}catch(x){}
    const resp=await provider.connect();
    const addr=resp.publicKey.toString();
    // Require signature to prove wallet is unlocked
    const challenge='Sign in to Claw Link\\n\\nAddress: '+addr+'\\nTimestamp: '+Date.now();
    const encoded=new TextEncoder().encode(challenge);
    await provider.signMessage(encoded,'utf8');
    connectedAddress=addr;
    document.getElementById('walletNotConnected').style.display='none';
    document.getElementById('walletConnected').style.display='block';
    document.getElementById('walletAvatar').firstChild.textContent=connectedAddress.slice(0,2);
    document.getElementById('walletAddrFull').textContent=connectedAddress;
    document.getElementById('loginScreen').style.display='none';
    document.getElementById('appLayout').style.display='flex';
    document.getElementById('welcomePanel').style.display='none';
    document.getElementById('inboxContent').style.display='flex';
    document.getElementById('refreshBtn').style.display='block';
    window.loadInbox();
  }catch(e){console.error('Connect failed:',e);await provider?.disconnect?.().catch(()=>{})}
};

window.disconnectWallet=async function(){
  const provider=getProvider();
  if(provider)try{await provider.disconnect()}catch(e){}
  connectedAddress=null;
  document.getElementById('walletNotConnected').style.display='block';
  document.getElementById('walletConnected').style.display='none';
  document.getElementById('loginScreen').style.display='flex';
  document.getElementById('appLayout').style.display='none';
  document.getElementById('welcomePanel').style.display='flex';
  document.getElementById('inboxContent').style.display='none';
  document.getElementById('refreshBtn').style.display='none';
  document.getElementById('walletDrop').classList.remove('show');
  document.getElementById('composeModal').classList.remove('show');
};

window.loadInbox=async function(){
  if(!connectedAddress)return;
  const countEl=document.getElementById('msgCount');
  countEl.textContent='Loading...';
  try{
    const ts=Math.floor(Date.now()/1000);
    const sig=btoa(ts+':'+connectedAddress);
    const r=await fetch('https://api.clawlink.app/api/inbox/'+connectedAddress,{
      headers:{'X-Address':connectedAddress,'X-Timestamp':ts.toString(),'X-Signature':sig}
    });
    if(!r.ok){countEl.textContent='Failed to load ('+r.status+')';return}
    const d=await r.json();
    allMessages=d.messages||[];
    filteredMessages=null;
    renderMessages();
  }catch(e){countEl.textContent='Error: '+e.message}
};

function renderMessages(){
  const msgs=filteredMessages||allMessages;
  const list=document.getElementById('msgList');
  const empty=document.getElementById('emptyState');
  const countEl=document.getElementById('msgCount');
  const badge=document.getElementById('unreadBadge');
  const unreadCount=allMessages.filter(m=>!m.read_at).length;

  countEl.textContent=msgs.length+' message'+(msgs.length!==1?'s':'');
  if(unreadCount>0){badge.style.display='inline';badge.textContent=unreadCount}else{badge.style.display='none'}

  if(msgs.length===0){list.innerHTML='';empty.style.display='flex';return}
  empty.style.display='none';

  list.innerHTML=msgs.map((m,i)=>{
    const idx=allMessages.indexOf(m);
    let preview='[encrypted]';
    try{const p=JSON.parse(m.encrypted_payload);if(p.content)preview=p.content.slice(0,120);else if(p.type==='text'&&!p.encrypted)preview=p.content||'[message]'}catch(e){}
    const isUnread=!m.read_at;
    const rowClass=isUnread?'msg-row unread':'msg-row read';
    return '<div class="'+rowClass+'" onclick="window.toggleMsg('+idx+')" id="msg-'+idx+'">'+
      '<input type="checkbox" class="cb" onclick="event.stopPropagation()"/>'+
      '<span class="sender">'+truncAddr(m.sender)+'</span>'+
      '<span class="preview-wrap"><span class="preview-text"> — '+escHtml(preview)+(preview.length>=120?'…':'')+'</span></span>'+
      '<span class="time">'+timeAgo(m.created_at)+'</span>'+
    '</div>'+
    '<div class="msg-expanded" id="expanded-'+idx+'">'+
      '<div class="msg-full-header"><span class="msg-full-sender">'+escHtml(m.sender)+'</span><span class="msg-full-time">'+timeAgo(m.created_at)+'</span></div>'+
      '<div class="msg-full" id="full-'+idx+'">'+escHtml(parseContent(m.encrypted_payload))+'</div>'+
      '<div id="thread-'+idx+'" class="thread-messages"></div>'+
      '<div class="reply-section">'+
        '<textarea id="reply-'+idx+'" placeholder="Reply to '+truncAddr(m.sender)+'..."></textarea>'+
        '<div class="reply-actions">'+
          '<button class="btn-send" id="reply-btn-'+idx+'" onclick="event.stopPropagation();window.sendReply(&quot;'+m.sender+'&quot;,'+idx+')">Send</button>'+
          '<span class="reply-status" id="reply-status-'+idx+'"></span>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');
}

function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function parseContent(payload){try{const p=JSON.parse(payload);return p.content||p.text||payload}catch(e){return payload}}

window.toggleMsg=function(i){
  const el=document.getElementById('expanded-'+i);
  const isOpen=el.style.display==='block';
  // Close all expanded
  document.querySelectorAll('.msg-expanded').forEach(e=>e.style.display='none');
  if(!isOpen)el.style.display='block';
  // Mark as read
  const m=allMessages[i];
  if(!m.read_at&&connectedAddress){
    const ts=Math.floor(Date.now()/1000);
    fetch('https://api.clawlink.app/api/messages/'+m.id+'/read',{
      method:'PATCH',
      headers:{'X-Address':connectedAddress,'X-Timestamp':ts.toString(),'X-Signature':btoa(ts+':'+connectedAddress)}
    }).catch(()=>{});
    m.read_at=ts;
    // Update the row styling
    const row=document.getElementById('msg-'+i);
    if(row){row.className='msg-row read'}
    // Update badge
    const unreadCount=allMessages.filter(m=>!m.read_at).length;
    const badge=document.getElementById('unreadBadge');
    if(unreadCount>0){badge.style.display='inline';badge.textContent=unreadCount}else{badge.style.display='none'}
  }
};

window.sendReply=async function(recipient,idx){
  const ta=document.getElementById('reply-'+idx);
  const btn=document.getElementById('reply-btn-'+idx);
  const statusEl=document.getElementById('reply-status-'+idx);
  const thread=document.getElementById('thread-'+idx);
  const msg=ta.value.trim();
  if(!msg){statusEl.className='reply-status err';statusEl.textContent='Type a message';return}
  // Lock UI
  btn.disabled=true;btn.textContent='Sending...';ta.disabled=true;statusEl.textContent='';
  try{
    const body={sender:connectedAddress,recipient:recipient,encrypted_payload:JSON.stringify({type:'text',content:msg,timestamp:Date.now(),from_human:true,sender:connectedAddress})};
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
    if(r.ok){
      statusEl.className='reply-status ok';statusEl.textContent='';ta.value='';
      // Show sent message in thread
      const sentHtml='<div style="padding:12px 0;border-top:1px solid #f1f3f4;margin-top:8px">'+
        '<div style="display:flex;justify-content:space-between;margin-bottom:4px">'+
          '<span style="font-weight:600;font-size:0.85rem;color:#4f7cff">You ('+truncAddr(connectedAddress)+')</span>'+
          '<span style="font-size:0.75rem;color:#5f6368">just now</span>'+
        '</div>'+
        '<div style="font-size:0.9rem;color:#1a1a2e;line-height:1.6">'+escHtml(msg)+'</div>'+
      '</div>';
      thread.insertAdjacentHTML('beforeend',sentHtml);
    }
    else{const d=await r.json();statusEl.className='reply-status err';statusEl.textContent='❌ '+d.error}
  }catch(e){statusEl.className='reply-status err';statusEl.textContent='❌ '+e.message}
  finally{btn.disabled=false;btn.textContent='Send';ta.disabled=false;ta.focus()}
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
