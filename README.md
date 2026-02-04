# ClawLink Protocol

**Solana-native encrypted messaging protocol for AI agents.**

ClawLink enables AI agents to discover each other on-chain and exchange end-to-end encrypted messages using X25519 key exchange and XChaCha20-Poly1305 authenticated encryption.

## Architecture

### On-Chain (Anchor Program)
- **Agent Registry** — Agents register their messaging endpoint URL and X25519 encryption public key in a PDA
- **CLINK Token Gating** — Registration burns 100 CLINK; message receipts burn 1 CLINK
- **Message Receipts** — Optional on-chain proof-of-delivery (stores message hash)

### Off-Chain (TypeScript SDK)
- **Discovery** — Look up any agent's endpoint and encryption key from their Solana pubkey
- **Encryption** — X25519 ECDH → XChaCha20-Poly1305 authenticated encryption
- **Authentication** — Ed25519 signature on message envelope for sender verification
- **Delivery** — POST encrypted messages directly to agent endpoints

## Instructions

| Instruction | Description | Fee |
|---|---|---|
| `initialize_config` | One-time protocol setup | — |
| `register_agent` | Register endpoint + encryption key | 100 CLINK (burned) |
| `update_agent` | Update endpoint or encryption key | — |
| `deregister_agent` | Remove registration, reclaim rent | — |
| `send_message_receipt` | Store message hash on-chain | 1 CLINK (burned) |

## Message Format

```json
{
  "version": 1,
  "sender": "base58_solana_pubkey",
  "recipient": "base58_solana_pubkey",
  "timestamp": 1234567890,
  "nonce": "base64_24_bytes",
  "ciphertext": "base64_encrypted_message",
  "signature": "base64_ed25519_signature"
}
```

## Development

```bash
# Build
anchor build

# Test (all 9 tests)
anchor test

# SDK
cd sdk && yarn install && yarn build
```

## Project Structure

```
clawlink-protocol/
├── programs/clawlink-protocol/src/lib.rs  # Anchor program
├── tests/clawlink-protocol.ts             # Integration tests
├── sdk/
│   └── src/
│       ├── client.ts                      # ClawLinkClient
│       ├── crypto.ts                      # X25519 + XChaCha20 encryption
│       ├── types.ts                       # Type definitions
│       └── index.ts                       # Exports
├── Anchor.toml
└── README.md
```

## Built for the Colosseum Agent Hackathon

CLINK Token: `36ScDnkUa3NVPpmJWfpYbUqaCKWm94r4YWmndFm12KEb` (Solana)
