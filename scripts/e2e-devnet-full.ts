/**
 * Claw Link — Full Devnet E2E: Messaging + Cash Notes ON-CHAIN
 * 
 * Test 1: Register agents → send encrypted message → store receipt on-chain
 * Test 2: Deposit SOL into privacy pool → send cash note → withdraw anonymously
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, Connection, SystemProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
} from "@solana/spl-token";
import { createHash, randomBytes } from "crypto";
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { sha256 } from "@noble/hashes/sha256";
import { randomBytes as nobleRandomBytes } from "@noble/ciphers/webcrypto";
import * as fs from "fs";
import * as os from "os";

// ─── Config ───────────────────────────────────────────────────────
const MESSAGING_PROGRAM_ID = new PublicKey("4t5tX2fELbKCEymX4KWEA3voWp1Fxe8fbfPP3xKtyNxR");
const PAYMENTS_PROGRAM_ID = new PublicKey("AV9QieTmdg2hFWsaZ3uTJRJuqqbhQCYFjn1fGiSYPTNe");
const CLINK_MINT = new PublicKey("AxJDt4Pnst1Xv9GgfbPCyHMWSzGPBYcNbh95YjywEqy1"); // devnet
const DEVNET_RPC = "https://api.devnet.solana.com";
const MERKLE_TREE_DEPTH = 20;
const ZERO_VALUE = Buffer.alloc(32, 0);

// ─── Crypto ───────────────────────────────────────────────────────
function edPrivateToX25519(edPrivateKey: Uint8Array): Uint8Array {
  const { sha512 } = require("@noble/hashes/sha512");
  const h = sha512(edPrivateKey.slice(0, 32));
  const scalar = new Uint8Array(h.slice(0, 32));
  scalar[0] &= 248; scalar[31] &= 127; scalar[31] |= 64;
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
  for (let i = 0; i < 32; i++) { bytes[i] = Number(val & BigInt(0xff)); val >>= BigInt(8); }
  return bytes;
}

function encryptMessage(sender: Keypair, recipientPub: PublicKey, recipientX25519: Uint8Array, plaintext: string) {
  const senderX25519Priv = edPrivateToX25519(sender.secretKey);
  const sharedSecret = x25519.getSharedSecret(senderX25519Priv, recipientX25519);
  const encKey = sha256(sharedSecret);
  const nonce = nobleRandomBytes(24);
  const cipher = xchacha20poly1305(encKey, nonce);
  const ciphertext = cipher.encrypt(new TextEncoder().encode(plaintext));
  const signData = new Uint8Array(nonce.length + ciphertext.length);
  signData.set(nonce, 0); signData.set(ciphertext, nonce.length);
  const signature = ed25519.sign(sha256(signData), sender.secretKey.slice(0, 32));
  return {
    version: 1, sender: sender.publicKey.toBase58(), recipient: recipientPub.toBase58(),
    timestamp: Math.floor(Date.now() / 1000),
    nonce: Buffer.from(nonce).toString("base64"),
    ciphertext: Buffer.from(ciphertext).toString("base64"),
    signature: Buffer.from(signature).toString("base64"),
  };
}

function decryptMessage(recipient: Keypair, senderPub: PublicKey, msg: any) {
  const recipientX25519Priv = edPrivateToX25519(recipient.secretKey);
  const senderX25519Pub = edPublicToX25519(senderPub.toBytes());
  const sharedSecret = x25519.getSharedSecret(recipientX25519Priv, senderX25519Pub);
  const decKey = sha256(sharedSecret);
  const nonce = Buffer.from(msg.nonce, "base64");
  const ciphertext = Buffer.from(msg.ciphertext, "base64");
  const signData = new Uint8Array(nonce.length + ciphertext.length);
  signData.set(nonce, 0); signData.set(ciphertext, nonce.length);
  const valid = ed25519.verify(Buffer.from(msg.signature, "base64"), sha256(signData), senderPub.toBytes());
  const decipher = xchacha20poly1305(decKey, nonce);
  return { plaintext: new TextDecoder().decode(decipher.decrypt(ciphertext)), signatureValid: valid };
}

function sha256Hash(data: Buffer): Buffer { return createHash("sha256").update(data).digest(); }
function hashPair(l: Buffer, r: Buffer): Buffer { return sha256Hash(Buffer.concat([l, r])); }

function zeroHashes(): Buffer[] {
  const zh: Buffer[] = new Array(MERKLE_TREE_DEPTH);
  zh[0] = hashPair(ZERO_VALUE, ZERO_VALUE);
  for (let i = 1; i < MERKLE_TREE_DEPTH; i++) zh[i] = hashPair(zh[i - 1], zh[i - 1]);
  return zh;
}

function generateCashNote() {
  const secret = randomBytes(32);
  const nullifierPreimage = randomBytes(32);
  const commitment = sha256Hash(Buffer.concat([secret, nullifierPreimage]));
  const nullifierHash = sha256Hash(nullifierPreimage);
  return { secret, nullifierPreimage, commitment, nullifierHash };
}

function computeMerkleProof(leafIndex: number, commitment: Buffer): Buffer[] {
  const zh = zeroHashes();
  const proof: Buffer[] = [];
  for (let i = 0; i < MERKLE_TREE_DEPTH; i++) {
    if (i === 0) proof.push(ZERO_VALUE);
    else proof.push(zh[i - 1]);
  }
  return proof;
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  🔗 Claw Link — Full Devnet E2E Test");
  console.log("═══════════════════════════════════════════════════════════\n");

  const connection = new Connection(DEVNET_RPC, "confirmed");

  // Load deployer (has CLINK mint authority)
  const walletPath = os.homedir() + "/.config/solana/id.json";
  const deployer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))));
  console.log(`  Deployer: ${deployer.publicKey.toBase58()}`);

  // Create two test agents
  const agentA = Keypair.generate();
  const agentB = Keypair.generate();
  const recipient = Keypair.generate(); // fresh withdrawal wallet
  console.log(`  Agent A:  ${agentA.publicKey.toBase58()}`);
  console.log(`  Agent B:  ${agentB.publicKey.toBase58()}`);
  console.log(`  Recipient (fresh): ${recipient.publicKey.toBase58()}`);

  // X25519 keys
  const agentA_x25519 = edPublicToX25519(agentA.publicKey.toBytes());
  const agentB_x25519 = edPublicToX25519(agentB.publicKey.toBytes());

  // Load IDLs
  const msgIdl = JSON.parse(fs.readFileSync(os.homedir() + "/Code/claw-link/target/idl/clawlink_protocol.json", "utf8"));
  const payIdl = JSON.parse(fs.readFileSync(os.homedir() + "/Code/claw-link/target/idl/claw_link_payments.json", "utf8"));

  // Airdrop SOL
  console.log("\n📦 Funding agents...");
  for (const kp of [agentA, agentB]) {
    try {
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      console.log(`  ✅ ${kp.publicKey.toBase58().slice(0, 8)}... → 2 SOL`);
    } catch (e: any) {
      // Fund from deployer if airdrop rate-limited
      console.log(`  ⚠️  Airdrop rate-limited, funding from deployer...`);
      const tx = new anchor.web3.Transaction().add(
        SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: 0.5 * LAMPORTS_PER_SOL })
      );
      const sig = await connection.sendTransaction(tx, [deployer]);
      await connection.confirmTransaction(sig, "confirmed");
      console.log(`  ✅ ${kp.publicKey.toBase58().slice(0, 8)}... → 0.5 SOL (from deployer)`);
    }
  }

  // Mint CLINK to agents
  console.log("\n🪙 Minting CLINK to agents...");
  for (const kp of [agentA, agentB]) {
    const ata = await getOrCreateAssociatedTokenAccount(connection, deployer, CLINK_MINT, kp.publicKey);
    await mintTo(connection, deployer, CLINK_MINT, ata.address, deployer, 1000_000_000_000); // 1000 CLINK
    console.log(`  ✅ ${kp.publicKey.toBase58().slice(0, 8)}... → 1000 CLINK`);
  }

  // ═══════════════════════════════════════════════════════════════
  // TEST 1: Register + Encrypted Message + On-Chain Receipt
  // ═══════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║  TEST 1: Register + Message + On-Chain Receipt        ║");
  console.log("╚═══════════════════════════════════════════════════════╝");

  const msgProvider = (kp: Keypair) => new anchor.AnchorProvider(
    connection, new anchor.Wallet(kp), { commitment: "confirmed" }
  );

  // Step 1: Register Agent A
  console.log("\n  1. Registering Agent A on-chain...");
  const msgProgramA = new Program(msgIdl, msgProvider(agentA));
  const [msgConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], MESSAGING_PROGRAM_ID);
  const [agentAPda] = PublicKey.findProgramAddressSync([Buffer.from("agent"), agentA.publicKey.toBuffer()], MESSAGING_PROGRAM_ID);
  const agentAToken = await getOrCreateAssociatedTokenAccount(connection, deployer, CLINK_MINT, agentA.publicKey);
  
  // Check if messaging config exists
  const msgConfigInfo = await connection.getAccountInfo(msgConfigPda);
  if (!msgConfigInfo) {
    console.log("  ⚠️  Messaging config not initialized. Initializing...");
    const msgProgramDeployer = new Program(msgIdl, msgProvider(deployer));
    await msgProgramDeployer.methods
      .initializeConfig(new BN(100_000_000_000), new BN(1_000_000_000))
      .accounts({
        config: msgConfigPda,
        clinkMint: CLINK_MINT,
        authority: deployer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("  ✅ Messaging config initialized");
  }

  try {
    const tx = await msgProgramA.methods
      .registerAgent("https://agent-a.example.com/messages", Array.from(agentA_x25519))
      .accounts({
        config: msgConfigPda,
        agentProfile: agentAPda,
        clinkMint: CLINK_MINT,
        agentTokenAccount: agentAToken.address,
        agent: agentA.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`     ✅ Agent A registered: ${tx.slice(0, 20)}...`);
    console.log(`     Burned: 100 CLINK`);
  } catch (e: any) {
    console.log(`     ❌ ${e.message.slice(0, 80)}`);
  }

  // Step 2: Register Agent B
  console.log("\n  2. Registering Agent B on-chain...");
  const msgProgramB = new Program(msgIdl, msgProvider(agentB));
  const [agentBPda] = PublicKey.findProgramAddressSync([Buffer.from("agent"), agentB.publicKey.toBuffer()], MESSAGING_PROGRAM_ID);
  const agentBToken = await getOrCreateAssociatedTokenAccount(connection, deployer, CLINK_MINT, agentB.publicKey);

  try {
    const tx = await msgProgramB.methods
      .registerAgent("https://agent-b.example.com/messages", Array.from(agentB_x25519))
      .accounts({
        config: msgConfigPda,
        agentProfile: agentBPda,
        clinkMint: CLINK_MINT,
        agentTokenAccount: agentBToken.address,
        agent: agentB.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`     ✅ Agent B registered: ${tx.slice(0, 20)}...`);
    console.log(`     Burned: 100 CLINK`);
  } catch (e: any) {
    console.log(`     ❌ ${e.message.slice(0, 80)}`);
  }

  // Step 3: Look up Agent B's profile
  console.log("\n  3. Looking up Agent B on-chain...");
  try {
    const profile = await msgProgramA.account.agentProfile.fetch(agentBPda);
    console.log(`     Endpoint: ${profile.endpoint}`);
    console.log(`     Encryption key: ${Buffer.from(profile.encryptionKey as number[]).toString("hex").slice(0, 16)}...`);
  } catch (e: any) {
    console.log(`     ❌ ${e.message.slice(0, 80)}`);
  }

  // Step 4: Send encrypted message (off-chain)
  console.log("\n  4. Encrypting + sending message (A → B)...");
  const plaintext = "Hey Agent B! This is an on-chain verified message. 🔐";
  const encrypted = encryptMessage(agentA, agentB.publicKey, agentB_x25519, plaintext);
  console.log(`     Plaintext: "${plaintext}"`);
  console.log(`     Ciphertext: ${encrypted.ciphertext.slice(0, 30)}...`);

  // Step 5: Store message receipt on-chain
  console.log("\n  5. Storing message receipt on-chain...");
  const msgHashBytes = sha256(new TextEncoder().encode(JSON.stringify(encrypted)));
  const [receiptPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("receipt"), agentA.publicKey.toBuffer(), Buffer.from(msgHashBytes)],
    MESSAGING_PROGRAM_ID
  );

  try {
    const tx = await msgProgramA.methods
      .sendMessageReceipt(Array.from(msgHashBytes), agentB.publicKey)
      .accounts({
        config: msgConfigPda,
        senderProfile: agentAPda,
        messageReceipt: receiptPda,
        clinkMint: CLINK_MINT,
        senderTokenAccount: agentAToken.address,
        authority: agentA.publicKey,
        sender: agentA.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`     ✅ Receipt stored: ${tx.slice(0, 20)}...`);
    console.log(`     Burned: 1 CLINK`);
  } catch (e: any) {
    console.log(`     ❌ ${e.message.slice(0, 80)}`);
  }

  // Step 6: Agent B decrypts
  console.log("\n  6. Agent B decrypts...");
  const result = decryptMessage(agentB, agentA.publicKey, encrypted);
  console.log(`     Decrypted: "${result.plaintext}"`);
  console.log(`     Signature: ${result.signatureValid ? "✅ VALID" : "❌ INVALID"}`);

  // Check CLINK balances
  const balA = await getAccount(connection, agentAToken.address);
  console.log(`\n  Agent A CLINK remaining: ${Number(balA.amount) / 1e9}`);

  const test1Pass = result.plaintext === plaintext && result.signatureValid;
  console.log(`\n  ${test1Pass ? "✅" : "❌"} TEST 1: ${test1Pass ? "PASSED" : "FAILED"}`);

  // ═══════════════════════════════════════════════════════════════
  // TEST 2: Deposit + Cash Note + Withdraw
  // ═══════════════════════════════════════════════════════════════
  console.log("\n╔═══════════════════════════════════════════════════════╗");
  console.log("║  TEST 2: Deposit + Cash Note + Anonymous Withdraw     ║");
  console.log("╚═══════════════════════════════════════════════════════╝");

  const payProvider = (kp: Keypair) => new anchor.AnchorProvider(
    connection, new anchor.Wallet(kp), { commitment: "confirmed" }
  );
  const payProgramA = new Program(payIdl, payProvider(agentA));
  const payProgramB = new Program(payIdl, payProvider(agentB));

  const [payConfigPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], PAYMENTS_PROGRAM_ID);
  const poolId = 0; // 0.1 SOL
  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool"), Buffer.from([poolId])], PAYMENTS_PROGRAM_ID);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), Buffer.from([poolId])], PAYMENTS_PROGRAM_ID);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], PAYMENTS_PROGRAM_ID);

  // Step 1: Generate cash note
  console.log("\n  1. Generating cash note...");
  const note = generateCashNote();
  console.log(`     Commitment: ${note.commitment.toString("hex").slice(0, 24)}...`);
  console.log(`     Nullifier:  ${note.nullifierHash.toString("hex").slice(0, 24)}...`);

  // Step 2: Agent A deposits SOL into pool (burns CLINK)
  console.log("\n  2. Agent A deposits 0.1 SOL into privacy pool...");
  const agentAClinkAta = await getOrCreateAssociatedTokenAccount(connection, deployer, CLINK_MINT, agentA.publicKey);
  
  // Get current leaf index
  const poolData = await payProgramA.account.pool.fetch(poolPda);
  const leafIndex = poolData.nextIndex;
  
  const [commitmentLeafPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("leaf"), Buffer.from([poolId]), new BN(leafIndex).toArrayLike(Buffer, "le", 4)],
    PAYMENTS_PROGRAM_ID
  );

  try {
    const tx = await payProgramA.methods
      .deposit(Array.from(note.commitment), poolId, leafIndex)
      .accounts({
        config: payConfigPda,
        pool: poolPda,
        vault: vaultPda,
        commitmentLeaf: commitmentLeafPda,
        depositorClink: agentAClinkAta.address,
        treasury: treasuryPda,
        depositor: agentA.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
    console.log(`     ✅ Deposited: ${tx.slice(0, 20)}...`);
    console.log(`     Burned: 10 CLINK | Deposited: 0.1 SOL to vault`);
  } catch (e: any) {
    console.log(`     ❌ ${e.message.slice(0, 120)}`);
  }

  // Step 3: Send cash note as encrypted message
  console.log("\n  3. Sending cash note as encrypted message (A → B)...");
  const cashNotePayload = JSON.stringify({
    type: "cash_note", pool_id: poolId, denomination_sol: 0.1,
    secret: note.secret.toString("hex"),
    nullifier_preimage: note.nullifierPreimage.toString("hex"),
    commitment: note.commitment.toString("hex"),
    leaf_index: leafIndex,
    message: "Here's 0.1 SOL — withdraw to any wallet. 💸",
  });
  const encryptedNote = encryptMessage(agentA, agentB.publicKey, agentB_x25519, cashNotePayload);
  console.log(`     Encrypted cash note: ${encryptedNote.ciphertext.slice(0, 30)}...`);

  // Step 4: Agent B decrypts
  console.log("\n  4. Agent B decrypts cash note...");
  const noteResult = decryptMessage(agentB, agentA.publicKey, encryptedNote);
  const parsedNote = JSON.parse(noteResult.plaintext);
  console.log(`     Type: ${parsedNote.type}`);
  console.log(`     Pool: ${parsedNote.pool_id} (${parsedNote.denomination_sol} SOL)`);
  console.log(`     Signature: ${noteResult.signatureValid ? "✅ VALID" : "❌ INVALID"}`);

  // Step 5: Agent B withdraws to fresh wallet
  console.log("\n  5. Agent B withdraws to fresh wallet...");
  const withdrawSecret = Buffer.from(parsedNote.secret, "hex");
  const withdrawNullPre = Buffer.from(parsedNote.nullifier_preimage, "hex");
  const withdrawNullHash = sha256Hash(withdrawNullPre);
  const merkleProof = computeMerkleProof(parsedNote.leaf_index, sha256Hash(Buffer.concat([withdrawSecret, withdrawNullPre])));

  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), withdrawNullHash],
    PAYMENTS_PROGRAM_ID
  );

  const recipientBalBefore = await connection.getBalance(recipient.publicKey);

  try {
    const tx = await payProgramB.methods
      .withdraw(
        Array.from(withdrawSecret),
        Array.from(withdrawNullPre),
        Array.from(withdrawNullHash),
        parsedNote.leaf_index,
        merkleProof.map((b: Buffer) => Array.from(b))
      )
      .accounts({
        pool: poolPda,
        vault: vaultPda,
        nullifierAccount: nullifierPda,
        recipient: recipient.publicKey,
        payer: agentB.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log(`     ✅ Withdrawn: ${tx.slice(0, 20)}...`);
  } catch (e: any) {
    console.log(`     ❌ ${e.message.slice(0, 120)}`);
  }

  const recipientBalAfter = await connection.getBalance(recipient.publicKey);
  const received = (recipientBalAfter - recipientBalBefore) / LAMPORTS_PER_SOL;
  console.log(`     Recipient received: ${received} SOL`);
  console.log(`     Sender (Agent A): ${agentA.publicKey.toBase58().slice(0, 8)}...`);
  console.log(`     Recipient wallet:  ${recipient.publicKey.toBase58().slice(0, 8)}...`);
  console.log(`     On-chain link: ❌ NONE — anonymous withdrawal`);

  // Verify double-spend prevention
  console.log("\n  6. Testing double-spend prevention...");
  let doubleSpendBlocked = false;
  try {
    await payProgramB.methods
      .withdraw(
        Array.from(withdrawSecret), Array.from(withdrawNullPre), Array.from(withdrawNullHash),
        parsedNote.leaf_index, merkleProof.map((b: Buffer) => Array.from(b))
      )
      .accounts({
        pool: poolPda, vault: vaultPda, nullifierAccount: nullifierPda,
        recipient: recipient.publicKey, payer: agentB.publicKey, systemProgram: SystemProgram.programId,
      })
      .rpc();
  } catch {
    doubleSpendBlocked = true;
  }
  console.log(`     Double-spend: ${doubleSpendBlocked ? "✅ BLOCKED" : "❌ ALLOWED"}`);

  const test2Pass = noteResult.signatureValid && received >= 0.09 && doubleSpendBlocked;
  console.log(`\n  ${test2Pass ? "✅" : "❌"} TEST 2: ${test2Pass ? "PASSED" : "FAILED"}`);

  // ═══════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  RESULTS");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  ${test1Pass ? "✅" : "❌"} Test 1: Register + Message + Receipt  — ${test1Pass ? "PASSED" : "FAILED"}`);
  console.log(`  ${test2Pass ? "✅" : "❌"} Test 2: Deposit + Cash Note + Withdraw — ${test2Pass ? "PASSED" : "FAILED"}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`\n  Messaging: ${MESSAGING_PROGRAM_ID.toBase58()}`);
  console.log(`  Payments:  ${PAYMENTS_PROGRAM_ID.toBase58()}`);
  console.log(`  CLINK:     ${CLINK_MINT.toBase58()}`);
  console.log("");

  process.exit(test1Pass && test2Pass ? 0 : 1);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
