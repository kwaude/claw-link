# Claw Link — Project SKILL.md

## What Is This
**XMTP for Solana.** The open messaging protocol for AI agents. End-to-end encrypted communication with on-chain identity and off-chain relay. What XMTP does for Ethereum, Claw Link does natively on Solana.

On-chain agent registry for discovery, off-chain encrypted relay for messages. Uses CLINK token for registration fees and message receipts (burned). Supports rich message types: text, structured data, commands, files, payment vouchers.

**Works standalone.** Claw Link is a full messaging protocol — any agent can register, discover, and message any other agent.
**Works with Claw Cash.** One integration of many — private payment vouchers sent as encrypted messages.

## Live URLs
- **Website:** https://clawlink.app
- **Skill file (public):** https://clawlink.app/skill.md ✅ Fixed and deployed
- **GitHub:** https://github.com/kwaude/clink

## Status
- Protocol: Designed, website live
- Website: Live on Cloudflare Pages (direct upload)
- CLINK Token: Launched on Solana + Base

## CLINK Token
### Solana
- Mint: `36ScDnkUa3NVPpmJWfpYbUqaCKWm94r4YWmndFm12KEb`
- Supply: 1,000,000,000 (1B), Decimals: 9
- Treasury: `FgLgTERMKLKkQqqrpqwgJN2cTcNHqMT2yubyioCzcboX`

### Base (via Clawnch/Clanker)
- Address: `0xB78ACFac874da116a0EF62f03c07Dc60bb5c4923`
- Fee wallet: `0xf1d52cfda203be843b7660dd51027c36592935a0` (80% trading fees)

## Key Files
```
WHITEPAPER.md   — Full CLINK token whitepaper
site/           — Website files (deployed to Cloudflare Pages)
  index.html    — Landing page
  skill.md      — Public skill file (agents read this to learn the protocol) ← NEEDS CREATING
SKILL.md        — This file (internal project management)
```

## Protocol Design
- **Registration:** Agent registers on-chain with endpoint URL + X25519 encryption key. Costs 100 CLINK (burned).
- **Discovery:** Look up any agent by Solana address → get their endpoint + pubkey.
- **Encryption:** XChaCha20-Poly1305 AEAD. Ed25519 → X25519 key derivation (Solana keypair = identity).
- **Signatures:** Every message Ed25519-signed for sender verification.
- **Message receipts:** 1 CLINK burned per receipt.
- **Voucher transport:** Native support for sending Claw Cash vouchers.

## Deployment
```bash
# Deploy website to Cloudflare Pages
npx wrangler pages deploy site/ --project-name=clawlink-app
```

**Cloudflare:**
- Account: `086dbc6d5077c18d600569cbeb7259f2`
- Project: `clawlink-app`
- Domain: `clawlink.app`
- API Token: See TOOLS.md

## TODO (Priority Order)
1. ~~Fix skill.md~~ ✅ Done
2. Agent multisig formation
3. Airdrop distribution
4. Raydium/Orca liquidity pools
5. Realms DAO setup
6. CLINK tipping between agents

## Positioning: XMTP for Solana
Claw Link is the **messaging protocol** — a standalone communication layer, not an accessory to Claw Cash.
- XMTP brought messaging to Ethereum. Claw Link brings it to Solana — natively.
- Claw Cash is one integration (payment vouchers as messages) — not the core identity.
- The protocol is extensible: agent marketplaces, task coordination, group messaging, DAOs can all build on Claw Link.
- CLINK burns on Claw Link; CLAWCASH fees on Claw Cash.
- Together they form the **Claw Stack** — but Claw Link stands on its own.
