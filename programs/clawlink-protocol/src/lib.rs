use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, Burn};

declare_id!("PpQRJsqoLvrMspfw4zmnNQ4DbEnR4M47Ktw8jkYcCRM");

// ─── Constants ──────────────────────────────────────────────────────

/// Maximum endpoint URL length
pub const MAX_ENDPOINT_LEN: usize = 256;

/// Default registration fee: 100 CLINK (9 decimals)
pub const DEFAULT_REGISTRATION_FEE: u64 = 100_000_000_000; // 100 * 10^9

/// Default message receipt fee: 1 CLINK (9 decimals)
pub const DEFAULT_MESSAGE_FEE: u64 = 1_000_000_000; // 1 * 10^9

// ─── Program ────────────────────────────────────────────────────────

#[program]
pub mod clawlink_protocol {
    use super::*;

    /// One-time setup: initialize the protocol config PDA.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        registration_fee: u64,
        message_fee: u64,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.clink_mint = ctx.accounts.clink_mint.key();
        config.registration_fee = registration_fee;
        config.message_fee = message_fee;
        config.total_agents = 0;
        config.total_messages = 0;
        config.bump = ctx.bumps.config;

        msg!("ClawLink config initialized. Authority: {}", config.authority);
        Ok(())
    }

    /// Register an agent: store endpoint + X25519 encryption pubkey.
    /// Burns CLINK as a registration fee.
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        endpoint: String,
        encryption_key: [u8; 32],
    ) -> Result<()> {
        require!(
            endpoint.len() <= MAX_ENDPOINT_LEN,
            ClawLinkError::EndpointTooLong
        );
        require!(
            endpoint.len() > 0,
            ClawLinkError::EndpointEmpty
        );

        // Burn CLINK registration fee
        let config = &ctx.accounts.config;
        let burn_amount = config.registration_fee;

        if burn_amount > 0 {
            let cpi_accounts = Burn {
                mint: ctx.accounts.clink_mint.to_account_info(),
                from: ctx.accounts.agent_token_account.to_account_info(),
                authority: ctx.accounts.agent.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            token::burn(cpi_ctx, burn_amount)?;
        }

        // Initialize agent profile
        let profile = &mut ctx.accounts.agent_profile;
        profile.authority = ctx.accounts.agent.key();
        profile.endpoint = endpoint;
        profile.encryption_key = encryption_key;
        profile.registered_at = Clock::get()?.unix_timestamp;
        profile.message_count = 0;
        profile.bump = ctx.bumps.agent_profile;

        // Update global stats
        let config = &mut ctx.accounts.config;
        config.total_agents = config.total_agents.checked_add(1).unwrap();

        msg!("Agent registered: {}", profile.authority);
        Ok(())
    }

    /// Update an agent's endpoint and/or encryption key.
    pub fn update_agent(
        ctx: Context<UpdateAgent>,
        endpoint: Option<String>,
        encryption_key: Option<[u8; 32]>,
    ) -> Result<()> {
        let profile = &mut ctx.accounts.agent_profile;

        if let Some(ep) = endpoint {
            require!(ep.len() <= MAX_ENDPOINT_LEN, ClawLinkError::EndpointTooLong);
            require!(ep.len() > 0, ClawLinkError::EndpointEmpty);
            profile.endpoint = ep;
        }

        if let Some(key) = encryption_key {
            profile.encryption_key = key;
        }

        msg!("Agent updated: {}", profile.authority);
        Ok(())
    }

    /// Deregister an agent: close the profile PDA and reclaim rent.
    pub fn deregister_agent(ctx: Context<DeregisterAgent>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.total_agents = config.total_agents.checked_sub(1).unwrap();

        msg!("Agent deregistered: {}", ctx.accounts.agent.key());
        Ok(())
    }

    /// Store a message receipt on-chain (hash of message as proof-of-delivery).
    /// Burns a small CLINK fee.
    pub fn send_message_receipt(
        ctx: Context<SendMessageReceipt>,
        message_hash: [u8; 32],
        recipient: Pubkey,
    ) -> Result<()> {
        // Burn CLINK message fee
        let config = &ctx.accounts.config;
        let burn_amount = config.message_fee;

        if burn_amount > 0 {
            let cpi_accounts = Burn {
                mint: ctx.accounts.clink_mint.to_account_info(),
                from: ctx.accounts.sender_token_account.to_account_info(),
                authority: ctx.accounts.sender.to_account_info(),
            };
            let cpi_program = ctx.accounts.token_program.to_account_info();
            let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
            token::burn(cpi_ctx, burn_amount)?;
        }

        // Initialize message receipt
        let receipt = &mut ctx.accounts.message_receipt;
        receipt.sender = ctx.accounts.sender.key();
        receipt.recipient = recipient;
        receipt.message_hash = message_hash;
        receipt.timestamp = Clock::get()?.unix_timestamp;
        receipt.bump = ctx.bumps.message_receipt;

        // Update sender's profile message count
        let sender_profile = &mut ctx.accounts.sender_profile;
        sender_profile.message_count = sender_profile.message_count.checked_add(1).unwrap();

        // Update global stats
        let config = &mut ctx.accounts.config;
        config.total_messages = config.total_messages.checked_add(1).unwrap();

        msg!(
            "Message receipt stored. Sender: {}, Recipient: {}",
            receipt.sender,
            receipt.recipient
        );
        Ok(())
    }
}

// ─── Account Structures ─────────────────────────────────────────────

#[account]
pub struct Config {
    /// Protocol authority (admin)
    pub authority: Pubkey,
    /// CLINK token mint address
    pub clink_mint: Pubkey,
    /// Registration fee in CLINK base units
    pub registration_fee: u64,
    /// Message receipt fee in CLINK base units
    pub message_fee: u64,
    /// Total registered agents
    pub total_agents: u64,
    /// Total on-chain message receipts
    pub total_messages: u64,
    /// PDA bump
    pub bump: u8,
}

impl Config {
    pub const LEN: usize = 8  // discriminator
        + 32  // authority
        + 32  // clink_mint
        + 8   // registration_fee
        + 8   // message_fee
        + 8   // total_agents
        + 8   // total_messages
        + 1;  // bump
}

#[account]
pub struct AgentProfile {
    /// The agent's wallet (authority)
    pub authority: Pubkey,
    /// Messaging endpoint URL
    pub endpoint: String,
    /// X25519 public key for message encryption
    pub encryption_key: [u8; 32],
    /// Unix timestamp of registration
    pub registered_at: i64,
    /// Number of messages sent (on-chain receipts)
    pub message_count: u64,
    /// PDA bump
    pub bump: u8,
}

impl AgentProfile {
    pub const LEN: usize = 8   // discriminator
        + 32   // authority
        + 4 + MAX_ENDPOINT_LEN  // endpoint (string prefix + data)
        + 32   // encryption_key
        + 8    // registered_at
        + 8    // message_count
        + 1;   // bump
}

#[account]
pub struct MessageReceipt {
    /// Sender's pubkey
    pub sender: Pubkey,
    /// Recipient's pubkey
    pub recipient: Pubkey,
    /// SHA256 hash of the encrypted message
    pub message_hash: [u8; 32],
    /// Unix timestamp
    pub timestamp: i64,
    /// PDA bump
    pub bump: u8,
}

impl MessageReceipt {
    pub const LEN: usize = 8   // discriminator
        + 32   // sender
        + 32   // recipient
        + 32   // message_hash
        + 8    // timestamp
        + 1;   // bump
}

// ─── Instruction Contexts ───────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = Config::LEN,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, Config>,

    /// The CLINK token mint
    pub clink_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = agent,
        space = AgentProfile::LEN,
        seeds = [b"agent", agent.key().as_ref()],
        bump,
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// CLINK mint — must match config
    #[account(
        mut,
        constraint = clink_mint.key() == config.clink_mint @ ClawLinkError::InvalidMint,
    )]
    pub clink_mint: Account<'info, Mint>,

    /// Agent's CLINK token account (for burning fees)
    #[account(
        mut,
        constraint = agent_token_account.mint == config.clink_mint @ ClawLinkError::InvalidMint,
        constraint = agent_token_account.owner == agent.key() @ ClawLinkError::InvalidTokenOwner,
    )]
    pub agent_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub agent: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.key().as_ref()],
        bump = agent_profile.bump,
        has_one = authority @ ClawLinkError::Unauthorized,
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// Must match the profile's authority
    /// CHECK: validated by has_one
    pub authority: Signer<'info>,

    /// The agent wallet (same as authority for self-updates)
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
pub struct DeregisterAgent<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [b"agent", agent.key().as_ref()],
        bump = agent_profile.bump,
        has_one = authority @ ClawLinkError::Unauthorized,
        close = agent,
    )]
    pub agent_profile: Account<'info, AgentProfile>,

    /// Must match the profile's authority
    /// CHECK: validated by has_one
    pub authority: Signer<'info>,

    #[account(mut)]
    pub agent: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(message_hash: [u8; 32])]
pub struct SendMessageReceipt<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    /// Sender's agent profile (must exist)
    #[account(
        mut,
        seeds = [b"agent", sender.key().as_ref()],
        bump = sender_profile.bump,
        has_one = authority @ ClawLinkError::Unauthorized,
    )]
    pub sender_profile: Account<'info, AgentProfile>,

    #[account(
        init,
        payer = sender,
        space = MessageReceipt::LEN,
        seeds = [b"receipt", sender.key().as_ref(), &message_hash],
        bump,
    )]
    pub message_receipt: Account<'info, MessageReceipt>,

    /// CLINK mint — must match config
    #[account(
        mut,
        constraint = clink_mint.key() == config.clink_mint @ ClawLinkError::InvalidMint,
    )]
    pub clink_mint: Account<'info, Mint>,

    /// Sender's CLINK token account
    #[account(
        mut,
        constraint = sender_token_account.mint == config.clink_mint @ ClawLinkError::InvalidMint,
        constraint = sender_token_account.owner == sender.key() @ ClawLinkError::InvalidTokenOwner,
    )]
    pub sender_token_account: Account<'info, TokenAccount>,

    /// CHECK: validated by has_one on sender_profile
    pub authority: Signer<'info>,

    #[account(mut)]
    pub sender: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

// ─── Errors ─────────────────────────────────────────────────────────

#[error_code]
pub enum ClawLinkError {
    #[msg("Endpoint URL exceeds maximum length of 256 characters")]
    EndpointTooLong,

    #[msg("Endpoint URL cannot be empty")]
    EndpointEmpty,

    #[msg("Invalid CLINK mint address")]
    InvalidMint,

    #[msg("Invalid token account owner")]
    InvalidTokenOwner,

    #[msg("Unauthorized: signer does not match profile authority")]
    Unauthorized,
}
