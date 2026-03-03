import { createPublicKey, verify as verifySignature } from "node:crypto";
import type { IncomingMessage } from "node:http";

type JWKSResponse = {
  keys?: Array<{
    kty?: string;
    kid?: string;
    use?: string;
    alg?: string;
    n?: string;
    e?: string;
  }>;
};

type JwtHeader = {
  alg?: string;
  kid?: string;
  typ?: string;
};

type JwtClaims = {
  sub?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nbf?: number;
  [key: string]: unknown;
};

export type WorkflowAuthContext = {
  subject: string;
  claims: JwtClaims;
};

export class WorkflowAuthError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

let jwksCache:
  | {
      url: string;
      expiresAt: number;
      keys: NonNullable<JWKSResponse["keys"]>;
    }
  | null = null;

export async function authorizeWorkflowRequest(req: IncomingMessage): Promise<WorkflowAuthContext> {
  const mode = (process.env.ANORHA_WORKFLOW_AUTH_MODE || "clerk").trim().toLowerCase();
  if (mode === "off" || mode === "none" || mode === "disabled") {
    return { subject: "dev-anonymous", claims: { sub: "dev-anonymous" } };
  }

  const authz = String(req.headers.authorization || "").trim();
  const bearerMatch = /^bearer\s+(.+)$/i.exec(authz);
  if (!bearerMatch) {
    throw new WorkflowAuthError(401, "Missing Bearer token");
  }
  const token = bearerMatch[1].trim();
  if (!token) {
    throw new WorkflowAuthError(401, "Bearer token is empty");
  }

  const { header, claims, signingInput, signature } = parseJwt(token);
  if ((header.alg || "").toUpperCase() !== "RS256") {
    throw new WorkflowAuthError(401, `Unsupported JWT alg '${header.alg || "unknown"}'`);
  }
  if (!header.kid) {
    throw new WorkflowAuthError(401, "JWT header missing kid");
  }

  validateRegisteredClaims(claims);
  const key = await getJwkByKid(header.kid);
  const publicKey = createPublicKey({
    key: {
      kty: "RSA",
      n: key.n || "",
      e: key.e || "",
    },
    format: "jwk",
  });

  const ok = verifySignature("RSA-SHA256", Buffer.from(signingInput, "utf8"), publicKey, signature);
  if (!ok) {
    throw new WorkflowAuthError(401, "JWT signature verification failed");
  }

  const subject = String(claims.sub || "").trim();
  if (!subject) {
    throw new WorkflowAuthError(401, "JWT missing subject claim");
  }
  return { subject, claims };
}

function parseJwt(token: string): {
  header: JwtHeader;
  claims: JwtClaims;
  signingInput: string;
  signature: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new WorkflowAuthError(401, "Invalid JWT format");
  }
  const [head, payload, sig] = parts;
  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = JSON.parse(base64UrlDecodeToString(head));
    claims = JSON.parse(base64UrlDecodeToString(payload));
  } catch {
    throw new WorkflowAuthError(401, "JWT decode failed");
  }
  return {
    header,
    claims,
    signingInput: `${head}.${payload}`,
    signature: base64UrlDecode(sig),
  };
}

function validateRegisteredClaims(claims: JwtClaims): void {
  const now = Math.floor(Date.now() / 1000);
  const skew = 30;
  if (typeof claims.exp === "number" && now > claims.exp+skew) {
    throw new WorkflowAuthError(401, "JWT expired");
  }
  if (typeof claims.nbf === "number" && now+skew < claims.nbf) {
    throw new WorkflowAuthError(401, "JWT not yet valid");
  }
  if (typeof claims.iat === "number" && claims.iat > now+skew) {
    throw new WorkflowAuthError(401, "JWT issued-at is in the future");
  }

  const issuer = (process.env.ANORHA_CLERK_ISSUER || "").trim();
  if (issuer) {
    if ((claims.iss || "").trim() !== issuer) {
      throw new WorkflowAuthError(401, "JWT issuer mismatch");
    }
  }

  const audience = (process.env.ANORHA_CLERK_AUDIENCE || "").trim();
  if (audience) {
    const claimAud = claims.aud;
    if (Array.isArray(claimAud)) {
      if (!claimAud.includes(audience)) {
        throw new WorkflowAuthError(401, "JWT audience mismatch");
      }
    } else if ((claimAud || "").trim() !== audience) {
      throw new WorkflowAuthError(401, "JWT audience mismatch");
    }
  }
}

async function getJwkByKid(kid: string): Promise<NonNullable<JWKSResponse["keys"]>[number]> {
  const url = resolveJwksURL();
  const now = Date.now();
  if (jwksCache && jwksCache.url === url && now < jwksCache.expiresAt) {
    const cached = jwksCache.keys.find((k) => k.kid === kid);
    if (cached) return cached;
  }

  const response = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new WorkflowAuthError(401, `Failed to fetch JWKS: ${response.status}`);
  }
  const data = (await response.json()) as JWKSResponse;
  const keys = Array.isArray(data.keys) ? data.keys : [];
  if (!keys.length) {
    throw new WorkflowAuthError(401, "JWKS returned no keys");
  }
  jwksCache = {
    url,
    keys,
    expiresAt: now + 10 * 60 * 1000,
  };
  const key = keys.find((k) => k.kid === kid);
  if (!key || !key.n || !key.e) {
    throw new WorkflowAuthError(401, "JWT key id not found in JWKS");
  }
  return key;
}

function resolveJwksURL(): string {
  const explicit = (process.env.ANORHA_CLERK_JWKS_URL || "").trim();
  if (explicit) return explicit;
  const issuer = (process.env.ANORHA_CLERK_ISSUER || "").trim();
  if (issuer) {
    return `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`;
  }
  throw new WorkflowAuthError(500, "Clerk auth is enabled but ANORHA_CLERK_ISSUER/JWKS_URL is not configured");
}

function base64UrlDecodeToString(input: string): string {
  return base64UrlDecode(input).toString("utf8");
}

function base64UrlDecode(input: string): Buffer {
  let normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  while (normalized.length % 4 !== 0) normalized += "=";
  return Buffer.from(normalized, "base64");
}

