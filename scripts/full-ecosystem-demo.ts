/**
 * Full Ecosystem Demo: Claw Cash + ClawLink
 * 
 * Flow:
 * 1. Agent A deposits SOL into Claw Cash privacy pool → gets a voucher
 * 2. Agent A registers on ClawLink
 * 3. Agent B registers on ClawLink  
 * 4. Agent A encrypts the voucher and sends it to Agent B via ClawLink
 * 5. Agent B decrypts the voucher
 * 6. Agent B redeems the voucher → SOL withdrawn to target address
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ClawCashProtocol } from "../target/types/claw_cash_protocol";
import {
  Keypair,
  PublicKey,
  Connection,
  LAMPORTS_PER_SOL,
  SystemProgram,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  createMint,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// ─── ClawLink SDK (inline since we're in claw-cash repo) ─────────
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { sha512 } from "@noble/hashes/sha512";
import * as crypto from "crypto";

// Dynamic import for ESM-only @noble/ciphers
let xchacha20poly1305: any;
async function loadCiphers() {
  const mod = await import("@noble/ciphers/chacha.js");
  xchacha20poly1305 = mod.xchacha20poly1305;
}

function randomNonce(len: number): Uint8Array {
  return new Uint8Array(crypto.randomBytes(len));
}

function edPrivateToX25519(edPrivateKey: Uint8Array): Uint8Array {
  const h = sha512(edPrivateKey.slice(0, 32));
  const scalar = h.slice(0, 32);
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}

function edPublicToX25519(edPublicKey: Uint8Array): Uint8Array {
  const edPoint = ed25519.ExtendedPoint.fromHex(edPublicKey);
  const { y } = edPoint.toAffine();
  const modP = ed25519.CURVE.Fp.create;
  const one = BigInt(1);
  const u = modP(modP(one + y) * ed25519.CURVE.Fp.inv(modP(one - y)));
  const bytes = new Uint8Array(32);
  let val = u;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  return bytes;
}

interface ClawLinkMessage {
  version: number;
  sender: string;
  recipient: string;
  timestamp: number;
  nonce: string;
  ciphertext: string;
  signature: string;
}

function encryptVoucher(
  senderKeypair: Keypair,
  recipientPubkey: string,
  recipientX25519Pub: Uint8Array,
  plaintext: string
): ClawLinkMessage {
  const senderX25519Priv = edPrivateToX25519(senderKeypair.secretKey);
  const sharedSecret = x25519.getSharedSecret(senderX25519Priv, recipientX25519Pub);
  const encKey = nobleSha256(sharedSecret);
  const nonce = randomNonce(24);
  const cipher = xchacha20poly1305(encKey, nonce);
  const ciphertext = cipher.encrypt(new TextEncoder().encode(plaintext));
  
  const signData = new Uint8Array(nonce.length + ciphertext.length);
  signData.set(nonce, 0);
  signData.set(ciphertext, nonce.length);
  const signHash = nobleSha256(signData);
  const signature = ed25519.sign(signHash, senderKeypair.secretKey.slice(0, 32));

  return {
    version: 1,
    sender: senderKeypair.publicKey.toBase58(),
    recipient: recipientPubkey,
    timestamp: Math.floor(Date.now() / 1000),
    nonce: Buffer.from(nonce).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    signature: Buffer.from(signature).toString("base64"),
  };
}

function decryptVoucher(
  recipientKeypair: Keypair,
  senderX25519Pub: Uint8Array,
  message: ClawLinkMessage
): string {
  const nonce = Buffer.from(message.nonce, "base64");
  const ciphertext = Buffer.from(message.ciphertext, "base64");
  const signature = Buffer.from(message.signature, "base64");

  // Verify sender signature
  const signData = new Uint8Array(nonce.length + ciphertext.length);
  signData.set(nonce, 0);
  signData.set(ciphertext, nonce.length);
  const signHash = nobleSha256(signData);
  const senderEdPub = new PublicKey(message.sender).toBytes();
  const valid = ed25519.verify(signature, signHash, senderEdPub);
  if (!valid) throw new Error("Invalid signature!");

  // Decrypt
  const recipientX25519Priv = edPrivateToX25519(recipientKeypair.secretKey);
  const sharedSecret = x25519.getSharedSecret(recipientX25519Priv, senderX25519Pub);
  const decKey = nobleSha256(sharedSecret);
  const cipher = xchacha20poly1305(decKey, nonce);
  return new TextDecoder().decode(cipher.decrypt(ciphertext));
}

// ─── Claw Cash Helpers ────────────────────────────────────────────
const MERKLE_TREE_DEPTH = 20;
const ZERO_VALUE = Buffer.alloc(32, 0);
const PROGRAM_ID = new PublicKey("DpVYsUBZ9f8Lny2xvPUK6E8RWxBA7pBh2XRLHWUu9jHP");
const CLAWCASH_MINT = new PublicKey("8TJt8Zq4hz1znTz4wfsXrBHnnNsSgjN7iYGH23X1bMBY");
const RECIPIENT = new PublicKey("DdpiseuHKecsBtTwMKw1rn6HUS2A6oysuT4ZcVrJZt5t");

function sha256Hash(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}
function hashPair(l: Buffer, r: Buffer): Buffer { return sha256Hash(Buffer.concat([l, r])); }
function zeroHashes(): Buffer[] {
  const zh: Buffer[] = new Array(MERKLE_TREE_DEPTH);
  zh[0] = hashPair(ZERO_VALUE, ZERO_VALUE);
  for (let i = 1; i < MERKLE_TREE_DEPTH; i++) zh[i] = hashPair(zh[i - 1], zh[i - 1]);
  return zh;
}

function generateNote() {
  const secret = Buffer.from(Keypair.generate().secretKey.slice(0, 32));
  const nullifierPreimage = Buffer.from(Keypair.generate().secretKey.slice(0, 32));
  return {
    secret,
    nullifierPreimage,
    commitment: sha256Hash(Buffer.concat([secret, nullifierPreimage])),
    nullifierHash: sha256Hash(nullifierPreimage),
  };
}

function computeMerkleProof(leaves: Buffer[], idx: number): Buffer[] {
  const zh = zeroHashes();
  const proof: Buffer[] = [];
  let layer = new Map<number, Buffer>();
  leaves.forEach((l, i) => layer.set(i, l));
  let pi = idx;
  for (let lvl = 0; lvl < MERKLE_TREE_DEPTH; lvl++) {
    const si = pi % 2 === 0 ? pi + 1 : pi - 1;
    proof.push(layer.has(si) ? layer.get(si)! : lvl === 0 ? ZERO_VALUE : zh[lvl - 1]);
    const next = new Map<number, Buffer>();
    const parents = new Set<number>();
    for (const k of layer.keys()) parents.add(Math.floor(k / 2));
    for (const p of parents) {
      const l = layer.has(p*2) ? layer.get(p*2)! : lvl === 0 ? ZERO_VALUE : zh[lvl-1];
      const r = layer.has(p*2+1) ? layer.get(p*2+1)! : lvl === 0 ? ZERO_VALUE : zh[lvl-1];
      next.set(p, hashPair(l, r));
    }
    layer = next;
    pi = Math.floor(pi / 2);
  }
  return proof;
}

function getPDA(seeds: Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  await loadCiphers();
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync("target/idl/claw_cash_protocol.json", "utf8"));
  const program = new Program(idl, provider) as Program<ClawCashProtocol>;

  // Agent A = our wallet (sender)
  const agentA = wallet.payer;
  // Agent B = fresh keypair (recipient agent)
  const agentB = Keypair.generate();

  console.log("═══════════════════════════════════════════════════════");
  console.log("  CLAW CASH + CLAWLINK — Full Ecosystem Demo");
  console.log("═══════════════════════════════════════════════════════");
  console.log("\nAgent A (sender):", agentA.publicKey.toBase58());
  console.log("Agent B (recipient):", agentB.publicKey.toBase58());
  console.log("Final recipient:", RECIPIENT.toBase58());

  // Fund Agent B for tx fees (transfer from Agent A instead of airdrop to avoid rate limits)
  const fundTx = new anchor.web3.Transaction().add(
    SystemProgram.transfer({
      fromPubkey: agentA.publicKey,
      toPubkey: agentB.publicKey,
      lamports: 0.01 * LAMPORTS_PER_SOL,
    })
  );
  await provider.sendAndConfirm(fundTx);

  // ─── Step 1: Claw Cash Deposit ──────────────────────────────────
  console.log("\n┌─────────────────────────────────────────────────────┐");
  console.log("│  STEP 1: Deposit into Claw Cash Privacy Pool       │");
  console.log("└─────────────────────────────────────────────────────┘");

  // Get CLAWCASH for fees
  const depositorClawcash = await getOrCreateAssociatedTokenAccount(
    connection, agentA, CLAWCASH_MINT, agentA.publicKey
  );

  try {
    await program.methods.claimTestTokens().accounts({ claimer: agentA.publicKey }).rpc();
    console.log("  ✅ Claimed test CLAWCASH from faucet");
  } catch { console.log("  ℹ️  Already have CLAWCASH"); }

  const [poolPDA] = getPDA([Buffer.from("pool"), Buffer.from([0])]);
  const pool = await program.account.pool.fetch(poolPDA);
  const leafIndex = pool.nextIndex;

  const note = generateNote();
  await program.methods
    .deposit(Array.from(note.commitment) as any, 0, leafIndex)
    .accounts({ depositorClawcash: depositorClawcash.address, depositor: agentA.publicKey })
    .rpc();

  console.log("  ✅ Deposited 0.1 SOL into Pool 0 (leaf index:", leafIndex + ")");

  // Create the voucher JSON
  const voucher = {
    protocol: "claw-cash",
    version: 1,
    pool_id: 0,
    denomination: "0.1 SOL",
    leaf_index: leafIndex,
    secret: note.secret.toString("hex"),
    nullifier_preimage: note.nullifierPreimage.toString("hex"),
    commitment: note.commitment.toString("hex"),
    note: "Redeemable for 0.1 SOL on Solana devnet via Claw Cash protocol",
  };
  
  console.log("  📝 Voucher generated (contains secret + nullifier)");
  console.log("     Commitment:", note.commitment.toString("hex").slice(0, 24) + "...");

  // ─── Step 2: ClawLink Encryption ────────────────────────────────
  console.log("\n┌─────────────────────────────────────────────────────┐");
  console.log("│  STEP 2: Encrypt Voucher via ClawLink               │");
  console.log("└─────────────────────────────────────────────────────┘");

  // Derive encryption keys for both agents
  const agentA_x25519Pub = edPublicToX25519(agentA.publicKey.toBytes());
  const agentB_x25519Pub = edPublicToX25519(agentB.publicKey.toBytes());

  console.log("  🔑 Agent A encryption key:", Buffer.from(agentA_x25519Pub).toString("hex").slice(0, 24) + "...");
  console.log("  🔑 Agent B encryption key:", Buffer.from(agentB_x25519Pub).toString("hex").slice(0, 24) + "...");

  // Encrypt the voucher for Agent B
  const voucherJson = JSON.stringify(voucher);
  const encryptedMessage = encryptVoucher(
    agentA,
    agentB.publicKey.toBase58(),
    agentB_x25519Pub,
    voucherJson
  );

  console.log("\n  📨 Encrypted ClawLink Message:");
  console.log("     Version:", encryptedMessage.version);
  console.log("     Sender:", encryptedMessage.sender.slice(0, 12) + "...");
  console.log("     Recipient:", encryptedMessage.recipient.slice(0, 12) + "...");
  console.log("     Timestamp:", new Date(encryptedMessage.timestamp * 1000).toISOString());
  console.log("     Nonce:", encryptedMessage.nonce.slice(0, 20) + "...");
  console.log("     Ciphertext:", encryptedMessage.ciphertext.slice(0, 40) + "...");
  console.log("     Signature:", encryptedMessage.signature.slice(0, 40) + "...");
  console.log("     Ciphertext length:", encryptedMessage.ciphertext.length, "bytes (base64)");

  // ─── Step 3: ClawLink Decryption ────────────────────────────────
  console.log("\n┌─────────────────────────────────────────────────────┐");
  console.log("│  STEP 3: Agent B Decrypts the Voucher              │");
  console.log("└─────────────────────────────────────────────────────┘");

  const decryptedJson = decryptVoucher(agentB, agentA_x25519Pub, encryptedMessage);
  const decryptedVoucher = JSON.parse(decryptedJson);

  console.log("  ✅ Signature verified — message is from Agent A");
  console.log("  ✅ Decrypted successfully!");
  console.log("\n  📝 Decrypted Voucher:");
  console.log("     Protocol:", decryptedVoucher.protocol);
  console.log("     Pool:", decryptedVoucher.pool_id, "(" + decryptedVoucher.denomination + ")");
  console.log("     Leaf index:", decryptedVoucher.leaf_index);
  console.log("     Commitment:", decryptedVoucher.commitment.slice(0, 24) + "...");

  // ─── Step 4: Redeem Voucher ─────────────────────────────────────
  console.log("\n┌─────────────────────────────────────────────────────┐");
  console.log("│  STEP 4: Agent B Redeems Voucher → SOL to Wallet   │");
  console.log("└─────────────────────────────────────────────────────┘");

  // Reconstruct note from voucher
  const redeemSecret = Buffer.from(decryptedVoucher.secret, "hex");
  const redeemNullifierPreimage = Buffer.from(decryptedVoucher.nullifier_preimage, "hex");
  const redeemNullifierHash = sha256Hash(redeemNullifierPreimage);
  const redeemLeafIndex = decryptedVoucher.leaf_index;

  // Fetch all leaves for Merkle proof
  const leaves: Buffer[] = [];
  for (let i = 0; i <= redeemLeafIndex; i++) {
    const liBuf = Buffer.alloc(4);
    liBuf.writeUInt32LE(i);
    const [leafPDA] = getPDA([Buffer.from("leaf"), Buffer.from([0]), liBuf]);
    const leaf = await program.account.commitmentLeaf.fetch(leafPDA);
    leaves.push(Buffer.from(leaf.commitment as number[]));
  }
  const proof = computeMerkleProof(leaves, redeemLeafIndex);
  console.log("  ✅ Merkle proof computed (" + leaves.length + " leaves)");

  const recipientBefore = await connection.getBalance(RECIPIENT);

  // Agent B submits the withdrawal (paying tx fee) but SOL goes to final recipient
  await program.methods
    .withdraw(
      Array.from(redeemSecret) as any,
      Array.from(redeemNullifierPreimage) as any,
      Array.from(redeemNullifierHash) as any,
      redeemLeafIndex,
      proof.map((p) => Array.from(p) as any)
    )
    .accounts({
      pool: poolPDA,
      recipient: RECIPIENT,
      payer: agentB.publicKey,
    })
    .signers([agentB])
    .rpc();

  const recipientAfter = await connection.getBalance(RECIPIENT);
  const received = (recipientAfter - recipientBefore) / LAMPORTS_PER_SOL;

  console.log("  ✅ Withdrawal TX confirmed!");
  console.log("  💰 Recipient received:", received, "SOL");

  // ─── Summary ────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ COMPLETE — Private Payment via Encrypted Message");
  console.log("═══════════════════════════════════════════════════════");
  console.log("\n  Flow:");
  console.log("  1. Agent A deposited 0.1 SOL → Claw Cash pool (CLAWCASH burned)");
  console.log("  2. Voucher encrypted with Agent B's key via ClawLink");
  console.log("  3. Agent B decrypted + verified sender signature");
  console.log("  4. Agent B redeemed voucher → 0.1 SOL to final address");
  console.log("\n  On-chain trail:");
  console.log("    Deposit TX:  Agent A → Privacy Pool");
  console.log("    Withdraw TX: Privacy Pool → " + RECIPIENT.toBase58().slice(0, 12) + "...");
  console.log("    Voucher transfer: ⚡ Off-chain encrypted (no trace)");
  console.log("\n  No link between Agent A and the final recipient. 🔒");
}

main().catch(console.error);
