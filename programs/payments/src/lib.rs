use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Transfer as TokenTransfer, MintTo};

declare_id!("DpVYsUBZ9f8Lny2xvPUK6E8RWxBA7pBh2XRLHWUu9jHP");

/// ══════════════════════════════════════════════════════════════════════
/// Claw Cash Protocol v2 — Tornado Cash-style Private Payment Mixer
/// ══════════════════════════════════════════════════════════════════════
///
/// Architecture:
///   - Fixed denomination pools (0.1, 1, 10 SOL) for anonymity
///   - Incremental Merkle tree of commitments per pool
///   - Nullifier tracking to prevent double-spend
///   - CLAWCASH token fee gating on deposits
///   - Simplified commitment/reveal (devnet) — swappable for ZK proofs
///
/// Privacy Model (devnet — simplified):
///   commitment = SHA256(secret || nullifier_preimage)
///   nullifier  = SHA256(nullifier_preimage)
///   Depositor stores {secret, nullifier_preimage} off-chain as a "note"
///   Withdrawer submits secret + nullifier_preimage, program verifies
///
/// ⚠️  PRODUCTION: Replace simplified verify with ZK proof verification.
///     The program is designed with a clear boundary where groth16/ZERA
///     proof verification would replace the hash-based scheme.
/// ══════════════════════════════════════════════════════════════════════

// ─── Constants ──────────────────────────────────────────────────────

/// Merkle tree depth: 20 levels → supports 2^20 = 1,048,576 deposits
pub const MERKLE_TREE_DEPTH: usize = 20;

/// Maximum leaves in the Merkle tree
pub const MAX_LEAVES: u32 = 1 << MERKLE_TREE_DEPTH; // 1,048,576

/// Pool denominations in lamports
pub const POOL_DENOMINATIONS: [u64; 3] = [
    100_000_000,      // Pool 0: 0.1 SOL
    1_000_000_000,    // Pool 1: 1 SOL
    10_000_000_000,   // Pool 2: 10 SOL
];

/// Default CLAWCASH fee per deposit (in token base units, 6 decimals)
pub const DEFAULT_FEE: u64 = 100_000_000; // 100 CLAWCASH (6 decimals)

/// Zero value for empty Merkle tree leaves
pub const ZERO_VALUE: [u8; 32] = [0u8; 32];

/// Amount of CLAWCASH dispensed by the devnet faucet (1,000 tokens, 6 decimals)
pub const FAUCET_AMOUNT: u64 = 1_000_000_000;

// ─── Helpers ────────────────────────────────────────────────────────

/// Hash two 32-byte nodes together for the Merkle tree.
fn hash_pair(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(left);
    data[32..].copy_from_slice(right);
    anchor_lang::solana_program::hash::hash(&data).to_bytes()
}

/// Compute commitment = SHA256(secret || nullifier_preimage)
///
/// ⚠️  PRODUCTION ZK: Replace with Poseidon hash inside a circuit.
fn compute_commitment(secret: &[u8; 32], nullifier_preimage: &[u8; 32]) -> [u8; 32] {
    let mut data = [0u8; 64];
    data[..32].copy_from_slice(secret);
    data[32..].copy_from_slice(nullifier_preimage);
    anchor_lang::solana_program::hash::hash(&data).to_bytes()
}

/// Compute nullifier = SHA256(nullifier_preimage)
///
/// ⚠️  PRODUCTION ZK: The nullifier would be derived inside the ZK circuit.
fn compute_nullifier(nullifier_preimage: &[u8; 32]) -> [u8; 32] {
    anchor_lang::solana_program::hash::hash(nullifier_preimage).to_bytes()
}

/// Precompute zero hashes for each level of the Merkle tree.
fn zero_hashes() -> [[u8; 32]; MERKLE_TREE_DEPTH] {
    let mut zh = [[0u8; 32]; MERKLE_TREE_DEPTH];
    zh[0] = hash_pair(&ZERO_VALUE, &ZERO_VALUE);
    for i in 1..MERKLE_TREE_DEPTH {
        zh[i] = hash_pair(&zh[i - 1], &zh[i - 1]);
    }
    zh
}

// ─── Program ────────────────────────────────────────────────────────

#[program]
pub mod claw_cash_protocol {
    use super::*;

    /// Initialize the protocol configuration.
    pub fn initialize(
        ctx: Context<Initialize>,
        fee_amount: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.clawcash_mint = ctx.accounts.clawcash_mint.key();
        config.fee_amount = fee_amount;
        config.treasury = ctx.accounts.treasury.key();
        config.bump = ctx.bumps.config;
        config.treasury_bump = ctx.bumps.treasury;
        msg!("Claw Cash Protocol v2 initialized. Fee: {} CLAWCASH", fee_amount);
        Ok(())
    }

    /// Initialize a denomination pool (0, 1, or 2).
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        pool_id: u8,
    ) -> Result<()> {
        require!(pool_id < 3, ClawCashError::InvalidPool);

        let pool = &mut ctx.accounts.pool;
        pool.pool_id = pool_id;
        pool.denomination = POOL_DENOMINATIONS[pool_id as usize];
        pool.next_index = 0;
        pool.bump = ctx.bumps.pool;
        pool.vault_bump = ctx.bumps.vault;

        // Initialize the filled_subtrees with zero hashes
        let zh = zero_hashes();
        pool.current_root = zh[MERKLE_TREE_DEPTH - 1];
        pool.filled_subtrees = vec![ZERO_VALUE; MERKLE_TREE_DEPTH];
        for i in 1..MERKLE_TREE_DEPTH {
            pool.filled_subtrees[i] = zh[i - 1];
        }

        msg!("Pool {} initialized: {} lamports denomination", pool_id, pool.denomination);
        Ok(())
    }

    /// Deposit SOL into a pool.
    /// Requires CLAWCASH token fee and adds commitment to Merkle tree.
    pub fn deposit(
        ctx: Context<DepositCtx>,
        commitment: [u8; 32],
        pool_id: u8,
        leaf_index: u32,
    ) -> Result<()> {
        require!(pool_id < 3, ClawCashError::InvalidPool);

        let pool = &mut ctx.accounts.pool;
        let denomination = pool.denomination;

        require!(pool.pool_id == pool_id, ClawCashError::InvalidPool);
        require!(pool.next_index < MAX_LEAVES, ClawCashError::MerkleTreeFull);
        require!(leaf_index == pool.next_index, ClawCashError::InvalidProof);

        // 1. Transfer CLAWCASH fee to treasury
        let fee = ctx.accounts.config.fee_amount;
        if fee > 0 {
            let cpi_accounts = TokenTransfer {
                from: ctx.accounts.depositor_clawcash.to_account_info(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.depositor.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            token::transfer(cpi_ctx, fee)?;
            msg!("CLAWCASH fee of {} collected", fee);
        }

        // 2. Transfer SOL denomination to vault PDA
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.depositor.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, denomination)?;

        // 3. Insert commitment into incremental Merkle tree
        let current_leaf_index = pool.next_index;
        let mut current_hash = commitment;
        let mut current_index = current_leaf_index;
        let zh = zero_hashes();

        for i in 0..MERKLE_TREE_DEPTH {
            if current_index % 2 == 0 {
                pool.filled_subtrees[i] = current_hash;
                let zero_at_level = if i == 0 { ZERO_VALUE } else { zh[i - 1] };
                current_hash = hash_pair(&current_hash, &zero_at_level);
            } else {
                current_hash = hash_pair(&pool.filled_subtrees[i], &current_hash);
            }
            current_index /= 2;
        }

        pool.current_root = current_hash;
        pool.next_index = current_leaf_index + 1;

        // 4. Store commitment in leaf account
        let leaf = &mut ctx.accounts.commitment_leaf;
        leaf.commitment = commitment;
        leaf.leaf_index = current_leaf_index;
        leaf.pool_id = pool_id;
        leaf.bump = ctx.bumps.commitment_leaf;

        msg!(
            "Deposited {} lamports into pool {}. Leaf index: {}",
            denomination, pool_id, current_leaf_index
        );

        Ok(())
    }

    /// Withdraw SOL from a pool by revealing secret + nullifier_preimage.
    ///
    /// ⚠️  PRODUCTION ZK: Replace hash verification with groth16 proof:
    ///     - Public inputs: root, nullifier, recipient, fee
    ///     - Private inputs: secret, nullifier_preimage, Merkle path
    ///     - ZK proves knowledge of a valid leaf without revealing which one
    pub fn withdraw(
        ctx: Context<WithdrawCtx>,
        secret: [u8; 32],
        nullifier_preimage: [u8; 32],
        nullifier_hash: [u8; 32],
        leaf_index: u32,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        let pool = &ctx.accounts.pool;

        // 1. Verify nullifier_hash matches nullifier_preimage
        let computed_nullifier = compute_nullifier(&nullifier_preimage);
        require!(computed_nullifier == nullifier_hash, ClawCashError::InvalidProof);

        // 2. Compute and verify commitment
        let commitment = compute_commitment(&secret, &nullifier_preimage);

        // Verify Merkle proof
        require!(proof.len() == MERKLE_TREE_DEPTH, ClawCashError::InvalidProof);
        let mut current_hash = commitment;
        let mut index = leaf_index;
        for i in 0..MERKLE_TREE_DEPTH {
            if index % 2 == 0 {
                current_hash = hash_pair(&current_hash, &proof[i]);
            } else {
                current_hash = hash_pair(&proof[i], &current_hash);
            }
            index /= 2;
        }
        require!(current_hash == pool.current_root, ClawCashError::InvalidProof);

        // 3. Record nullifier (account init prevents double-spend)
        let nullifier_account = &mut ctx.accounts.nullifier_account;
        nullifier_account.nullifier = nullifier_hash;
        nullifier_account.pool_id = pool.pool_id;
        nullifier_account.bump = ctx.bumps.nullifier_account;

        // 3. Transfer SOL from vault to recipient via CPI with PDA signing
        let denomination = pool.denomination;
        let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
        require!(vault_lamports >= denomination, ClawCashError::InsufficientVaultBalance);

        let pool_id_bytes = pool.pool_id.to_le_bytes();
        let vault_bump_bytes = [pool.vault_bump];
        let signer_seeds: &[&[u8]] = &[b"vault", &pool_id_bytes, &vault_bump_bytes];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                &[signer_seeds],
            ),
            denomination,
        )?;

        msg!(
            "Withdrawn {} lamports from pool {} to {}",
            denomination,
            pool.pool_id,
            ctx.accounts.recipient.key()
        );

        Ok(())
    }

    /// Update the CLAWCASH fee amount (authority only).
    pub fn update_fee(ctx: Context<UpdateConfig>, new_fee: u64) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.fee_amount = new_fee;
        msg!("Fee updated to {} CLAWCASH", new_fee);
        Ok(())
    }

    /// Devnet faucet: mint 1,000 CLAWCASH test tokens to any agent.
    /// The config PDA is the mint authority for the devnet CLAWCASH mint.
    /// Anyone can call this — it's devnet, tokens have no real value.
    pub fn claim_test_tokens(ctx: Context<ClaimTestTokens>) -> Result<()> {
        let config = &ctx.accounts.config;
        let bump = config.bump;
        let signer_seeds: &[&[u8]] = &[b"config", &[bump]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.clawcash_mint.to_account_info(),
                    to: ctx.accounts.recipient_token_account.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[signer_seeds],
            ),
            FAUCET_AMOUNT,
        )?;

        msg!("Dispensed {} CLAWCASH test tokens", FAUCET_AMOUNT);
        Ok(())
    }
}

// ─── Account Contexts ───────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub clawcash_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = clawcash_mint,
        token::authority = config,
        seeds = [b"treasury"],
        bump
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(pool_id: u8)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", pool_id.to_le_bytes().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,

    /// CHECK: PDA SOL vault, validated by seeds
    #[account(
        mut,
        seeds = [b"vault", pool_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        constraint = authority.key() == config.authority @ ClawCashError::Unauthorized
    )]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(commitment: [u8; 32], pool_id: u8, leaf_index: u32)]
pub struct DepositCtx<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [b"pool", pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    /// CHECK: PDA SOL vault, validated by seeds
    #[account(
        mut,
        seeds = [b"vault", pool_id.to_le_bytes().as_ref()],
        bump = pool.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// Commitment leaf stored on-chain for Merkle proof generation
    #[account(
        init,
        payer = depositor,
        space = 8 + CommitmentLeaf::INIT_SPACE,
        seeds = [b"leaf", pool_id.to_le_bytes().as_ref(), leaf_index.to_le_bytes().as_ref()],
        bump
    )]
    pub commitment_leaf: Account<'info, CommitmentLeaf>,

    /// Depositor's CLAWCASH token account (fee source)
    #[account(
        mut,
        constraint = depositor_clawcash.mint == config.clawcash_mint @ ClawCashError::InvalidMint,
        constraint = depositor_clawcash.owner == depositor.key() @ ClawCashError::InvalidOwner,
    )]
    pub depositor_clawcash: Account<'info, TokenAccount>,

    /// Treasury token account (fee destination)
    #[account(
        mut,
        seeds = [b"treasury"],
        bump = config.treasury_bump,
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(secret: [u8; 32], nullifier_preimage: [u8; 32], nullifier_hash: [u8; 32])]
pub struct WithdrawCtx<'info> {
    #[account(
        seeds = [b"pool", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,

    /// CHECK: PDA SOL vault, validated by seeds
    #[account(
        mut,
        seeds = [b"vault", pool.pool_id.to_le_bytes().as_ref()],
        bump = pool.vault_bump,
    )]
    pub vault: SystemAccount<'info>,

    /// Nullifier account — init ensures no double-spend.
    /// PDA seeded by the nullifier_hash (computed client-side, verified on-chain).
    /// If this account already exists, tx fails → prevents double-spend.
    #[account(
        init,
        payer = payer,
        space = 8 + NullifierAccount::INIT_SPACE,
        seeds = [b"nullifier", nullifier_hash.as_ref()],
        bump
    )]
    pub nullifier_account: Account<'info, NullifierAccount>,

    /// CHECK: Any account can receive SOL — intentional for privacy
    #[account(mut)]
    pub recipient: UncheckedAccount<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.authority == authority.key() @ ClawCashError::Unauthorized,
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimTestTokens<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    /// The devnet CLAWCASH mint (config PDA must be mint authority)
    #[account(
        mut,
        constraint = clawcash_mint.key() == config.clawcash_mint @ ClawCashError::InvalidMint,
    )]
    pub clawcash_mint: Account<'info, Mint>,

    /// Recipient's CLAWCASH token account
    #[account(
        mut,
        constraint = recipient_token_account.mint == config.clawcash_mint @ ClawCashError::InvalidMint,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

// ─── State Accounts ─────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    pub authority: Pubkey,        // 32
    pub clawcash_mint: Pubkey,    // 32
    pub fee_amount: u64,          // 8
    pub treasury: Pubkey,         // 32
    pub bump: u8,                 // 1
    pub treasury_bump: u8,        // 1
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub pool_id: u8,                              // 1
    pub denomination: u64,                         // 8
    pub next_index: u32,                           // 4
    pub bump: u8,                                  // 1
    pub vault_bump: u8,                            // 1
    pub current_root: [u8; 32],                    // 32
    #[max_len(20)]
    pub filled_subtrees: Vec<[u8; 32]>,            // 4 + 20*32 = 644
}

#[account]
#[derive(InitSpace)]
pub struct CommitmentLeaf {
    pub commitment: [u8; 32],    // 32
    pub leaf_index: u32,          // 4
    pub pool_id: u8,              // 1
    pub bump: u8,                 // 1
}

#[account]
#[derive(InitSpace)]
pub struct NullifierAccount {
    pub nullifier: [u8; 32],     // 32
    pub pool_id: u8,              // 1
    pub bump: u8,                 // 1
}

// ─── Errors ─────────────────────────────────────────────────────────

#[error_code]
pub enum ClawCashError {
    #[msg("Invalid pool ID (must be 0, 1, or 2)")]
    InvalidPool,
    #[msg("Merkle tree is full")]
    MerkleTreeFull,
    #[msg("Invalid Merkle proof")]
    InvalidProof,
    #[msg("Nullifier has already been used (double-spend attempt)")]
    NullifierAlreadyUsed,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance,
    #[msg("Invalid CLAWCASH mint")]
    InvalidMint,
    #[msg("Invalid token account owner")]
    InvalidOwner,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Arithmetic overflow")]
    Overflow,
}
