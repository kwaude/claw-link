/**
 * Setup Claw Cash on devnet with faucet-enabled CLAWCASH mint.
 * Creates a CLAWCASH mint where the config PDA is the mint authority,
 * so the program's claim_test_tokens instruction can mint tokens.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ClawCashProtocol } from "./target/types/claw_cash_protocol";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, getAccount,
} from "@solana/spl-token";
import { createHash } from "crypto";

const FEE_AMOUNT = 100_000_000; // 100 CLAWCASH (6 decimals)

async function main() {
  console.log("\n🔧 CLAW CASH DEVNET SETUP\n");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ClawCashProtocol as Program<ClawCashProtocol>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;

  const programId = program.programId;
  console.log(`📍 Program: ${programId.toBase58()}`);
  console.log(`💰 Wallet:  ${wallet.publicKey.toBase58()}`);
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`💵 Balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  // Derive the config PDA (this will be the mint authority)
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], programId);
  console.log(`\n🔑 Config PDA: ${configPda.toBase58()}`);

  // Step 1: Create devnet CLAWCASH mint with config PDA as mint authority
  console.log("\n─── Step 1: Create Devnet CLAWCASH Mint ───");
  const mintKeypair = Keypair.generate();
  const clawcashMint = await createMint(
    connection,
    wallet.payer,
    configPda,      // mint authority = config PDA (so program can mint via faucet)
    null,           // no freeze authority
    6,              // 6 decimals
    mintKeypair,
  );
  console.log(`✅ CLAWCASH Mint: ${clawcashMint.toBase58()}`);
  console.log(`   Mint authority: ${configPda.toBase58()} (config PDA)`);

  // Step 2: Initialize protocol
  console.log("\n─── Step 2: Initialize Protocol ───");
  await program.methods
    .initialize(new BN(FEE_AMOUNT))
    .accounts({
      config: configPda,
      clawcashMint: clawcashMint,
      treasury: treasuryPda,
      authority: wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_PROGRAM_ID,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  console.log(`✅ Protocol initialized (fee: 100 CLAWCASH)`);

  // Step 3: Initialize all 3 pools
  console.log("\n─── Step 3: Initialize Pools ───");
  for (const poolId of [0, 1, 2]) {
    const poolIdBuf = Buffer.from([poolId]);
    const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool"), poolIdBuf], programId);
    const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), poolIdBuf], programId);
    
    await program.methods
      .initializePool(poolId)
      .accounts({
        pool: poolPda, vault: vaultPda, config: configPda,
        authority: wallet.publicKey, systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    const denom = [0.1, 1, 10][poolId];
    console.log(`✅ Pool ${poolId} initialized (${denom} SOL)`);
  }

  // Step 4: Test the faucet
  console.log("\n─── Step 4: Test Faucet ───");
  const agentAta = await getOrCreateAssociatedTokenAccount(
    connection, wallet.payer, clawcashMint, wallet.publicKey
  );
  console.log(`   Agent token account: ${agentAta.address.toBase58()}`);

  const balBefore = Number((await getAccount(connection, agentAta.address)).amount);
  
  await program.methods
    .claimTestTokens()
    .accounts({
      config: configPda,
      clawcashMint: clawcashMint,
      recipientTokenAccount: agentAta.address,
      payer: wallet.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    } as any)
    .rpc();
  
  const balAfter = Number((await getAccount(connection, agentAta.address)).amount);
  console.log(`✅ Faucet dispensed ${(balAfter - balBefore) / 1_000_000} CLAWCASH`);
  console.log(`   Balance: ${balAfter / 1_000_000} CLAWCASH`);

  // Step 5: E2E test — deposit + withdraw
  console.log("\n─── Step 5: E2E Test ───");
  const secret = Buffer.from(Keypair.generate().secretKey.slice(0, 32));
  const nullifierPreimage = Buffer.from(Keypair.generate().secretKey.slice(0, 32));
  const commitment = createHash("sha256").update(Buffer.concat([secret, nullifierPreimage])).digest();
  const nullifierHash = createHash("sha256").update(nullifierPreimage).digest();

  const poolId = 0;
  const poolIdBuf = Buffer.from([poolId]);
  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool"), poolIdBuf], programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), poolIdBuf], programId);
  
  const leafIndex = 0;
  const leafIndexBuf = Buffer.alloc(4);
  leafIndexBuf.writeUInt32LE(leafIndex);
  const [leafPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("leaf"), poolIdBuf, leafIndexBuf], programId
  );

  // Deposit
  await program.methods
    .deposit(Array.from(commitment) as any, poolId, leafIndex)
    .accounts({
      config: configPda, pool: poolPda, vault: vaultPda,
      commitmentLeaf: leafPda, depositorClawcash: agentAta.address,
      treasury: treasuryPda, depositor: wallet.publicKey,
      systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID,
    } as any).rpc();
  console.log(`✅ Deposited 0.1 SOL`);

  // Withdraw to random recipient
  const recipient = Keypair.generate();
  
  // Merkle proof for single leaf
  const ZERO = Buffer.alloc(32, 0);
  function sha256(d: Buffer): Buffer { return createHash("sha256").update(d).digest(); }
  function hashPair(l: Buffer, r: Buffer): Buffer { return sha256(Buffer.concat([l, r])); }
  const zh: Buffer[] = [hashPair(ZERO, ZERO)];
  for (let i = 1; i < 20; i++) zh.push(hashPair(zh[i-1], zh[i-1]));
  const proof = [ZERO, ...zh.slice(0, 19)];

  const [nullifierPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier"), nullifierHash], programId
  );

  await program.methods
    .withdraw(
      Array.from(secret) as any,
      Array.from(nullifierPreimage) as any,
      Array.from(nullifierHash) as any,
      leafIndex,
      proof.map(p => Array.from(p) as any)
    )
    .accounts({
      pool: poolPda, vault: vaultPda, nullifierAccount: nullifierPda,
      recipient: recipient.publicKey, payer: wallet.publicKey,
      systemProgram: SystemProgram.programId,
    } as any).rpc();
  
  const recipBal = await connection.getBalance(recipient.publicKey);
  console.log(`✅ Withdrew ${recipBal / LAMPORTS_PER_SOL} SOL to ${recipient.publicKey.toBase58()}`);

  // Summary
  console.log("\n" + "=".repeat(55));
  console.log("🎉 DEVNET SETUP COMPLETE");
  console.log("=".repeat(55));
  console.log(`\n  Program ID:     ${programId.toBase58()}`);
  console.log(`  CLAWCASH Mint:  ${clawcashMint.toBase58()}`);
  console.log(`  Config PDA:     ${configPda.toBase58()}`);
  console.log(`  Fee:            100 CLAWCASH per deposit`);
  console.log(`  Faucet:         1,000 CLAWCASH per claim`);
  console.log(`  Pools:          0.1 / 1 / 10 SOL`);
  console.log(`\n  Agents can call claim_test_tokens() to get devnet CLAWCASH!\n`);
}

main().catch(console.error);
