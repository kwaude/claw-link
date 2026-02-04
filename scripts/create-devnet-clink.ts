/**
 * Create CLINK token mint on devnet for the Claw Link protocol.
 * Mint authority = deployer wallet (for devnet faucet).
 */
import {
  Keypair, PublicKey, Connection, SystemProgram,
} from "@solana/web3.js";
import {
  createMint, mintTo, getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

const DEVNET_RPC = "https://api.devnet.solana.com";

async function main() {
  const connection = new Connection(DEVNET_RPC, "confirmed");
  
  const walletPath = os.homedir() + "/.config/solana/id.json";
  const walletSecret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(walletSecret));
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);

  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`Balance: ${balance / 1e9} SOL\n`);

  // Create CLINK mint (9 decimals, same as mainnet)
  console.log("Creating CLINK mint on devnet...");
  const clinkMint = await createMint(
    connection,
    wallet,       // payer
    wallet.publicKey,  // mint authority
    null,         // freeze authority (none)
    9,            // decimals
  );
  console.log(`✅ CLINK Devnet Mint: ${clinkMint.toBase58()}`);

  // Mint some CLINK to our wallet for testing
  const tokenAccount = await getOrCreateAssociatedTokenAccount(
    connection, wallet, clinkMint, wallet.publicKey
  );
  console.log(`Token account: ${tokenAccount.address.toBase58()}`);

  // Mint 1M CLINK for testing
  const amount = 1_000_000_000_000_000; // 1M CLINK (9 decimals)
  await mintTo(connection, wallet, clinkMint, tokenAccount.address, wallet, amount);
  console.log(`✅ Minted 1,000,000 CLINK to deployer`);

  console.log(`\n=== Save this ===`);
  console.log(`CLINK_DEVNET_MINT=${clinkMint.toBase58()}`);
  console.log(`\nUpdate scripts/init-payments.ts with this mint address.`);
}

main().catch(console.error);
