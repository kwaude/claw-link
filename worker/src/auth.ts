// Simple auth: verify Ed25519 signature of (timestamp + address)
// Headers: X-Address, X-Timestamp, X-Signature (base64)

// For now, we use a simplified auth that just checks timestamp freshness
// Full Ed25519 verification would require importing a crypto library
// The signature can be verified by anyone using the agent's public key

const MAX_AGE_SECONDS = 300; // 5 minutes

export interface AuthResult {
  ok: boolean;
  address?: string;
  error?: string;
}

export function verifyAuth(request: Request): AuthResult {
  const address = request.headers.get('X-Address');
  const timestamp = request.headers.get('X-Timestamp');
  const signature = request.headers.get('X-Signature');

  if (!address || !timestamp) {
    return { ok: false, error: 'Missing X-Address or X-Timestamp headers' };
  }

  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);

  if (isNaN(ts) || Math.abs(now - ts) > MAX_AGE_SECONDS) {
    return { ok: false, error: 'Timestamp expired or invalid' };
  }

  // For MVP: if signature header is present, we trust it
  // Full verification would check Ed25519 sig of `${timestamp}${address}`
  // against the agent's on-chain public key
  if (!signature) {
    return { ok: false, error: 'Missing X-Signature header' };
  }

  return { ok: true, address };
}

// For human-initiated actions (browser chat), we use a simpler approach:
// No auth required to SEND messages (anyone can send to an agent)
// Auth required to READ inbox (only the address owner)
