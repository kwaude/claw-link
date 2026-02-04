/**
 * Initialize the payments program with CLINK token on devnet.
 * Sets up config + all 3 pools.
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, Connection, SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

const PAYMENTS_PROGRAM_ID = new PublicKey("AV9QieTmdg2hFWsaZ3uTJRJuqqbhQCYFjn1fGiSYPTNe");
const CLINK_MINT = new PublicKey("AxJDt4Pnst1Xv9GgfbPCyHMWSzGPBYcNbh95YjywEqy1"); // devnet
const DEVNET_RPC = "https://api.devnet.solana.com";
const FEE = new BN(10_000_000_000); // 10 CLINK (9 decimals)

async function main() {
  const connection = new Connection(DEVNET_RPC, "confirmed");
  
  // Load wallet
  const walletPath = os.homedir() + "/.config/solana/id.json";
  const walletSecret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(walletSecret));
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${balance / 1e9} SOL`);

  // Load IDL
  const idlPath = `${os.homedir()}/Code/claw-link/target/idl/claw_link_payments.json`;
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(wallet),
    { commitment: "confirmed" }
  );
  const program = new Program(idl, provider);

  // Derive PDAs
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")], PAYMENTS_PROGRAM_ID
  );
  const [treasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")], PAYMENTS_PROGRAM_ID
  );

  console.log(`\nConfig PDA: ${configPda.toBase58()}`);
  console.log(`Treasury PDA: ${treasuryPda.toBase58()}`);
  console.log(`CLINK Mint: ${CLINK_MINT.toBase58()}`);
  console.log(`Fee: 10 CLINK`);

  // Check if config exists
  const configInfo = await connection.getAccountInfo(configPda);
  if (configInfo) {
    console.log("\n✅ Config already initialized, skipping...");
  } else {
    console.log("\n1. Initializing config...");
    try {
      const tx = await program.methods
        .initialize(FEE)
        .accounts({
          config: configPda,
          clinkMint: CLINK_MINT,
          treasury: treasuryPda,
          authority: wallet.publicKey,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc();
      console.log(`   ✅ Config initialized: ${tx}`);
    } catch (e: any) {
      console.log(`   ❌ Failed: ${e.message.slice(0, 100)}`);
      return;
    }
  }

  // Initialize pools
  for (const poolId of [0, 1, 2]) {
    const denominations = ["0.1 SOL", "1 SOL", "10 SOL"];
    const [poolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), Buffer.from([poolId])],
      PAYMENTS_PROGRAM_ID
    );
    const [vaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), Buffer.from([poolId])],
      PAYMENTS_PROGRAM_ID
    );

    console.log(`\n2.${poolId + 1}. Initializing pool ${poolId} (${denominations[poolId]})...`);
    try {
      const tx = await program.methods
        .initializePool(poolId)
        .accounts({
          pool: poolPda,
          vault: vaultPda,
          config: configPda,
          authority: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      console.log(`   ✅ Pool ${poolId} initialized: ${tx}`);
    } catch (e: any) {
      console.log(`   ❌ Failed: ${e.message.slice(0, 100)}`);
    }
  }

  console.log("\n✅ Payments program fully initialized with CLINK!");
  console.log(`   Program: ${PAYMENTS_PROGRAM_ID.toBase58()}`);
  console.log(`   Token: CLINK (${CLINK_MINT.toBase58()})`);
  console.log(`   Fee: 10 CLINK per deposit`);
}

main().catch(console.error);
