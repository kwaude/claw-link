import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ClawCashProtocol } from "../target/types/claw_cash_protocol";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { createHash } from "crypto";
import { expect } from "chai";

// ─── Constants ────────────────────────────────────────────────────────

const MERKLE_TREE_DEPTH = 20;
const ZERO_VALUE = Buffer.alloc(32, 0);

const POOL_DENOMINATIONS = [
  0.1 * LAMPORTS_PER_SOL, // Pool 0: 0.1 SOL
  1 * LAMPORTS_PER_SOL, // Pool 1: 1 SOL
  10 * LAMPORTS_PER_SOL, // Pool 2: 10 SOL
];

const FEE_AMOUNT = 100_000_000; // 100 CLAWCASH (6 decimals)

// ─── Helpers ──────────────────────────────────────────────────────────

/** SHA-256 hash of arbitrary data (matches Solana's hash::hash) */
function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

/** Hash two 32-byte nodes together for the Merkle tree */
function hashPair(left: Buffer, right: Buffer): Buffer {
  const combined = Buffer.concat([left, right]);
  return sha256(combined);
}

/** Precompute zero hashes for each level of the Merkle tree */
function zeroHashes(): Buffer[] {
  const zh: Buffer[] = new Array(MERKLE_TREE_DEPTH);
  zh[0] = hashPair(ZERO_VALUE, ZERO_VALUE);
  for (let i = 1; i < MERKLE_TREE_DEPTH; i++) {
    zh[i] = hashPair(zh[i - 1], zh[i - 1]);
  }
  return zh;
}

interface Note {
  secret: Buffer;
  nullifierPreimage: Buffer;
  commitment: Buffer;
  nullifierHash: Buffer;
}

/** Generate a random note (secret + nullifier_preimage → commitment, nullifier) */
function generateNote(): Note {
  const secret = Keypair.generate().secretKey.slice(0, 32);
  const nullifierPreimage = Keypair.generate().secretKey.slice(0, 32);

  const secretBuf = Buffer.from(secret);
  const nullifierPreimageBuf = Buffer.from(nullifierPreimage);

  const commitment = sha256(Buffer.concat([secretBuf, nullifierPreimageBuf]));
  const nullifierHash = sha256(nullifierPreimageBuf);

  return {
    secret: secretBuf,
    nullifierPreimage: nullifierPreimageBuf,
    commitment,
    nullifierHash,
  };
}

/**
 * Compute a Merkle proof for a leaf at the given index.
 * Rebuilds the tree incrementally to match the on-chain insertion.
 *
 * `leaves` are the commitments in insertion order.
 * Returns the sibling path (20 elements) for verification.
 */
function computeMerkleProof(
  leaves: Buffer[],
  targetIndex: number
): Buffer[] {
  const zh = zeroHashes();
  const proof: Buffer[] = [];

  // Build tree layer by layer
  // Layer 0: the leaf layer
  // We only need to track nodes that differ from the zero pattern
  let currentLayer = new Map<number, Buffer>();
  for (let i = 0; i < leaves.length; i++) {
    currentLayer.set(i, leaves[i]);
  }

  let pathIndex = targetIndex;

  for (let level = 0; level < MERKLE_TREE_DEPTH; level++) {
    // Get the sibling of pathIndex at this level
    const siblingIndex = pathIndex % 2 === 0 ? pathIndex + 1 : pathIndex - 1;

    let siblingHash: Buffer;
    if (currentLayer.has(siblingIndex)) {
      siblingHash = currentLayer.get(siblingIndex)!;
    } else {
      // Empty subtree at this level
      siblingHash = level === 0 ? ZERO_VALUE : zh[level - 1];
    }
    proof.push(siblingHash);

    // Build next layer
    const nextLayer = new Map<number, Buffer>();
    const parentIndices = new Set<number>();

    for (const idx of currentLayer.keys()) {
      parentIndices.add(Math.floor(idx / 2));
    }

    for (const parentIdx of parentIndices) {
      const leftIdx = parentIdx * 2;
      const rightIdx = parentIdx * 2 + 1;

      const left = currentLayer.has(leftIdx)
        ? currentLayer.get(leftIdx)!
        : level === 0
        ? ZERO_VALUE
        : zh[level - 1];
      const right = currentLayer.has(rightIdx)
        ? currentLayer.get(rightIdx)!
        : level === 0
        ? ZERO_VALUE
        : zh[level - 1];

      nextLayer.set(parentIdx, hashPair(left, right));
    }

    currentLayer = nextLayer;
    pathIndex = Math.floor(pathIndex / 2);
  }

  return proof;
}

/**
 * Compute the Merkle root from leaves, matching the on-chain incremental insertion.
 * This inserts leaves one at a time using the same algorithm as the program.
 */
function computeIncrementalRoot(leaves: Buffer[]): Buffer {
  const zh = zeroHashes();

  // Start with the zero root
  let filledSubtrees: Buffer[] = new Array(MERKLE_TREE_DEPTH);
  filledSubtrees[0] = ZERO_VALUE;
  for (let i = 1; i < MERKLE_TREE_DEPTH; i++) {
    filledSubtrees[i] = zh[i - 1];
  }
  let currentRoot = zh[MERKLE_TREE_DEPTH - 1];

  // Insert each leaf
  for (let leafIdx = 0; leafIdx < leaves.length; leafIdx++) {
    let currentHash = leaves[leafIdx];
    let currentIndex = leafIdx;

    for (let i = 0; i < MERKLE_TREE_DEPTH; i++) {
      if (currentIndex % 2 === 0) {
        filledSubtrees[i] = currentHash;
        const zeroAtLevel = i === 0 ? ZERO_VALUE : zh[i - 1];
        currentHash = hashPair(currentHash, zeroAtLevel);
      } else {
        currentHash = hashPair(filledSubtrees[i], currentHash);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }

    currentRoot = currentHash;
  }

  return currentRoot;
}

/** Derive a PDA for a pool */
function getPoolPDA(programId: PublicKey, poolId: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from([poolId])],
    programId
  );
}

/** Derive a PDA for a vault */
function getVaultPDA(
  programId: PublicKey,
  poolId: number
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), Buffer.from([poolId])],
    programId
  );
}

/** Derive a PDA for a commitment leaf */
function getLeafPDA(
  programId: PublicKey,
  poolId: number,
  leafIndex: number
): [PublicKey, number] {
  const leafIndexBuf = Buffer.alloc(4);
  leafIndexBuf.writeUInt32LE(leafIndex);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("leaf"), Buffer.from([poolId]), leafIndexBuf],
    programId
  );
}

/** Derive a PDA for a nullifier */
function getNullifierPDA(
  programId: PublicKey,
  nullifierHash: Buffer
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), nullifierHash],
    programId
  );
}

/** Derive config PDA */
function getConfigPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
}

/** Derive treasury PDA */
function getTreasuryPDA(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    programId
  );
}

// ─── Tests ────────────────────────────────────────────────────────────

describe("Claw Cash Protocol v2", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .clawCashProtocol as Program<ClawCashProtocol>;
  const authority = provider.wallet as anchor.Wallet;

  let clawcashMint: PublicKey;
  let depositorClawcashAccount: PublicKey;
  const programId = program.programId;

  // Track notes for withdrawal tests
  const pool0Notes: Note[] = [];
  const pool0Leaves: Buffer[] = [];
  const pool1Notes: Note[] = [];
  const pool1Leaves: Buffer[] = [];

  before(async () => {
    // Airdrop SOL to authority for transaction fees
    const sig = await provider.connection.requestAirdrop(
      authority.publicKey,
      100 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    // Create mock CLAWCASH SPL token mint (6 decimals)
    clawcashMint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      6 // 6 decimals like the real CLAWCASH
    );

    // Create depositor's CLAWCASH token account and mint tokens
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority.payer,
      clawcashMint,
      authority.publicKey
    );
    depositorClawcashAccount = ata.address;

    // Mint plenty of CLAWCASH for fees
    await mintTo(
      provider.connection,
      authority.payer,
      clawcashMint,
      depositorClawcashAccount,
      authority.publicKey,
      10_000_000_000 // 10,000 CLAWCASH
    );
  });

  // ─── Initialize Protocol ──────────────────────────────────────────

  describe("initialize", () => {
    it("initializes the protocol config with correct fee", async () => {
      const [configPDA] = getConfigPDA(programId);
      const [treasuryPDA] = getTreasuryPDA(programId);

      await program.methods
        .initialize(new BN(FEE_AMOUNT))
        .accounts({
          clawcashMint: clawcashMint,
          authority: authority.publicKey,
        })
        .rpc();

      // Verify config state
      const config = await program.account.protocolConfig.fetch(configPDA);
      expect(config.authority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(config.clawcashMint.toBase58()).to.equal(
        clawcashMint.toBase58()
      );
      expect(config.feeAmount.toNumber()).to.equal(FEE_AMOUNT);
      expect(config.treasury.toBase58()).to.equal(treasuryPDA.toBase58());
    });
  });

  // ─── Initialize Pools ─────────────────────────────────────────────

  describe("initialize_pool", () => {
    it("initializes pool 0 (0.1 SOL)", async () => {
      await program.methods
        .initializePool(0)
        .accounts({
          authority: authority.publicKey,
        })
        .rpc();

      const [poolPDA] = getPoolPDA(programId, 0);
      const pool = await program.account.pool.fetch(poolPDA);
      expect(pool.poolId).to.equal(0);
      expect(pool.denomination.toNumber()).to.equal(POOL_DENOMINATIONS[0]);
      expect(pool.nextIndex).to.equal(0);
      expect(pool.filledSubtrees.length).to.equal(MERKLE_TREE_DEPTH);
    });

    it("initializes pool 1 (1 SOL)", async () => {
      await program.methods
        .initializePool(1)
        .accounts({
          authority: authority.publicKey,
        })
        .rpc();

      const [poolPDA] = getPoolPDA(programId, 1);
      const pool = await program.account.pool.fetch(poolPDA);
      expect(pool.poolId).to.equal(1);
      expect(pool.denomination.toNumber()).to.equal(POOL_DENOMINATIONS[1]);
      expect(pool.nextIndex).to.equal(0);
    });

    it("initializes pool 2 (10 SOL)", async () => {
      await program.methods
        .initializePool(2)
        .accounts({
          authority: authority.publicKey,
        })
        .rpc();

      const [poolPDA] = getPoolPDA(programId, 2);
      const pool = await program.account.pool.fetch(poolPDA);
      expect(pool.poolId).to.equal(2);
      expect(pool.denomination.toNumber()).to.equal(POOL_DENOMINATIONS[2]);
      expect(pool.nextIndex).to.equal(0);
    });
  });

  // ─── Deposit ──────────────────────────────────────────────────────

  describe("deposit", () => {
    it("deposits into pool 0 (0.1 SOL) with CLAWCASH fee", async () => {
      const note = generateNote();
      pool0Notes.push(note);
      pool0Leaves.push(note.commitment);

      const [poolPDA] = getPoolPDA(programId, 0);
      const [vaultPDA] = getVaultPDA(programId, 0);
      const [treasuryPDA] = getTreasuryPDA(programId);

      const vaultBefore = await provider.connection.getBalance(vaultPDA);

      await program.methods
        .deposit(
          Array.from(note.commitment) as any,
          0,
          0
        )
        .accounts({
          depositorClawcash: depositorClawcashAccount,
          depositor: authority.publicKey,
        })
        .rpc();

      // Verify vault received SOL
      const vaultAfter = await provider.connection.getBalance(vaultPDA);
      expect(vaultAfter - vaultBefore).to.equal(POOL_DENOMINATIONS[0]);

      // Verify pool state updated
      const pool = await program.account.pool.fetch(poolPDA);
      expect(pool.nextIndex).to.equal(1);

      // Verify commitment leaf stored
      const [leafPDA] = getLeafPDA(programId, 0, 0);
      const leaf = await program.account.commitmentLeaf.fetch(leafPDA);
      expect(Buffer.from(leaf.commitment as number[])).to.deep.equal(
        note.commitment
      );
      expect(leaf.leafIndex).to.equal(0);
      expect(leaf.poolId).to.equal(0);

      // Verify Merkle root matches our computation
      const expectedRoot = computeIncrementalRoot(pool0Leaves);
      expect(Buffer.from(pool.currentRoot as number[])).to.deep.equal(
        expectedRoot
      );
    });

    it("deposits into pool 1 (1 SOL)", async () => {
      const note = generateNote();
      pool1Notes.push(note);
      pool1Leaves.push(note.commitment);

      const [vaultPDA] = getVaultPDA(programId, 1);
      const vaultBefore = await provider.connection.getBalance(vaultPDA);

      await program.methods
        .deposit(
          Array.from(note.commitment) as any,
          1,
          0
        )
        .accounts({
          depositorClawcash: depositorClawcashAccount,
          depositor: authority.publicKey,
        })
        .rpc();

      const vaultAfter = await provider.connection.getBalance(vaultPDA);
      expect(vaultAfter - vaultBefore).to.equal(POOL_DENOMINATIONS[1]);

      const [poolPDA] = getPoolPDA(programId, 1);
      const pool = await program.account.pool.fetch(poolPDA);
      expect(pool.nextIndex).to.equal(1);
    });

    it("handles multiple deposits into the same pool", async () => {
      // Deposit 2 more into pool 0 (leaf indices 1 and 2)
      for (let i = 1; i <= 2; i++) {
        const note = generateNote();
        pool0Notes.push(note);
        pool0Leaves.push(note.commitment);

        await program.methods
          .deposit(
            Array.from(note.commitment) as any,
            0,
            i
          )
          .accounts({
            depositorClawcash: depositorClawcashAccount,
            depositor: authority.publicKey,
          })
          .rpc();
      }

      const [poolPDA] = getPoolPDA(programId, 0);
      const pool = await program.account.pool.fetch(poolPDA);
      expect(pool.nextIndex).to.equal(3);

      // Verify the Merkle root matches incremental computation
      const expectedRoot = computeIncrementalRoot(pool0Leaves);
      expect(Buffer.from(pool.currentRoot as number[])).to.deep.equal(
        expectedRoot
      );
    });
  });

  // ─── Withdraw ─────────────────────────────────────────────────────

  describe("withdraw", () => {
    it("withdraws from pool 0 with correct secret + Merkle proof", async () => {
      const note = pool0Notes[0]; // First deposit
      const leafIndex = 0;
      const poolId = 0;

      // Compute Merkle proof
      const proof = computeMerkleProof(pool0Leaves, leafIndex);

      // Use a fresh recipient for privacy
      const recipient = Keypair.generate();

      const [poolPDA] = getPoolPDA(programId, poolId);
      const [vaultPDA] = getVaultPDA(programId, poolId);
      const [nullifierPDA] = getNullifierPDA(programId, note.nullifierHash);

      const recipientBefore = await provider.connection.getBalance(
        recipient.publicKey
      );

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
          recipient: recipient.publicKey,
          payer: authority.publicKey,
        })
        .rpc();

      // Verify recipient received SOL
      const recipientAfter = await provider.connection.getBalance(
        recipient.publicKey
      );
      expect(recipientAfter - recipientBefore).to.equal(
        POOL_DENOMINATIONS[poolId]
      );

      // Verify nullifier account created
      const nullifier = await program.account.nullifierAccount.fetch(
        nullifierPDA
      );
      expect(Buffer.from(nullifier.nullifier as number[])).to.deep.equal(
        note.nullifierHash
      );
      expect(nullifier.poolId).to.equal(poolId);
    });

    it("rejects withdrawal with wrong secret", async () => {
      const note = pool0Notes[1]; // Second deposit (not yet withdrawn)
      const leafIndex = 1;
      const poolId = 0;

      // Generate a wrong secret
      const wrongSecret = Buffer.from(
        Keypair.generate().secretKey.slice(0, 32)
      );

      const proof = computeMerkleProof(pool0Leaves, leafIndex);
      const recipient = Keypair.generate();
      const [poolPDA] = getPoolPDA(programId, poolId);

      try {
        await program.methods
          .withdraw(
            Array.from(wrongSecret) as any,
            Array.from(note.nullifierPreimage) as any,
            Array.from(note.nullifierHash) as any,
            leafIndex,
            proof.map((p) => Array.from(p) as any)
          )
          .accounts({
            pool: poolPDA,
            recipient: recipient.publicKey,
            payer: authority.publicKey,
          })
          .rpc();
        expect.fail("Should have rejected wrong secret");
      } catch (err: any) {
        // Should fail with InvalidProof because wrong secret → wrong commitment → wrong root
        expect(err.toString()).to.include("InvalidProof");
      }
    });

    it("rejects double-spend (same nullifier)", async () => {
      const note = pool0Notes[0]; // Already withdrawn above
      const leafIndex = 0;
      const poolId = 0;

      const proof = computeMerkleProof(pool0Leaves, leafIndex);
      const recipient = Keypair.generate();
      const [poolPDA] = getPoolPDA(programId, poolId);

      try {
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
            recipient: recipient.publicKey,
            payer: authority.publicKey,
          })
          .rpc();
        expect.fail("Should have rejected double-spend");
      } catch (err: any) {
        // The nullifier PDA already exists, so account init will fail
        // This manifests as an "already in use" error from the runtime
        expect(err.toString()).to.satisfy(
          (s: string) =>
            s.includes("already in use") ||
            s.includes("NullifierAlreadyUsed") ||
            s.includes("already been processed") ||
            s.includes("0x0") ||
            s.includes("custom program error") ||
            s.includes("failed to send transaction"),
          `Unexpected error: ${err.toString()}`
        );
      }
    });

    it("withdraws second deposit from pool 0 (leaf index 1)", async () => {
      const note = pool0Notes[1]; // Second deposit
      const leafIndex = 1;
      const poolId = 0;

      const proof = computeMerkleProof(pool0Leaves, leafIndex);
      const recipient = Keypair.generate();
      const [poolPDA] = getPoolPDA(programId, poolId);

      const recipientBefore = await provider.connection.getBalance(
        recipient.publicKey
      );

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
          recipient: recipient.publicKey,
          payer: authority.publicKey,
        })
        .rpc();

      const recipientAfter = await provider.connection.getBalance(
        recipient.publicKey
      );
      expect(recipientAfter - recipientBefore).to.equal(
        POOL_DENOMINATIONS[poolId]
      );
    });
  });

  // ─── Update Fee ───────────────────────────────────────────────────

  describe("update_fee", () => {
    it("updates the fee amount (authority only)", async () => {
      const newFee = 200_000_000; // 200 CLAWCASH
      const [configPDA] = getConfigPDA(programId);

      await program.methods
        .updateFee(new BN(newFee))
        .accounts({
          authority: authority.publicKey,
        })
        .rpc();

      const config = await program.account.protocolConfig.fetch(configPDA);
      expect(config.feeAmount.toNumber()).to.equal(newFee);
    });
  });
});
