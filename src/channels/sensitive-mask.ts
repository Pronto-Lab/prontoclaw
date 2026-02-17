export interface SensitiveMaskOptions {
  maskEmails?: boolean;
  maskPhones?: boolean;
  maskTokens?: boolean;
  maskInternalUrls?: boolean;
}

const DEFAULT_OPTIONS: Required<SensitiveMaskOptions> = {
  maskEmails: true,
  maskPhones: true,
  maskTokens: true,
  maskInternalUrls: true,
};

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/giu;
const PHONE_CANDIDATE_PATTERN = /\+?[0-9][0-9().\-\s]{7,}[0-9]/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const BEARER_PATTERN = /\bBearer\s+([A-Za-z0-9._-]{12,})\b/gi;
const PREFIXED_TOKEN_PATTERN = /\b(?:sk|pk|rk|ghp|gho|ghu|xox[baprs]|pat)[-_][A-Za-z0-9_-]{8,}\b/g;
const URL_PATTERN = /https?:\/\/[^\s)\]}>,"']+/gi;

const REPLACEMENTS = {
  email: "[redacted-email]",
  phone: "[redacted-phone]",
  token: "[redacted-token]",
  internalUrl: "[redacted-internal-url]",
} as const;

function hasPrivateIpv4(hostname: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return true;
  }
  const match172 = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (match172) {
    const second = Number(match172[1]);
    return second >= 16 && second <= 31;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isInternalHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return true;
  }
  if (lower.endsWith(".internal") || lower.endsWith(".local")) {
    return true;
  }
  return hasPrivateIpv4(lower);
}

function maskInternalUrls(input: string): string {
  return input.replace(URL_PATTERN, (url) => {
    try {
      const parsed = new URL(url);
      return isInternalHost(parsed.hostname) ? REPLACEMENTS.internalUrl : url;
    } catch {
      return url;
    }
  });
}

function shouldPreserveEmailLikeId(domain: string): boolean {
  const lower = domain.toLowerCase();
  return lower === "g.us" || lower === "s.whatsapp.net";
}

function maskEmails(input: string): string {
  return input.replace(EMAIL_PATTERN, (candidate, domain) => {
    if (typeof domain === "string" && shouldPreserveEmailLikeId(domain)) {
      return candidate;
    }
    return REPLACEMENTS.email;
  });
}

function maskPhones(input: string): string {
  return input.replace(PHONE_CANDIDATE_PATTERN, (candidate) => {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 9) {
      return candidate;
    }
    return REPLACEMENTS.phone;
  });
}

function maskTokens(input: string): string {
  let output = input.replace(JWT_PATTERN, REPLACEMENTS.token);
  output = output.replace(BEARER_PATTERN, `Bearer ${REPLACEMENTS.token}`);
  output = output.replace(PREFIXED_TOKEN_PATTERN, REPLACEMENTS.token);
  return output;
}

/**
 * Shared masking pipeline for conversation title/preview text.
 * Keep this deterministic so Track A/B can safely reuse it.
 */
export function maskConversationTitleOrPreview(
  input: string,
  options?: SensitiveMaskOptions,
): string {
  const merged = { ...DEFAULT_OPTIONS, ...options };
  let output = input;

  if (merged.maskInternalUrls) {
    output = maskInternalUrls(output);
  }
  if (merged.maskEmails) {
    output = maskEmails(output);
  }
  if (merged.maskTokens) {
    output = maskTokens(output);
  }
  if (merged.maskPhones) {
    output = maskPhones(output);
  }

  return output;
}
