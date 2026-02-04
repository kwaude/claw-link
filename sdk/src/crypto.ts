import { Keypair } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import { x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes } from "@noble/ciphers/webcrypto";
import type { ClawLinkMessage } from "./types";

/**
 * Converts an Ed25519 private key (seed) to an X25519 private key.
 * Ed25519 private keys are hashed with SHA-512; the first 32 bytes
 * (clamped) become the scalar used for X25519.
 */
function edPrivateToX25519(edPrivateKey: Uint8Array): Uint8Array {
  // Use the ed25519 private key seed (first 32 bytes of the keypair secret)
  // Hash it with SHA-512 and take first 32 bytes, then clamp
  const { sha512 } = require("@noble/hashes/sha512");
  const h = sha512(edPrivateKey.slice(0, 32));
  const scalar = h.slice(0, 32);
  // Clamp
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;
  return scalar;
}

/**
 * Converts an Ed25519 public key to an X25519 public key.
 * Uses the birational map from the edwards25519 curve to curve25519.
 */
function edPublicToX25519(edPublicKey: Uint8Array): Uint8Array {
  // Use @noble/curves built-in conversion
  // The ed25519 point (y, x) maps to curve25519 u = (1+y)/(1-y)
  const edPoint = ed25519.ExtendedPoint.fromHex(edPublicKey);
  const { y } = edPoint.toAffine();
  const modP = ed25519.CURVE.Fp.create;
  const one = BigInt(1);
  // u = (1 + y) / (1 - y) mod p
  const u = modP(modP(one + y) * ed25519.CURVE.Fp.inv(modP(one - y)));
  // Convert bigint to 32-byte little-endian
  const bytes = new Uint8Array(32);
  let val = u;
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(val & BigInt(0xff));
    val >>= BigInt(8);
  }
  return bytes;
}

/**
 * Encryption and signing utilities for ClawLink messaging.
 */
export class ClawLinkCrypto {
  private edPrivateKey: Uint8Array; // 64-byte ed25519 secret key
  private edPublicKey: Uint8Array; // 32-byte ed25519 public key
  private x25519PrivateKey: Uint8Array; // 32-byte x25519 private key
  private x25519PublicKey: Uint8Array; // 32-byte x25519 public key

  constructor(keypair: Keypair) {
    this.edPrivateKey = keypair.secretKey;
    this.edPublicKey = keypair.publicKey.toBytes();
    this.x25519PrivateKey = edPrivateToX25519(this.edPrivateKey);
    this.x25519PublicKey = edPublicToX25519(this.edPublicKey);
  }

  /**
   * Get this agent's X25519 public encryption key (for on-chain registration).
   */
  getEncryptionPublicKey(): Uint8Array {
    return this.x25519PublicKey;
  }

  /**
   * Encrypt a message for a recipient, given their X25519 public key.
   * Uses X25519 ECDH + XChaCha20-Poly1305.
   */
  encryptMessage(
    recipientX25519PubKey: Uint8Array,
    recipientSolanaPubkey: string,
    plaintext: string
  ): ClawLinkMessage {
    // Derive shared secret via X25519 ECDH
    const sharedSecret = x25519.getSharedSecret(
      this.x25519PrivateKey,
      recipientX25519PubKey
    );

    // Hash the shared secret to get encryption key
    const encKey = sha256(sharedSecret);

    // Generate random 24-byte nonce for XChaCha20-Poly1305
    const nonce = randomBytes(24);

    // Encrypt
    const cipher = xchacha20poly1305(encKey, nonce);
    const plaintextBytes = new TextEncoder().encode(plaintext);
    const ciphertext = cipher.encrypt(plaintextBytes);

    // Sign hash(nonce || ciphertext) with ed25519
    const signData = new Uint8Array(nonce.length + ciphertext.length);
    signData.set(nonce, 0);
    signData.set(ciphertext, nonce.length);
    const signHash = sha256(signData);
    const signature = ed25519.sign(signHash, this.edPrivateKey.slice(0, 32));

    return {
      version: 1,
      sender: Keypair.fromSecretKey(this.edPrivateKey).publicKey.toBase58(),
      recipient: recipientSolanaPubkey,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: Buffer.from(nonce).toString("base64"),
      ciphertext: Buffer.from(ciphertext).toString("base64"),
      signature: Buffer.from(signature).toString("base64"),
    };
  }

  /**
   * Decrypt an incoming message + verify sender signature.
   */
  decryptMessage(
    message: ClawLinkMessage,
    senderX25519PubKey: Uint8Array
  ): string {
    // Verify signature first
    const nonce = Buffer.from(message.nonce, "base64");
    const ciphertext = Buffer.from(message.ciphertext, "base64");
    const signature = Buffer.from(message.signature, "base64");

    const signData = new Uint8Array(nonce.length + ciphertext.length);
    signData.set(nonce, 0);
    signData.set(ciphertext, nonce.length);
    const signHash = sha256(signData);

    // Get sender's ed25519 public key from base58
    const { PublicKey } = require("@solana/web3.js");
    const senderEdPubKey = new PublicKey(message.sender).toBytes();

    const valid = ed25519.verify(signature, signHash, senderEdPubKey);
    if (!valid) {
      throw new Error("Invalid message signature — sender authentication failed");
    }

    // Derive shared secret via X25519 ECDH
    const sharedSecret = x25519.getSharedSecret(
      this.x25519PrivateKey,
      senderX25519PubKey
    );

    // Hash shared secret to get decryption key
    const decKey = sha256(sharedSecret);

    // Decrypt
    const cipher = xchacha20poly1305(decKey, nonce);
    const plaintext = cipher.decrypt(ciphertext);

    return new TextDecoder().decode(plaintext);
  }

  /**
   * Derive X25519 public key from a Solana ed25519 public key.
   * Useful for looking up encryption keys without on-chain data.
   */
  static deriveX25519PublicKey(edPubKey: Uint8Array): Uint8Array {
    return edPublicToX25519(edPubKey);
  }
}
