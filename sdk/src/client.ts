import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { ClawLinkCrypto } from "./crypto";
import type { ClawLinkMessage, AgentProfile } from "./types";

// IDL will be imported at runtime
const IDL_PROGRAM_ID = "PpQRJsqoLvrMspfw4zmnNQ4DbEnR4M47Ktw8jkYcCRM";

/**
 * ClawLinkClient — main entry point for the Claw Link messaging protocol.
 *
 * Provides methods to register agents on-chain, look up profiles,
 * send/receive encrypted messages, and manage registrations.
 */
export class ClawLinkClient {
  private connection: Connection;
  private wallet: Keypair;
  private crypto: ClawLinkCrypto;
  private programId: PublicKey;

  constructor(
    connection: Connection,
    wallet: Keypair,
    programId?: PublicKey
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.crypto = new ClawLinkCrypto(wallet);
    this.programId = programId || new PublicKey(IDL_PROGRAM_ID);
  }

  /**
   * Get this agent's X25519 encryption public key.
   */
  getEncryptionPublicKey(): Uint8Array {
    return this.crypto.getEncryptionPublicKey();
  }

  /**
   * Derive the config PDA address.
   */
  getConfigPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      this.programId
    );
  }

  /**
   * Derive the agent profile PDA for a given agent pubkey.
   */
  getAgentProfilePda(agentPubkey: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentPubkey.toBuffer()],
      this.programId
    );
  }

  /**
   * Look up an agent's on-chain profile.
   */
  async lookup(agentPubkey: PublicKey): Promise<AgentProfile | null> {
    const [profilePda] = this.getAgentProfilePda(agentPubkey);

    try {
      const accountInfo = await this.connection.getAccountInfo(profilePda);
      if (!accountInfo) return null;

      // Decode the account data (skip 8-byte discriminator)
      const data = accountInfo.data;
      const authority = new PublicKey(data.slice(8, 40));

      // Read endpoint string (4-byte length prefix + data)
      const endpointLen = data.readUInt32LE(40);
      const endpoint = data.slice(44, 44 + endpointLen).toString("utf8");
      const offset = 44 + endpointLen;

      // Pad to max endpoint (4 + 256 = 260 bytes from offset 40)
      // Actually the data is packed, so continue from current offset
      const encryptionKey = new Uint8Array(data.slice(offset, offset + 32));
      const registeredAt = Number(data.readBigInt64LE(offset + 32));
      const messageCount = Number(data.readBigUInt64LE(offset + 40));
      const bump = data[offset + 48];

      return {
        authority,
        endpoint,
        encryptionKey,
        registeredAt,
        messageCount,
        bump,
      };
    } catch {
      return null;
    }
  }

  /**
   * Send an encrypted message to another agent.
   * Looks up their profile on-chain, encrypts with X25519, and POSTs to their endpoint.
   */
  async sendMessage(
    recipientPubkey: PublicKey,
    plaintext: string
  ): Promise<ClawLinkMessage> {
    // Look up recipient's profile
    const profile = await this.lookup(recipientPubkey);
    if (!profile) {
      throw new Error(
        `Agent ${recipientPubkey.toBase58()} not found on-chain`
      );
    }

    // Encrypt the message
    const message = this.crypto.encryptMessage(
      profile.encryptionKey,
      recipientPubkey.toBase58(),
      plaintext
    );

    // POST to recipient's endpoint
    try {
      const response = await fetch(profile.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        throw new Error(
          `Failed to deliver message: ${response.status} ${response.statusText}`
        );
      }
    } catch (err: any) {
      // If delivery fails, still return the message (caller can retry)
      console.warn(`Message delivery failed: ${err.message}`);
    }

    return message;
  }

  /**
   * Decrypt an incoming encrypted message.
   */
  async decryptMessage(message: ClawLinkMessage): Promise<string> {
    // Look up sender's profile for their encryption key
    const senderPubkey = new PublicKey(message.sender);
    const profile = await this.lookup(senderPubkey);

    if (!profile) {
      throw new Error(
        `Sender ${message.sender} not found on-chain — cannot verify`
      );
    }

    return this.crypto.decryptMessage(message, profile.encryptionKey);
  }

  /**
   * Decrypt a message when you already have the sender's X25519 key.
   */
  decryptMessageWithKey(
    message: ClawLinkMessage,
    senderX25519Key: Uint8Array
  ): string {
    return this.crypto.decryptMessage(message, senderX25519Key);
  }
}
