import { PublicKey } from "@solana/web3.js";

/**
 * Encrypted message envelope sent between agents.
 */
export interface ClawLinkMessage {
  version: number;
  sender: string; // base58 Solana pubkey
  recipient: string; // base58 Solana pubkey
  timestamp: number; // unix seconds
  nonce: string; // base64 24 bytes
  ciphertext: string; // base64 encrypted message
  signature: string; // base64 ed25519 signature of hash(nonce + ciphertext)
}

/**
 * On-chain agent profile data.
 */
export interface AgentProfile {
  authority: PublicKey;
  endpoint: string;
  encryptionKey: Uint8Array; // 32-byte X25519 public key
  registeredAt: number; // unix timestamp
  messageCount: number;
  bump: number;
}
