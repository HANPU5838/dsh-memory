/**
 * 0.108.0：代码标识符分词 —— camelCase / snake_case / 缩写词要能被子词检索命中，
 * 整词精确匹配仍然保留（历史群聊里被点名的开发场景缺口）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tokenize } from '../src/scoring.ts'

const has = (text: string, token: string) => tokenize(text).includes(token)

test('0.108.0：camelCase / PascalCase / 缩写词产出子词 token', () => {
  for (const [text, parts] of [
    ['handleUserLogin', ['handleuserlogin', 'handle', 'user', 'login']],
    ['getUserById', ['getuserbyid', 'get', 'user', 'by', 'id']],
    ['parseJSON', ['parsejson', 'parse', 'json']],
    ['HTTPServer', ['httpserver', 'http', 'server']],
  ] as const) {
    for (const part of parts) assert.ok(has(text, part), `${text} 应包含 ${part}`)
  }
})

test('0.108.0：snake_case 按分段产出子词，整词保留', () => {
  const tokens = tokenize('memory_block')
  assert.ok(tokens.includes('memory_block'))
  assert.ok(tokens.includes('memory'))
  assert.ok(tokens.includes('block'))
})

test('0.108.0：普通单词 / 版本号 / 中文不受影响', () => {
  assert.deepEqual(tokenize('hello world'), ['hello', 'world'])
  assert.deepEqual(tokenize('v1.2.3'), ['v1.2.3'])
  assert.deepEqual(tokenize('部署端口'), ['部', '署', '端', '口', '部署', '署端', '端口'])
})
