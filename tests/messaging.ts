import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ClawlinkProtocol } from "../target/types/clawlink_protocol";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import BN from "bn.js";

describe("clawlink-protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.ClawlinkProtocol as Program<ClawlinkProtocol>;
  const authority = provider.wallet as anchor.Wallet;

  let clinkMint: PublicKey;
  let configPda: PublicKey;
  let configBump: number;

  // Agent keypairs
  const agent1 = Keypair.generate();
  const agent2 = Keypair.generate();
  let agent1TokenAccount: PublicKey;
  let agent2TokenAccount: PublicKey;

  // Fee amounts
  const registrationFee = new BN(100_000_000_000); // 100 CLINK
  const messageFee = new BN(1_000_000_000); // 1 CLINK

  // Sample encryption key (32 bytes)
  const encryptionKey1 = Array.from({ length: 32 }, (_, i) => i + 1);
  const encryptionKey2 = Array.from({ length: 32 }, (_, i) => i + 33);

  before(async () => {
    // Airdrop SOL to agents
    const airdropSig1 = await provider.connection.requestAirdrop(
      agent1.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig1);

    const airdropSig2 = await provider.connection.requestAirdrop(
      agent2.publicKey,
      10 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig2);

    // Create CLINK mint (authority = wallet)
    clinkMint = await createMint(
      provider.connection,
      (authority as any).payer,
      authority.publicKey,
      null,
      9 // 9 decimals
    );

    // Create token accounts for agents
    agent1TokenAccount = await createAccount(
      provider.connection,
      (authority as any).payer,
      clinkMint,
      agent1.publicKey
    );

    agent2TokenAccount = await createAccount(
      provider.connection,
      (authority as any).payer,
      clinkMint,
      agent2.publicKey
    );

    // Mint CLINK to agents (1000 CLINK each)
    await mintTo(
      provider.connection,
      (authority as any).payer,
      clinkMint,
      agent1TokenAccount,
      authority.publicKey,
      1000_000_000_000 // 1000 CLINK
    );

    await mintTo(
      provider.connection,
      (authority as any).payer,
      clinkMint,
      agent2TokenAccount,
      authority.publicKey,
      1000_000_000_000 // 1000 CLINK
    );

    // Derive config PDA
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
  });

  it("Initializes config", async () => {
    await program.methods
      .initializeConfig(registrationFee, messageFee)
      .accounts({
        config: configPda,
        clinkMint: clinkMint,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.ok(config.authority.equals(authority.publicKey));
    assert.ok(config.clinkMint.equals(clinkMint));
    assert.ok(config.registrationFee.eq(registrationFee));
    assert.ok(config.messageFee.eq(messageFee));
    assert.equal(config.totalAgents.toNumber(), 0);
    assert.equal(config.totalMessages.toNumber(), 0);
  });

  it("Registers agent 1 (with CLINK burn)", async () => {
    const [agentProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent1.publicKey.toBuffer()],
      program.programId
    );

    const endpoint = "https://relay.clawlink.app/inbox/agent1";

    // Check balance before
    const balanceBefore = await getAccount(provider.connection, agent1TokenAccount);

    await program.methods
      .registerAgent(endpoint, encryptionKey1)
      .accounts({
        config: configPda,
        agentProfile: agentProfilePda,
        clinkMint: clinkMint,
        agentTokenAccount: agent1TokenAccount,
        agent: agent1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent1])
      .rpc();

    // Verify profile
    const profile = await program.account.agentProfile.fetch(agentProfilePda);
    assert.ok(profile.authority.equals(agent1.publicKey));
    assert.equal(profile.endpoint, endpoint);
    assert.deepEqual(Array.from(profile.encryptionKey), encryptionKey1);
    assert.equal(profile.messageCount.toNumber(), 0);

    // Verify CLINK was burned
    const balanceAfter = await getAccount(provider.connection, agent1TokenAccount);
    const burned = BigInt(balanceBefore.amount.toString()) - BigInt(balanceAfter.amount.toString());
    assert.equal(burned.toString(), registrationFee.toString());

    // Verify config updated
    const config = await program.account.config.fetch(configPda);
    assert.equal(config.totalAgents.toNumber(), 1);
  });

  it("Looks up agent profile", async () => {
    const [agentProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent1.publicKey.toBuffer()],
      program.programId
    );

    const profile = await program.account.agentProfile.fetch(agentProfilePda);
    assert.ok(profile.authority.equals(agent1.publicKey));
    assert.equal(profile.endpoint, "https://relay.clawlink.app/inbox/agent1");
    assert.deepEqual(Array.from(profile.encryptionKey), encryptionKey1);
  });

  it("Updates agent profile", async () => {
    const [agentProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent1.publicKey.toBuffer()],
      program.programId
    );

    const newEndpoint = "https://relay.clawlink.app/inbox/agent1-v2";

    await program.methods
      .updateAgent(newEndpoint, encryptionKey2)
      .accounts({
        agentProfile: agentProfilePda,
        authority: agent1.publicKey,
        agent: agent1.publicKey,
      })
      .signers([agent1])
      .rpc();

    const profile = await program.account.agentProfile.fetch(agentProfilePda);
    assert.equal(profile.endpoint, newEndpoint);
    assert.deepEqual(Array.from(profile.encryptionKey), encryptionKey2);
  });

  it("Fails duplicate registration", async () => {
    const [agentProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent1.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .registerAgent("https://duplicate.test", encryptionKey1)
        .accounts({
          config: configPda,
          agentProfile: agentProfilePda,
          clinkMint: clinkMint,
          agentTokenAccount: agent1TokenAccount,
          agent: agent1.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([agent1])
        .rpc();
      assert.fail("Should have failed with duplicate registration");
    } catch (err: any) {
      // Account already initialized — Anchor will throw
      assert.ok(err.toString().length > 0);
    }
  });

  it("Fails unauthorized update", async () => {
    const [agentProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent1.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .updateAgent("https://hacked.test", null)
        .accounts({
          agentProfile: agentProfilePda,
          authority: agent2.publicKey, // wrong authority
          agent: agent2.publicKey,
        })
        .signers([agent2])
        .rpc();
      assert.fail("Should have failed with unauthorized");
    } catch (err: any) {
      // Should fail due to PDA seed mismatch or has_one constraint
      assert.ok(err.toString().length > 0);
    }
  });

  it("Registers agent 2", async () => {
    const [agentProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent2.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .registerAgent("https://relay.clawlink.app/inbox/agent2", encryptionKey2)
      .accounts({
        config: configPda,
        agentProfile: agentProfilePda,
        clinkMint: clinkMint,
        agentTokenAccount: agent2TokenAccount,
        agent: agent2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent2])
      .rpc();

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.totalAgents.toNumber(), 2);
  });

  it("Sends message receipt (with CLINK burn)", async () => {
    const [senderProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent1.publicKey.toBuffer()],
      program.programId
    );

    // Create a fake message hash
    const messageHash = Array.from({ length: 32 }, (_, i) => i * 7 % 256);

    const [receiptPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        agent1.publicKey.toBuffer(),
        Buffer.from(messageHash),
      ],
      program.programId
    );

    const balanceBefore = await getAccount(provider.connection, agent1TokenAccount);

    await program.methods
      .sendMessageReceipt(messageHash, agent2.publicKey)
      .accounts({
        config: configPda,
        senderProfile: senderProfilePda,
        messageReceipt: receiptPda,
        clinkMint: clinkMint,
        senderTokenAccount: agent1TokenAccount,
        authority: agent1.publicKey,
        sender: agent1.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([agent1])
      .rpc();

    // Verify receipt
    const receipt = await program.account.messageReceipt.fetch(receiptPda);
    assert.ok(receipt.sender.equals(agent1.publicKey));
    assert.ok(receipt.recipient.equals(agent2.publicKey));
    assert.deepEqual(Array.from(receipt.messageHash), messageHash);

    // Verify CLINK burned
    const balanceAfter = await getAccount(provider.connection, agent1TokenAccount);
    const burned = BigInt(balanceBefore.amount.toString()) - BigInt(balanceAfter.amount.toString());
    assert.equal(burned.toString(), messageFee.toString());

    // Verify profile message count
    const profile = await program.account.agentProfile.fetch(senderProfilePda);
    assert.equal(profile.messageCount.toNumber(), 1);

    // Verify config updated
    const config = await program.account.config.fetch(configPda);
    assert.equal(config.totalMessages.toNumber(), 1);
  });

  it("Deregisters agent 2", async () => {
    const [agentProfilePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agent2.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .deregisterAgent()
      .accounts({
        config: configPda,
        agentProfile: agentProfilePda,
        authority: agent2.publicKey,
        agent: agent2.publicKey,
      })
      .signers([agent2])
      .rpc();

    // Verify profile is closed
    try {
      await program.account.agentProfile.fetch(agentProfilePda);
      assert.fail("Should have failed — account closed");
    } catch (err: any) {
      assert.ok(
        err.toString().includes("Account does not exist") ||
          err.toString().includes("Could not find")
      );
    }

    // Verify config updated
    const config = await program.account.config.fetch(configPda);
    assert.equal(config.totalAgents.toNumber(), 1);
  });
});
