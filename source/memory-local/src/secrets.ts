/**
 * Secret denylist for memory content (design §11): refuse or redact anything
 * that looks like a credential before it reaches the store or the embedder.
 * Patterns are deliberately conservative — better a false refusal on an
 * obvious token shape than a silent key leak into a plaintext JSONL file.
 */

export interface SecretFinding {
  kind: string
  index: number
  length: number
}

interface DenyRule {
  kind: string
  re: RegExp
}

const RULES: DenyRule[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'api-key-sk', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  // 0.90.0：补齐实际会话里最常见的凭据形态（此前的规则主要覆盖 sk-/gh/AWS/Bearer）。
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'hf-token', re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  // 连接串里的 user:pass@ —— 只识别带 @ 的 URL 凭据，不会误伤普通 127.0.0.1:port。
  { kind: 'basic-auth-url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s/@]+@[^\s/]+/gi },
  { kind: 'telegram-bot-token', re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g },
  {
    kind: 'key-assignment',
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
  },
  // 中文表述（"密码是 xxx" / "令牌：xxx"）；要求引导词 + 分隔符，避免误伤"密码错误"。
  { kind: 'cjk-credential', re: /(?:密码|密钥|秘钥|令牌|口令|凭据)\s*(?:是|为|[:：=])\s*[^\s，。；,;]{6,}/g },
]

/** Find credential-shaped spans in free text. */
export function scanSecrets(text: string): SecretFinding[] {
  const found: SecretFinding[] = []
  for (const { kind, re } of RULES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      found.push({ kind, index: m.index, length: m[0].length })
      if (m.index === re.lastIndex) re.lastIndex++ // guard zero-length loops
    }
  }
  return found
}

/** Mask every matched span as [REDACTED:<kind>]; length changes are expected. */
export function redactSecrets(text: string): string {
  let out = text
  for (const { kind, re } of RULES) {
    re.lastIndex = 0
    out = out.replace(re, `[REDACTED:${kind}]`)
  }
  return out
}
