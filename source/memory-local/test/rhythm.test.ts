import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reflectionDue, proposalDue, inferGoalCandidates, hasRecentCandidate } from '../src/cognitive/rhythm.ts'

const DAY = 86_400_000
const now = 1_800_000_000_000

test('节律：首次到点，之后按间隔到期', () => {
  assert.equal(reflectionDue({}, { now }), true)
  assert.equal(reflectionDue({ lastReflectAt: now - DAY / 2 }, { now }), false)
  assert.equal(reflectionDue({ lastReflectAt: now - DAY - 1 }, { now }), true)
  assert.equal(proposalDue({ lastProposeAt: now - 2 * DAY }, { now }), false)
  assert.equal(proposalDue({ lastProposeAt: now - 3 * DAY }, { now }), true)
})

test('目标提案：近期高重要度且带线索的记忆入选', () => {
  const records = [
    { id: 'a'.repeat(36), kind: 'decision', content: '下一步要把联想预热做了', importance: 0.8, updatedAt: now - DAY },
    { id: 'b'.repeat(36), kind: 'fact', content: '需要但类型不对', importance: 0.9, updatedAt: now - DAY },
    { id: 'c'.repeat(36), kind: 'state', content: '已完成的旧状态', importance: 0.2, updatedAt: now - DAY },
    { id: 'd'.repeat(36), kind: 'procedure', content: '计划每周自省一次', importance: 0.8, updatedAt: now - DAY },
    { id: 'e'.repeat(36), kind: 'decision', content: '自省报告提到候选目标需要再确认', importance: 0.9, updatedAt: now - DAY },
  ]
  const candidates = inferGoalCandidates(records, { now })
  assert.equal(candidates.length, 1)
  assert.match(candidates[0]!.conclusion, /联想预热/)
  assert.ok(candidates[0]!.confidence > 0.5)
})


test('相近候选去重：同结论近期已存在则跳过', () => {
  const records = [{ kind: 'reflection', content: '节律自省：修正偏多', conclusion: '修正次数偏多：检查同类记忆', updatedAt: now - DAY }]
  assert.equal(hasRecentCandidate(records, '修正次数偏多：检查同类记忆', { now }), true)
  assert.equal(hasRecentCandidate(records, '完全不同的结论', { now }), false)
  assert.equal(hasRecentCandidate(records, '修正次数偏多：检查同类记忆', { now, proposeEveryMs: DAY / 2 }), false)
})
