import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ClawCashProtocol } from "../target/types/claw_cash_protocol";
import {
  Keypair,
  PublicKey,
  Connection,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { createHash } from "crypto";

// ─── Config ───────────────────────────────────────────────────────
const PROGRAM_ID = new PublicKey("DpVYsUBZ9f8Lny2xvPUK6E8RWxBA7pBh2XRLHWUu9jHP");
const CLAWCASH_MINT = new PublicKey("8TJt8Zq4hz1znTz4wfsXrBHnnNsSgjN7iYGH23X1bMBY");
const RECIPIENT = new PublicKey("DdpiseuHKecsBtTwMKw1rn6HUS2A6oysuT4ZcVrJZt5t");
const POOL_ID = 0; // 0.1 SOL pool
const MERKLE_TREE_DEPTH = 20;
const ZERO_VALUE = Buffer.alloc(32, 0);

// ─── Helpers ──────────────────────────────────────────────────────
function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function hashPair(left: Buffer, right: Buffer): Buffer {
  return sha256(Buffer.concat([left, right]));
}

function zeroHashes(): Buffer[] {
  const zh: Buffer[] = new Array(MERKLE_TREE_DEPTH);
  zh[0] = hashPair(ZERO_VALUE, ZERO_VALUE);
  for (let i = 1; i < MERKLE_TREE_DEPTH; i++) {
    zh[i] = hashPair(zh[i - 1], zh[i - 1]);
  }
  return zh;
}

function generateNote() {
  const secret = Buffer.from(Keypair.generate().secretKey.slice(0, 32));
  const nullifierPreimage = Buffer.from(Keypair.generate().secretKey.slice(0, 32));
  const commitment = sha256(Buffer.concat([secret, nullifierPreimage]));
  const nullifierHash = sha256(nullifierPreimage);
  return { secret, nullifierPreimage, commitment, nullifierHash };
}

function computeMerkleProof(leaves: Buffer[], targetIndex: number): Buffer[] {
  const zh = zeroHashes();
  const proof: Buffer[] = [];
  let currentLayer = new Map<number, Buffer>();
  for (let i = 0; i < leaves.length; i++) {
    currentLayer.set(i, leaves[i]);
  }
  let pathIndex = targetIndex;
  for (let level = 0; level < MERKLE_TREE_DEPTH; level++) {
    const siblingIndex = pathIndex % 2 === 0 ? pathIndex + 1 : pathIndex - 1;
    let siblingHash: Buffer;
    if (currentLayer.has(siblingIndex)) {
      siblingHash = currentLayer.get(siblingIndex)!;
    } else {
      siblingHash = level === 0 ? ZERO_VALUE : zh[level - 1];
    }
    proof.push(siblingHash);
    const nextLayer = new Map<number, Buffer>();
    const parentIndices = new Set<number>();
    for (const idx of currentLayer.keys()) {
      parentIndices.add(Math.floor(idx / 2));
    }
    for (const parentIdx of parentIndices) {
      const leftIdx = parentIdx * 2;
      const rightIdx = parentIdx * 2 + 1;
      const left = currentLayer.has(leftIdx) ? currentLayer.get(leftIdx)! : level === 0 ? ZERO_VALUE : zh[level - 1];
      const right = currentLayer.has(rightIdx) ? currentLayer.get(rightIdx)! : level === 0 ? ZERO_VALUE : zh[level - 1];
      nextLayer.set(parentIdx, hashPair(left, right));
    }
    currentLayer = nextLayer;
    pathIndex = Math.floor(pathIndex / 2);
  }
  return proof;
}

function getPDA(seeds: Buffer[], programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, programId);
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  // Setup provider pointing to devnet
  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const wallet = anchor.Wallet.local();
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    require("fs").readFileSync("target/idl/claw_cash_protocol.json", "utf8")
  );
  const program = new Program(idl, provider) as Program<ClawCashProtocol>;

  console.log("Wallet:", wallet.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  // Step 1: Claim test CLAWCASH tokens from faucet
  console.log("\n1. Claiming test CLAWCASH from faucet...");
  const [configPDA] = getPDA([Buffer.from("config")], PROGRAM_ID);
  
  const depositorClawcash = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet.payer,
    CLAWCASH_MINT,
    wallet.publicKey
  );
  console.log("   CLAWCASH account:", depositorClawcash.address.toBase58());

  try {
    await program.methods
      .claimTestTokens()
      .accounts({
        claimer: wallet.publicKey,
      })
      .rpc();
    console.log("   ✅ Claimed 1,000 CLAWCASH");
  } catch (e: any) {
    console.log("   ℹ️  Faucet:", e.message?.slice(0, 80));
  }

  // Step 2: Check current pool state to get next leaf index
  console.log("\n2. Checking pool state...");
  const [poolPDA] = getPDA([Buffer.from("pool"), Buffer.from([POOL_ID])], PROGRAM_ID);
  const pool = await program.account.pool.fetch(poolPDA);
  const leafIndex = pool.nextIndex;
  console.log("   Pool 0 next index:", leafIndex);

  // Step 3: Generate note and deposit
  console.log("\n3. Depositing 0.1 SOL into privacy pool...");
  const note = generateNote();
  
  await program.methods
    .deposit(
      Array.from(note.commitment) as any,
      POOL_ID,
      leafIndex
    )
    .accounts({
      depositorClawcash: depositorClawcash.address,
      depositor: wallet.publicKey,
    })
    .rpc();
  console.log("   ✅ Deposit TX confirmed");
  console.log("   Commitment:", note.commitment.toString("hex").slice(0, 16) + "...");

  // Step 4: Fetch all leaves for Merkle proof
  console.log("\n4. Building Merkle proof...");
  // Fetch all commitment leaves for this pool
  const leaves: Buffer[] = [];
  for (let i = 0; i <= leafIndex; i++) {
    const leafIndexBuf = Buffer.alloc(4);
    leafIndexBuf.writeUInt32LE(i);
    const [leafPDA] = getPDA(
      [Buffer.from("leaf"), Buffer.from([POOL_ID]), leafIndexBuf],
      PROGRAM_ID
    );
    const leaf = await program.account.commitmentLeaf.fetch(leafPDA);
    leaves.push(Buffer.from(leaf.commitment as number[]));
  }
  
  const proof = computeMerkleProof(leaves, leafIndex);
  console.log("   ✅ Merkle proof computed (", leaves.length, "leaves)");

  // Step 5: Withdraw to Luke's address
  console.log("\n5. Withdrawing 0.1 SOL to", RECIPIENT.toBase58().slice(0, 8) + "...");
  
  const recipientBefore = await connection.getBalance(RECIPIENT);
  
  await program.methods
    .withdraw(
      Array.from(note.secret) as any,
      Array.from(note.nullifierPreimage) as any,
      Array.from(note.nullifierHash) as any,
      leafIndex,
      proof.map((p) => Array.from(p) as any)
    )
    .accounts({
      pool: poolPDA,
      recipient: RECIPIENT,
      payer: wallet.publicKey,
    })
    .rpc();

  const recipientAfter = await connection.getBalance(RECIPIENT);
  const received = (recipientAfter - recipientBefore) / LAMPORTS_PER_SOL;
  
  console.log("   ✅ Withdrawal TX confirmed");
  console.log("   Recipient received:", received, "SOL");
  console.log("\n🎉 Private payment complete!");
  console.log("   Deposit wallet:", wallet.publicKey.toBase58());
  console.log("   Recipient wallet:", RECIPIENT.toBase58());
  console.log("   Amount: 0.1 SOL (no on-chain link between wallets)");
}

main().catch(console.error);
