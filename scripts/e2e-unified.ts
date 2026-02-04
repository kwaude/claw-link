/**
 * Claw Link E2E Test — Unified Messaging + Cash Notes
 * 
 * Test 1: Send a plain encrypted message between two agents
 * Test 2: Send an encrypted message containing a cash note (payment voucher)
 * 
 * These tests validate the full crypto pipeline locally:
 * - Ed25519 → X25519 key derivation
 * - XChaCha20-Poly1305 encryption/decryption
 * - Ed25519 signature creation & verification
 * - Cash note generation (commitment, nullifier)
 * - Cash note round-trip through encrypted message
 */

import {
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { createHash, randomBytes } from "crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes as nobleRandomBytes } from "@noble/ciphers/webcrypto";

// ─── Constants ────────────────────────────────────────────────────
const MESSAGING_PROGRAM_ID = "4t5tX2fELbKCEymX4KWEA3voWp1Fxe8fbfPP3xKtyNxR";
const PAYMENTS_PROGRAM_ID = "DpVYsUBZ9f8Lny2xvPUK6E8RWxBA7pBh2XRLHWUu9jHP";
const MERKLE_TREE_DEPTH = 20;
const ZERO_VALUE = Buffer.alloc(32, 0);
const POOL_ID = 0; // 0.1 SOL pool

// ─── Crypto Helpers ───────────────────────────────────────────────

function edPrivateToX25519(edPrivateKey: Uint8Array): Uint8Array {
  const { sha512 } = require("@noble/hashes/sha512");
  const h = sha512(edPrivateKey.slice(0, 32));
  const scalar = new Uint8Array(h.slice(0, 32));
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

interface EncryptedMessage {
  version: number;
  sender: string;
  recipient: string;
  timestamp: number;
  nonce: string;
  ciphertext: string;
  signature: string;
  type?: string;
}

function encryptMessage(
  senderKeypair: Keypair,
  recipientPubkey: PublicKey,
  recipientX25519: Uint8Array,
  plaintext: string,
  msgType?: string
): EncryptedMessage {
  const senderX25519Priv = edPrivateToX25519(senderKeypair.secretKey);
  const sharedSecret = x25519.getSharedSecret(senderX25519Priv, recipientX25519);
  const encKey = sha256(sharedSecret);
  const nonce = nobleRandomBytes(24);
  const cipher = xchacha20poly1305(encKey, nonce);
  const ciphertext = cipher.encrypt(new TextEncoder().encode(plaintext));

  const signData = new Uint8Array(nonce.length + ciphertext.length);
  signData.set(nonce, 0);
  signData.set(ciphertext, nonce.length);
  const signHash = sha256(signData);
  const signature = ed25519.sign(signHash, senderKeypair.secretKey.slice(0, 32));

  return {
    version: 1,
    type: msgType || "text",
    sender: senderKeypair.publicKey.toBase58(),
    recipient: recipientPubkey.toBase58(),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: Buffer.from(nonce).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    signature: Buffer.from(signature).toString("base64"),
  };
}

function decryptMessage(
  recipientKeypair: Keypair,
  senderPubkey: PublicKey,
  message: EncryptedMessage
): { plaintext: string; signatureValid: boolean } {
  const recipientX25519Priv = edPrivateToX25519(recipientKeypair.secretKey);
  const senderX25519Pub = edPublicToX25519(senderPubkey.toBytes());
  const sharedSecret = x25519.getSharedSecret(recipientX25519Priv, senderX25519Pub);
  const decKey = sha256(sharedSecret);
  const nonce = Buffer.from(message.nonce, "base64");
  const ciphertext = Buffer.from(message.ciphertext, "base64");

  // Verify signature
  const signData = new Uint8Array(nonce.length + ciphertext.length);
  signData.set(nonce, 0);
  signData.set(ciphertext, nonce.length);
  const signHash = sha256(signData);
  const signature = Buffer.from(message.signature, "base64");
  const signatureValid = ed25519.verify(signature, signHash, senderPubkey.toBytes());

  const decipher = xchacha20poly1305(decKey, nonce);
  const plaintext = new TextDecoder().decode(decipher.decrypt(ciphertext));

  return { plaintext, signatureValid };
}

// ─── Cash Note Helpers ────────────────────────────────────────────

function sha256Hash(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function hashPair(left: Buffer, right: Buffer): Buffer {
  return sha256Hash(Buffer.concat([left, right]));
}

function generateCashNote() {
  const secret = randomBytes(32);
  const nullifierPreimage = randomBytes(32);
  const commitment = sha256Hash(Buffer.concat([secret, nullifierPreimage]));
  const nullifierHash = sha256Hash(nullifierPreimage);
  return { secret, nullifierPreimage, commitment, nullifierHash };
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  🔗 Claw Link E2E Test — Messaging + Cash Notes");
  console.log("═══════════════════════════════════════════════════════════\n");

  // Create two test agents (ephemeral keypairs)
  const agentA = Keypair.generate();
  const agentB = Keypair.generate();

  // Derive X25519 keys from Ed25519
  const agentA_x25519_pub = edPublicToX25519(agentA.publicKey.toBytes());
  const agentB_x25519_pub = edPublicToX25519(agentB.publicKey.toBytes());

  console.log("  Agents:");
  console.log(`    A (sender):    ${agentA.publicKey.toBase58()}`);
  console.log(`    B (recipient): ${agentB.publicKey.toBase58()}`);
  console.log(`    A X25519:      ${Buffer.from(agentA_x25519_pub).toString("hex").slice(0, 16)}...`);
  console.log(`    B X25519:      ${Buffer.from(agentB_x25519_pub).toString("hex").slice(0, 16)}...`);

  console.log(`\n  Programs (Solana Devnet):`);
  console.log(`    Messaging: ${MESSAGING_PROGRAM_ID}`);
  console.log(`    Payments:  ${PAYMENTS_PROGRAM_ID}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 1: Plain Encrypted Message
  // ═══════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║  TEST 1: Encrypted Message (A → B)                   ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  const plaintext = "Hey Agent B! This is a secret message from Agent A. 🔐";
  console.log(`  1. Plaintext: "${plaintext}"`);

  // Agent A encrypts message for Agent B
  const encryptedMsg = encryptMessage(agentA, agentB.publicKey, agentB_x25519_pub, plaintext);
  console.log(`\n  2. Encrypted (XChaCha20-Poly1305 + X25519 ECDH):`);
  console.log(`     Type:       ${encryptedMsg.type}`);
  console.log(`     Sender:     ${encryptedMsg.sender.slice(0, 12)}...`);
  console.log(`     Recipient:  ${encryptedMsg.recipient.slice(0, 12)}...`);
  console.log(`     Nonce:      ${encryptedMsg.nonce.slice(0, 24)}... (24 bytes)`);
  console.log(`     Ciphertext: ${encryptedMsg.ciphertext.slice(0, 32)}... (${Buffer.from(encryptedMsg.ciphertext, "base64").length} bytes)`);
  console.log(`     Signature:  ${encryptedMsg.signature.slice(0, 24)}... (Ed25519)`);

  // Agent B decrypts
  const result1 = decryptMessage(agentB, agentA.publicKey, encryptedMsg);
  console.log(`\n  3. Decrypted by Agent B:`);
  console.log(`     Plaintext:  "${result1.plaintext}"`);
  console.log(`     Signature:  ${result1.signatureValid ? "✅ VALID" : "❌ INVALID"}`);

  // Verify a tampered message fails
  const tamperedMsg = { ...encryptedMsg, ciphertext: encryptedMsg.ciphertext.slice(0, -4) + "AAAA" };
  let tamperDetected = false;
  try {
    decryptMessage(agentB, agentA.publicKey, tamperedMsg);
  } catch {
    tamperDetected = true;
  }
  console.log(`     Tamper detection: ${tamperDetected ? "✅ DETECTED" : "❌ MISSED"}`);

  // Verify wrong recipient fails
  const wrongRecipient = Keypair.generate();
  let wrongKeyFailed = false;
  try {
    decryptMessage(wrongRecipient, agentA.publicKey, encryptedMsg);
  } catch {
    wrongKeyFailed = true;
  }
  console.log(`     Wrong key rejection: ${wrongKeyFailed ? "✅ REJECTED" : "❌ DECRYPTED"}`);

  // On-chain: message hash for receipt
  const msgHash = sha256(new TextEncoder().encode(JSON.stringify(encryptedMsg)));
  console.log(`\n  4. On-chain message receipt:`);
  console.log(`     Hash: ${Buffer.from(msgHash).toString("hex").slice(0, 32)}...`);
  console.log(`     Burns: 1 CLINK via send_message_receipt()`);

  const test1Pass = result1.plaintext === plaintext && result1.signatureValid && tamperDetected && wrongKeyFailed;
  console.log(`\n  ${test1Pass ? "✅" : "❌"} TEST 1: ${test1Pass ? "PASSED" : "FAILED"}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 2: Encrypted Message with Cash Note
  // ═══════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║  TEST 2: Message + Cash Note (A → B)                 ║");
  console.log("╚═══════════════════════════════════════════════════════╝\n");

  // Step 1: Agent A creates a cash note (deposits SOL into privacy pool)
  const note = generateCashNote();
  console.log("  1. Cash Note Generated (Agent A deposits into privacy pool):");
  console.log(`     Secret:          ${note.secret.toString("hex").slice(0, 24)}...`);
  console.log(`     Nullifier Pre:   ${note.nullifierPreimage.toString("hex").slice(0, 24)}...`);
  console.log(`     Commitment:      ${note.commitment.toString("hex").slice(0, 24)}...`);
  console.log(`     Nullifier Hash:  ${note.nullifierHash.toString("hex").slice(0, 24)}...`);
  console.log(`     Pool:            ${POOL_ID} (0.1 SOL)`);
  console.log(`     On-chain: deposit() burns 10 CLINK + sends 0.1 SOL to vault`);

  // Step 2: Create the cash note payload to send via encrypted message
  const cashNotePayload = {
    type: "cash_note",
    version: 1,
    pool_id: POOL_ID,
    denomination_sol: 0.1,
    secret: note.secret.toString("hex"),
    nullifier_preimage: note.nullifierPreimage.toString("hex"),
    commitment: note.commitment.toString("hex"),
    leaf_index: 0, // first deposit in pool
    message: "Here's 0.1 SOL for your services. Withdraw anytime. 💸",
  };

  const cashNotePlaintext = JSON.stringify(cashNotePayload);
  console.log(`\n  2. Cash Note Payload (${cashNotePlaintext.length} bytes):`);
  console.log(`     Type:            ${cashNotePayload.type}`);
  console.log(`     Pool:            ${cashNotePayload.pool_id} (${cashNotePayload.denomination_sol} SOL)`);
  console.log(`     Leaf Index:      ${cashNotePayload.leaf_index}`);
  console.log(`     Human message:   "${cashNotePayload.message}"`);

  // Step 3: Encrypt the cash note message
  const encryptedCashNote = encryptMessage(
    agentA, agentB.publicKey, agentB_x25519_pub,
    cashNotePlaintext, "cash_note"
  );
  console.log(`\n  3. Encrypted (same crypto as regular messages):`);
  console.log(`     Type:       ${encryptedCashNote.type}`);
  console.log(`     Ciphertext: ${encryptedCashNote.ciphertext.slice(0, 32)}... (${Buffer.from(encryptedCashNote.ciphertext, "base64").length} bytes)`);
  console.log(`     Signature:  ${encryptedCashNote.signature.slice(0, 24)}... (Ed25519)`);

  // Step 4: Agent B decrypts and extracts the cash note
  const result2 = decryptMessage(agentB, agentA.publicKey, encryptedCashNote);
  const parsedNote = JSON.parse(result2.plaintext);

  console.log(`\n  4. Decrypted by Agent B:`);
  console.log(`     Signature:  ${result2.signatureValid ? "✅ VALID" : "❌ INVALID"}`);
  console.log(`     Type:       ${parsedNote.type}`);
  console.log(`     Pool:       ${parsedNote.pool_id} (${parsedNote.denomination_sol} SOL)`);
  console.log(`     Secret:     ${parsedNote.secret.slice(0, 24)}...`);
  console.log(`     Nullifier:  ${parsedNote.nullifier_preimage.slice(0, 24)}...`);
  console.log(`     Commitment: ${parsedNote.commitment.slice(0, 24)}...`);
  console.log(`     Message:    "${parsedNote.message}"`);

  // Step 5: Verify cash note integrity
  const reSecret = Buffer.from(parsedNote.secret, "hex");
  const reNullifier = Buffer.from(parsedNote.nullifier_preimage, "hex");
  const reCommitment = sha256Hash(Buffer.concat([reSecret, reNullifier]));
  const reNullifierHash = sha256Hash(reNullifier);
  const commitmentMatch = reCommitment.equals(note.commitment);
  const nullifierMatch = reNullifierHash.equals(note.nullifierHash);

  console.log(`\n  5. Verification:`);
  console.log(`     Commitment:  ${commitmentMatch ? "✅ MATCHES" : "❌ MISMATCH"} (SHA256(secret || nullifier_pre))`);
  console.log(`     Nullifier:   ${nullifierMatch ? "✅ MATCHES" : "❌ MISMATCH"} (SHA256(nullifier_pre))`);

  // Step 6: Show what Agent B would do to withdraw
  console.log(`\n  6. Withdrawal flow (Agent B → fresh wallet):`);
  console.log(`     → Call withdraw() on ${PAYMENTS_PROGRAM_ID.slice(0, 8)}...`);
  console.log(`     → Submit: secret, nullifier_preimage, nullifier_hash, leaf_index, merkle_proof`);
  console.log(`     → Program verifies: commitment in tree, nullifier unused`);
  console.log(`     → Program sends 0.1 SOL from vault to Agent B's fresh wallet`);
  console.log(`     → Nullifier recorded on-chain → prevents double-spend`);
  console.log(`     → No on-chain link between Agent A and Agent B 🔒`);

  const test2Pass = result2.plaintext === cashNotePlaintext && result2.signatureValid && commitmentMatch && nullifierMatch;
  console.log(`\n  ${test2Pass ? "✅" : "❌"} TEST 2: ${test2Pass ? "PASSED" : "FAILED"}`);

  // ═══════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ${test1Pass ? "✅" : "❌"} Test 1: Encrypted message          — ${test1Pass ? "PASSED" : "FAILED"}`);
  console.log(`  ${test2Pass ? "✅" : "❌"} Test 2: Cash note in message        — ${test2Pass ? "PASSED" : "FAILED"}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log("\n  Protocol: Claw Link (clawlink.app)");
  console.log("  Token:    CLINK — burns on register (100), message (1), deposit (10)");
  console.log("  Crypto:   Ed25519 → X25519 ECDH + XChaCha20-Poly1305 AEAD");
  console.log("  Payments: SHA256 commitments + Merkle tree (depth 20, ~1M deposits)");
  console.log("  Chain:    Solana Devnet");
  console.log("  Repo:     github.com/kwaude/claw-link");
  console.log("");

  // Exit with appropriate code
  process.exit(test1Pass && test2Pass ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
