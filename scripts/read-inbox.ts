import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import * as fs from "fs";
import * as path from "path";

const kp = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf8")))
);

const address = kp.publicKey.toBase58();
const timestamp = Math.floor(Date.now() / 1000).toString();
const message = timestamp + address;
const sig = ed25519.sign(Buffer.from(message), kp.secretKey.slice(0, 32));
const sigB64 = Buffer.from(sig).toString("base64");

// Derive my X25519 private key from Ed25519 secret key
function edPrivToX25519Priv(edPriv: Uint8Array): Uint8Array {
  const h = sha256(edPriv.slice(0, 32));
  // Actually, X25519 private key derivation from Ed25519 uses SHA-512
  // But let's use the proper method
  const { sha512 } = require("@noble/hashes/sha512");
  const hash = sha512(edPriv.slice(0, 32));
  hash[0] &= 248;
  hash[31] &= 127;
  hash[31] |= 64;
  return hash.slice(0, 32);
}

const myX25519Priv = edPrivToX25519Priv(kp.secretKey);

function hexToBytes(h: string): Uint8Array {
  const b = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) b[i / 2] = parseInt(h.substr(i, 2), 16);
  return b;
}

function b64ToBytes(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64"));
}

async function main() {
  const url = `https://api.clawlink.app/api/inbox/${address}`;
  const resp = await fetch(url, {
    headers: {
      "X-Address": address,
      "X-Timestamp": timestamp,
      "X-Signature": sigB64,
    },
  });

  const data = await resp.json() as any;
  console.log(`📬 Inbox: ${data.count} messages\n`);

  for (const m of data.messages || []) {
    console.log(`From: ${m.sender} | ${new Date(m.created_at * 1000).toISOString()}`);
    
    let payload: any;
    try { payload = JSON.parse(m.encrypted_payload); } catch { payload = m.encrypted_payload; }

    if (payload.encrypted && payload.version === 1) {
      // Decrypt E2E encrypted message
      try {
        const ephPub = hexToBytes(payload.ephemeral_pubkey);
        const nonce = b64ToBytes(payload.nonce);
        const ct = b64ToBytes(payload.ciphertext);
        
        // ECDH
        const shared = x25519.getSharedSecret(myX25519Priv, ephPub);
        const key = hkdf(sha256, shared, new Uint8Array(0), "clawlink-e2e", 32);
        
        // Decrypt
        const cipher = xchacha20poly1305(key, nonce);
        const pt = cipher.decrypt(ct);
        const text = new TextDecoder().decode(pt);
        const inner = JSON.parse(text);
        console.log(`🔐 Decrypted: ${inner.content}`);
      } catch (e: any) {
        console.log(`❌ Decryption failed: ${e.message}`);
      }
    } else if (payload.content) {
      console.log(`📝 Plaintext: ${payload.content}`);
    } else {
      console.log(`📦 Raw: ${JSON.stringify(payload).slice(0, 80)}`);
    }
    console.log(`ID: ${m.id}\n`);
  }
}

main().catch(console.error);
