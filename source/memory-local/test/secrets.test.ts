import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanSecrets, redactSecrets } from '../src/secrets.ts'

test('scanSecrets detects common credential shapes', () => {
  const text = [
    '数据库密码 password: hunter2secret',
    '我的 key 是 sk-abcdefghijklmnop123456',
    'github token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456789-abcdefghij',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
  ].join('\n')
  const kinds = new Set(scanSecrets(text).map((f) => f.kind))
  assert.ok(kinds.has('key-assignment'), 'key=value rule fires')
  assert.ok(kinds.has('api-key-sk'))
  assert.ok(kinds.has('github-token'))
  assert.ok(kinds.has('aws-access-key'))
  assert.ok(kinds.has('slack-token'))
  assert.ok(kinds.has('bearer-token'))
})

test('scanSecrets detects private key blocks', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----'
  const found = scanSecrets(`记住这个 ${pem}`)
  assert.ok(found.some((f) => f.kind === 'private-key'))
})

test('clean text has no findings', () => {
  assert.equal(scanSecrets('部署数据库迁移必须先做备份，用 PostgreSQL 16').length, 0)
  assert.equal(scanSecrets('').length, 0)
})

test('redactSecrets masks spans with kind labels', () => {
  const redacted = redactSecrets('key 是 sk-abcdefghijklmnop123456 请保存')
  assert.ok(!redacted.includes('sk-abcdefghijklmnop123456'))
  assert.ok(redacted.includes('[REDACTED:api-key-sk]'))
  // redaction is idempotent on already-redacted text
  assert.equal(redactSecrets(redacted), redacted)
})

test('every scan finding is also caught after redaction', () => {
  const dirty = 'token: supersecretvalue123 和 sk-abcdefghijklmnop123456'
  const clean = redactSecrets(dirty)
  assert.equal(scanSecrets(clean).length, 0, 'redacted output is clean')
})

test('0.90.0：补齐 JWT / HF / Google / Stripe / npm / Basic-Auth / Telegram / 中文凭据', () => {
  const samples = [
    ['jwt', 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
    ['hf-token', 'hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['google-api-key', 'AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
    ['stripe-key', `sk_live_${'A'.repeat(24)}`],
    ['npm-token', 'npm_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'],
    ['basic-auth-url', 'postgres://admin:hunter2supersecret@db.internal:5432/app'],
    ['telegram-bot-token', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'],
    ['cjk-credential', '服务器密码是 Hunter2@prod'],
  ]
  for (const [kind, text] of samples) {
    const kinds = new Set(scanSecrets(`记住：${text}`).map((finding) => finding.kind))
    assert.ok(kinds.has(kind), `${kind} 应被识别（实际 ${[...kinds].join(',')}）`)
  }
  // 常见非凭据文本不能被误报。
  assert.equal(scanSecrets('JWT 过期后需要重新登录；Google 搜索 API 文档').length, 0)
  assert.equal(scanSecrets('数据库部署在 127.0.0.1:5432，密码错误时看日志').length, 0)
})
