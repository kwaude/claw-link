import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ClawCashProtocol } from "./target/types/claw_cash_protocol";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getOrCreateAssociatedTokenAccount, TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { createHash } from "crypto";

const RECIPIENT = new PublicKey("DdpiseuHKecsBtTwMKw1rn6HUS2A6oysuT4ZcVrJZt5t");
const CLAWCASH_MINT = new PublicKey("8TJt8Zq4hz1znTz4wfsXrBHnnNsSgjN7iYGH23X1bMBY");
const ZERO = Buffer.alloc(32, 0);
const sha256 = (d: Buffer) => createHash("sha256").update(d).digest();
const hashPair = (l: Buffer, r: Buffer) => sha256(Buffer.concat([l, r]));

async function main() {
  console.log("\n🦞 E2E: Private payment to", RECIPIENT.toBase58());
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ClawCashProtocol as Program<ClawCashProtocol>;
  const wallet = provider.wallet as anchor.Wallet;
  const connection = provider.connection;
  const pid = program.programId;

  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], pid);
  const [treasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], pid);
  const poolId = 0;
  const poolIdBuf = Buffer.from([poolId]);
  const [poolPda] = PublicKey.findProgramAddressSync([Buffer.from("pool"), poolIdBuf], pid);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault"), poolIdBuf], pid);

  // Get CLAWCASH via faucet
  const ata = await getOrCreateAssociatedTokenAccount(connection, wallet.payer, CLAWCASH_MINT, wallet.publicKey);
  const bal = Number((await getAccount(connection, ata.address)).amount) / 1e6;
  if (bal < 100) {
    console.log("🪙 Claiming CLAWCASH from faucet...");
    await program.methods.claimTestTokens().accounts({
      config: configPda, clawcashMint: CLAWCASH_MINT,
      recipientTokenAccount: ata.address, payer: wallet.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
    } as any).rpc();
  }
  const balAfter = Number((await getAccount(connection, ata.address)).amount) / 1e6;
  console.log(`🪙 CLAWCASH: ${balAfter}`);

  // Generate note
  const secret = Buffer.from(Keypair.generate().secretKey.slice(0, 32));
  const nullPre = Buffer.from(Keypair.generate().secretKey.slice(0, 32));
  const commitment = sha256(Buffer.concat([secret, nullPre]));
  const nullHash = sha256(nullPre);

  const poolState = await program.account.pool.fetch(poolPda);
  const leafIndex = poolState.nextIndex;
  const leafBuf = Buffer.alloc(4); leafBuf.writeUInt32LE(leafIndex);
  const [leafPda] = PublicKey.findProgramAddressSync([Buffer.from("leaf"), poolIdBuf, leafBuf], pid);

  // Deposit
  console.log(`\n💰 Depositing 0.1 SOL (leaf ${leafIndex})...`);
  const depTx = await program.methods
    .deposit(Array.from(commitment) as any, poolId, leafIndex)
    .accounts({ config: configPda, pool: poolPda, vault: vaultPda, commitmentLeaf: leafPda,
      depositorClawcash: ata.address, treasury: treasuryPda, depositor: wallet.publicKey,
      systemProgram: SystemProgram.programId, tokenProgram: TOKEN_PROGRAM_ID } as any).rpc();
  console.log(`✅ Deposit: ${depTx}`);

  // Build Merkle proof
  const allLeaves: Buffer[] = [];
  for (let i = 0; i <= leafIndex; i++) {
    const ib = Buffer.alloc(4); ib.writeUInt32LE(i);
    const [lp] = PublicKey.findProgramAddressSync([Buffer.from("leaf"), poolIdBuf, ib], pid);
    try { const l = await program.account.commitmentLeaf.fetch(lp); allLeaves.push(Buffer.from(l.commitment)); }
    catch { allLeaves.push(ZERO); }
  }

  const zh: Buffer[] = [hashPair(ZERO, ZERO)];
  for (let i = 1; i < 20; i++) zh.push(hashPair(zh[i-1], zh[i-1]));

  const proof: Buffer[] = [];
  let cl = new Map<number, Buffer>();
  for (let i = 0; i < allLeaves.length; i++) cl.set(i, allLeaves[i]);
  let pi = leafIndex;
  for (let lv = 0; lv < 20; lv++) {
    const si = pi % 2 === 0 ? pi + 1 : pi - 1;
    proof.push(cl.get(si) ?? (lv === 0 ? ZERO : zh[lv-1]));
    const nl = new Map<number, Buffer>();
    const ps = new Set<number>();
    for (const idx of cl.keys()) ps.add(Math.floor(idx/2));
    if (cl.has(pi)) ps.add(Math.floor(pi/2));
    for (const p of ps) {
      const left = cl.get(p*2) ?? (lv === 0 ? ZERO : zh[lv-1]);
      const right = cl.get(p*2+1) ?? (lv === 0 ? ZERO : zh[lv-1]);
      nl.set(p, hashPair(left, right));
    }
    cl = nl; pi = Math.floor(pi/2);
  }

  const [nullPda] = PublicKey.findProgramAddressSync([Buffer.from("nullifier"), nullHash], pid);
  const recipBefore = await connection.getBalance(RECIPIENT);

  // Withdraw
  console.log(`💸 Withdrawing to ${RECIPIENT.toBase58()}...`);
  const wTx = await program.methods
    .withdraw(Array.from(secret) as any, Array.from(nullPre) as any, Array.from(nullHash) as any,
      leafIndex, proof.map(p => Array.from(p) as any))
    .accounts({ pool: poolPda, vault: vaultPda, nullifierAccount: nullPda,
      recipient: RECIPIENT, payer: wallet.publicKey, systemProgram: SystemProgram.programId } as any).rpc();

  const recipAfter = await connection.getBalance(RECIPIENT);
  console.log(`✅ Withdraw: ${wTx}`);
  console.log(`\n💰 Received: ${(recipAfter - recipBefore) / LAMPORTS_PER_SOL} SOL`);
  console.log(`\n🔍 Deposit:  https://solscan.io/tx/${depTx}?cluster=devnet`);
  console.log(`🔍 Withdraw: https://solscan.io/tx/${wTx}?cluster=devnet\n`);
}
main().catch(console.error);
