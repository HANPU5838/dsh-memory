/**
 * 合成记忆集（离线检索评测用，零依赖、纯数据 + 确定性构造）。
 *
 * 为什么自己造数据集而不是只跑公开集：
 *   - 公开集（LoCoMo 等）测的是"对话历史问答"，和"个人记忆库检索"不完全同构；
 *   - 我们需要能单独观察 **同义改写 / 跨语言 / 时序 / 冲突+噪声** 四类查询，
 *     每一类都要有明确的人工标注（哪几条记录算答对），公开集没有这种切分；
 *   - 固定 seed + 纯数据 → 同一版本任何机器上跑出的数字一致，适合进 CI 当回归线。
 *
 * 语料结构（每个主题 12 组，共 12×7 + 10 = 94 条记录、12×4 = 48 条查询）：
 *
 *   A 组（3 条，同一条知识的三种写法）：
 *     a-zh   中文陈述
 *     a-en   英文陈述（跨语言查询的目标）
 *     a-alt  中文同义改写（dedupe 的合并对象）
 *   B 组（2 条，同一配置的旧值 / 新值）：
 *     b-old  旧结论（陷阱：措辞和新值几乎一样、历史取用次数多）
 *     b-new  新结论（时序/冲突查询的目标）
 *   n1/n2（2 条，主题内噪声：相关但不回答问题）
 *   + 10 条跨主题噪声（同时提到多个主题的关键词）
 *
 * 查询四类（每主题各 1 条）：
 *   paraphrase 同义改写（中文，复述 A 组知识）
 *   cross      跨语言（英文问同一知识）
 *   temporal   时序（中文，问 B 组配置"现在是"多少）
 *   conflict   冲突+噪声（中文，"到底是旧值还是新值"——旧值是高相似陷阱）
 *
 * 标注是 **group 级**（`<topic>.a` / `<topic>.b`）：A 组三条记录是同一条知识的

 * 三种写法，命中任意一条就算答对；这样 semanticDedupe 把重复条目合并掉时不会
 * 被错误地扣 recall（生产上"合并重复"本来就是想要的行为）。旧值 `b-old` 属于
 * 另一个 group（`<topic>.b.old`），不会被标注为相关——排到它上面自然会掉分。
 */

/** tools/bench/lib.mjs 里的确定性随机数（零依赖，复用而不是抄一份）。 */
import { mulberry32 } from '../bench/lib.mjs'

/** 一天毫秒数。 */
export const DAY_MS = 86_400_000

/**
 * 评测基准时间：固定值，保证跨机器/跨时间可复现。
 * 记录时间戳都相对它计算（"n 天前"）。
 */
export const SYNTHETIC_NOW = Date.UTC(2026, 10, 1) // 2026-11-01T00:00:00Z

/**
 * 12 个主题。字段说明：
 *   key      主题 id（用于记录 id 前缀）
 *   tags     记忆标签（词法通道把标签也算可检索文本，和线上一致）
 *   a.zh/en/alt        A 组三条正文
 *   b.old/new          B 组旧值/新值正文
 *   b.oldAgeDays/newAgeDays  B 组相对基准时间的年龄（天）
 *   noise             主题内噪声正文
 *   queries.{paraphrase,cross,temporal,conflict}  四类查询文本
 */
const TOPICS = [
  {
    key: 'deploy',
    tags: ['deploy', '发布'],
    a: {
      zh: '生产环境发布走灰度：先放 5% 流量观察 30 分钟，错误率低于 0.1% 才允许全量。',
      en: 'Production releases use a canary rollout: start with 5% of traffic for 30 minutes, and only go fully live if the error rate stays below 0.1%.',
      alt: '上线要分批推——先灰度 5% 跑半小时，错误率没超过千分之一再推全量。',
    },
    b: {
      old: '发布窗口固定在每周五 18:00，到点直接全量发布。',
      new: '发布窗口改为每周二 10:00，并且必须走灰度分批发布。',
      oldAgeDays: 300,
      newAgeDays: 2,
    },
    noise: [
      '发布公告模板放在 docs/release-template.md，发版前要填版本号和负责人。',
      '构建产物体积超过 20MB 时，流水线会给一条警告。',
    ],
    queries: {
      paraphrase: '生产环境上线时，小流量试跑到什么程度才能放开全量？',
      cross: 'How does a production release roll out, and when is it allowed to go fully live?',
      temporal: '发布窗口现在定在每周几、几点？',
      conflict: '发布窗口到底是周五 18:00 还是周二 10:00？',
    },
  },
  {
    key: 'database',
    tags: ['database', '迁移'],
    a: {
      zh: '数据库迁移用 expand-contract：先加新列并双写，回填完成后切读，最后再删旧列。',
      en: 'Database migrations follow expand-contract: add the new column and dual-write, backfill the data, switch reads, and drop the old column last.',
      alt: '改表结构分三步：加列双写、回填数据、切换读写后再清理旧字段。',
    },
    b: {
      old: '数据库连接池上限是 20，高峰期经常等到超时。',
      new: '数据库连接池上限已调到 50，并加了等待队列监控。',
      oldAgeDays: 260,
      newAgeDays: 4,
    },
    noise: ['慢查询日志每天凌晨 3 点轮转，保留 7 天。', '备份策略是全量每天一次、增量每小时一次。'],
    queries: {
      paraphrase: '改表结构时怎么保证不停机？具体分哪几步？',
      cross: 'How should a schema change be rolled out without downtime?',
      temporal: '数据库连接池上限现在是多少？',
      conflict: '连接池上限到底是 20 还是 50？',
    },
  },
  {
    key: 'embedding',
    tags: ['embedding', '向量'],
    a: {
      zh: '嵌入模型用 bge-m3，输出 1024 维，查询前缀为空，向量入库前做 L2 归一化。',
      en: 'Embeddings use bge-m3 with 1024 dimensions, an empty query prefix, and L2 normalization before vectors are stored.',
      alt: '向量化走 bge-m3，1024 维，写库前统一归一化，查询不加前缀。',
    },
    b: {
      old: '批量嵌入的批大小设成 8，慢但稳定。',
      new: '批量嵌入的批大小调到 32，吞吐高了大约三倍。',
      oldAgeDays: 340,
      newAgeDays: 1,
    },
    noise: ['embedding 缓存按「内容哈希 + 模型身份」做键，实测命中率约 80%。', 'bge-m3 也支持稀疏检索，但当前只使用稠密向量。'],
    queries: {
      paraphrase: '把文本变成向量用的是什么模型？多少维？入库前还要做什么处理？',
      cross: 'Which embedding model and dimension are used, and is normalization applied before storing vectors?',
      temporal: '批量嵌入的批大小现在设成多少？',
      conflict: '嵌入批大小到底是 8 还是 32？',
    },
  },
  {
    key: 'cache',
    tags: ['cache', '缓存'],
    a: {
      zh: '查询向量有内存缓存，热查询命中后完全不发网络请求，P50 只要 0.03ms。',
      en: 'Query embeddings are cached in memory; a hot query never touches the network and returns in 0.03 ms at P50.',
      alt: '重复问句不用重新算向量，直接命中内存缓存，延迟大约 0.03 毫秒。',
    },
    b: {
      old: '查询向量缓存容量是 256 条，满了就整批清空。',
      new: '查询向量缓存容量扩到 1024 条，满了按 LRU 淘汰。',
      oldAgeDays: 280,
      newAgeDays: 3,
    },
    noise: ['向量压缩用 float32 存盘，内存里也是 Float32Array。', '缓存回填队列在重启后会自动重建。'],
    queries: {
      paraphrase: '同一个问题问第二遍时，为什么不用重新调用嵌入服务？',
      cross: 'Why do repeated queries not call the embedding service again?',
      temporal: '查询向量缓存容量现在是多少条？',
      conflict: '向量缓存容量是 256 条还是 1024 条？',
    },
  },
  {
    key: 'testing',
    tags: ['test', '回归'],
    a: {
      zh: '回归测试用 node --experimental-strip-types --test 直接跑 TypeScript 源码，不需要先编译。',
      en: 'Regression tests run the TypeScript sources directly with node --experimental-strip-types --test; there is no build step.',
      alt: '测试不经过编译：node 加类型剥离参数就能直接执行 TS 用例。',
    },
    b: {
      old: '测试覆盖率的验收线是 60%。',
      new: '测试覆盖率的验收线提高到 80%，并且新增文件必须带测试。',
      oldAgeDays: 420,
      newAgeDays: 6,
    },
    noise: ['CI 里单测超过 120 秒会被判定超时并杀进程。', '测试数据统一放在 source/*/test/ 下，和源码一起维护。'],
    queries: {
      paraphrase: '跑回归测试之前需要先构建或编译 TypeScript 吗？',
      cross: 'Do the regression tests need a build step before they can run?',
      temporal: '测试覆盖率的验收线现在是多少？',
      conflict: '覆盖率验收线到底是 60% 还是 80%？',
    },
  },
  {
    key: 'device',
    tags: ['Termux', '设备'],
    a: {
      zh: '本机是 Android/Termux 上的 aarch64 设备，Node 26，内存 8GB，嵌入模型跑在本地。',
      en: 'The machine is an aarch64 Android/Termux device with Node 26 and 8 GB of RAM; the embedding model runs locally.',
      alt: '开发机是 arm64 的安卓终端环境，Node 26、8G 内存，嵌入服务也在本机。',
    },
    b: {
      old: '嵌入服务的监听端口是 8080。',
      new: '嵌入服务的监听端口改为 8078。',
      oldAgeDays: 310,
      newAgeDays: 2,
    },
    noise: ['Termux 上 npm 走 npmmirror 镜像，pip 走清华源。', '设备支持 root，文件系统权限比较宽。'],
    queries: {
      paraphrase: '开发机是什么环境和配置？Node 版本和内存多大？',
      cross: 'What is the development environment, including the Node version and memory size?',
      temporal: '嵌入服务现在监听哪个端口？',
      conflict: '嵌入端口到底是 8080 还是 8078？',
    },
  },
  {
    key: 'retrieval',
    tags: ['retrieval', '召回'],
    a: {
      zh: '检索先做词法和向量双通道召回，再按强度排序，最后依次做地板分、同义合并、MMR 三步整形。',
      en: 'Retrieval first recalls candidates through lexical and vector channels, ranks them by strength, then shapes results with a score floor, semantic dedupe, and MMR.',
      alt: '召回是双通道的，排序看强度，整形依次做绝对分下限、同义条目合并和多样性选择。',
    },
    b: {
      old: '召回深度 recallN 是 15。',
      new: '召回深度 recallN 调到 30，整形前多留候选。',
      oldAgeDays: 240,
      newAgeDays: 2,
    },
    noise: ['中文分词会同时生成一元和二元 token。', '词法分数用 IDF 加权，并按查询长度自适应阈值。'],
    queries: {
      paraphrase: '搜记忆时，召回之后结果还要经过哪些加工步骤？',
      cross: 'How are search results post-processed after the recall stage?',
      temporal: '召回深度 recallN 现在是多少？',
      conflict: '召回深度是 15 还是 30？',
    },
  },
  {
    key: 'memory',
    tags: ['memory', '存储'],
    a: {
      zh: '记忆以 JSONL 落盘，按 scope 分文件；写入是追加加定期重写，读路径只走内存索引。',
      en: 'Memories are persisted as per-scope JSONL files with append writes and periodic rewrites; reads only touch the in-memory index.',
      alt: '存储格式是每个作用域一个 JSONL 文件，写追加、读内存索引。',
    },
    b: {
      old: '自动注入的 token 预算是 500。',
      new: '自动注入的 token 预算提高到 1200。',
      oldAgeDays: 300,
      newAgeDays: 5,
    },
    noise: ['忘记是软删：先标 tombstone，30 天后才物理清理。', '记忆按种类分 fact/preference/procedure/decision/note/state/rule。'],
    queries: {
      paraphrase: '记忆写到磁盘上是什么格式？怎么分文件？读取时从哪里拿？',
      cross: 'What on-disk format do memories use, and how are they partitioned per scope?',
      temporal: '自动注入的 token 预算现在是多少？',
      conflict: '注入预算到底是 500 还是 1200 token？',
    },
  },
  {
    key: 'network',
    tags: ['network', '超时'],
    a: {
      zh: '调用外部接口统一 10 秒超时，失败重试一次；重试还失败就跳过并记日志。',
      en: 'Outbound HTTP calls time out after 10 seconds and retry once; if the retry fails the call is skipped and logged.',
      alt: '外网请求 10 秒超时、重试一次，仍然失败就放弃这次并留日志。',
    },
    b: {
      old: '模型下载的超时设成 30 秒。',
      new: '模型下载的超时放宽到 300 秒，避免大文件中断。',
      oldAgeDays: 200,
      newAgeDays: 3,
    },
    noise: ['代理设置读 HTTPS_PROXY，没配就直连。', '下载支持断点续传，用 Range 请求校验 Content-Range。'],
    queries: {
      paraphrase: '调外部接口时超时和重试是怎么规定的？失败之后怎么办？',
      cross: 'What is the timeout and retry policy for outbound HTTP calls?',
      temporal: '模型下载的超时现在设成多少秒？',
      conflict: '下载超时到底是 30 秒还是 300 秒？',
    },
  },
  {
    key: 'security',
    tags: ['security', '凭据'],
    a: {
      zh: '凭据不进记忆库：secret 在写入前就被安全层拒绝，只在内存里保留审计事件。',
      en: 'Credentials never reach the memory store: secrets are rejected by the security layer before writing, and only in-memory audit events remain.',
      alt: '敏感凭据写不进来，落库前就被拒掉，只留下审计事件。',
    },
    b: {
      old: '审计日志保留 7 天。',
      new: '审计日志保留 30 天。',
      oldAgeDays: 250,
      newAgeDays: 8,
    },
    noise: ['审批提示被关闭时，需要审批的操作会直接失败而不是等待。', '作用域权限分只读和读写，写入需要显式申请。'],
    queries: {
      paraphrase: '敏感的 token、口令这类东西能写进记忆库吗？安全层会怎么处理？',
      cross: 'Are credentials ever written into the memory store, and what does the security layer do instead?',
      temporal: '审计日志现在保留多少天？',
      conflict: '审计日志保留 7 天还是 30 天？',
    },
  },
  {
    key: 'panel',
    tags: ['panel', '面板'],
    a: {
      zh: '管理面板的记忆树支持自由缩放，状态徽章区分有效、休眠、软删，强度条显示保持度。',
      en: "The administration panel's memory tree supports free zoom; status badges distinguish active, dormant, and tombstoned memories, and strength bars show retention.",
      alt: '界面里记忆树能缩放，徽章标状态，强度条画出保持度曲线。',
    },
    b: {
      old: '面板默认每页显示 20 条。',
      new: '面板默认每页显示 50 条。',
      oldAgeDays: 300,
      newAgeDays: 4,
    },
    noise: ['面板刷新走 SSE 推送，不做轮询。', '记忆树里可以直接恢复被软删的条目。'],
    queries: {
      paraphrase: '界面上那棵记忆树能做什么？怎么看出每条记忆的状态和强弱？',
      cross: 'What can you do with the memory tree in the panel, and how are memory statuses shown?',
      temporal: '面板默认每页显示多少条？',
      conflict: '面板默认每页是 20 条还是 50 条？',
    },
  },
  {
    key: 'build',
    tags: ['build', '打包'],
    a: {
      zh: '构建产物是单包单入口，只发布 lib/、locale/ 和 cordis.patch.yml，不发布源码。',
      en: 'The build produces a single package with one entry: only lib/, locale/, and cordis.patch.yml are published, never the source files.',
      alt: '打包只带编译产物、语言包和补丁配置，源码不进 npm 包。',
    },
    b: {
      old: '当前发布版本号是 0.34.2。',
      new: '当前发布版本号是 0.35.0。',
      oldAgeDays: 30,
      newAgeDays: 1,
    },
    noise: ['图标 icon.svg 放在包根目录。', '构建脚本在 tools/build-single-package.mjs，用 --no-place 可以只验证不落盘。'],
    queries: {
      paraphrase: '发布到 npm 的包里都包含哪些文件？会不会带 TypeScript 源码？',
      cross: 'Which files are published to npm, and is the TypeScript source included?',
      temporal: '当前发布版本号是多少？',
      conflict: '版本号到底是 0.34.2 还是 0.35.0？',
    },
  },
]

/** 跨主题噪声：同时提到两个以上主题的关键词，专门用来考验 floor / dedupe。 */
const GLOBAL_NOISE = [
  '发版前要把查询缓存清掉，再跑一遍回归测试。',
  '数据库迁移脚本要同步更新记忆库的字段映射。',
  '嵌入服务重启后，缓存和 ANN 索引都会重建。',
  'Android 设备上构建大模型下载很慢，最好挂代理。',
  '面板里看到的强度和实际排序分不是一回事，别拿强度条当分数。',
  '测试覆盖率和构建产物体积都会写进发布说明。',
  '外网接口超时的时候，注意看审计日志里有没有被拒绝的请求。',
  '权限申请走审批卡，审批关闭时直接失败。',
  'JSONL 文件损坏时可以用备份重建内存索引。',
  '跨语言查询主要靠向量通道，词法通道基本帮不上忙。',
]

/** 每个主题 A 组三条记录的年龄（天）与更新年龄，按主题序号做小幅错开。 */
const A_AGES = [
  [90, 20],
  [75, 18],
  [105, 26],
  [88, 22],
  [70, 16],
  [95, 24],
  [82, 19],
  [100, 21],
  [78, 17],
  [92, 23],
  [85, 20],
  [72, 15],
]

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/** 加一点确定性抖动（±jitter），让 seed 真的影响语料，但不破坏语义。 */
function jitter(rng, value, amplitude) {
  return value + (rng() * 2 - 1) * amplitude
}

/**
 * 构造合成记忆集。
 *
 * @param {number} seed 随机种子，同 seed → 同语料
 * @returns {{records: Array<object>, queries: Array<object>, meta: object}}
 */
export function buildSyntheticCorpus(seed = 42) {
  const rng = mulberry32(seed)
  const records = []
  const queries = []

  const record = (fields) => {
    const createdAt = fields.createdAt
    const rec = {
      id: fields.id,
      group: fields.group,
      topic: fields.topic,
      content: fields.content,
      tags: fields.tags,
      scope: 'project',
      kind: fields.kind,
      importance: clamp01(jitter(rng, fields.importance, 0.04)),
      accessCount: Math.max(0, Math.round(jitter(rng, fields.accessCount, 1.5))),
      createdAt,
      updatedAt: fields.updatedAt,
      lastAccessedAt: fields.lastAccessedAt,
      lastUsedAt: fields.lastUsedAt,
    }
    records.push(rec)
    return rec
  }

  TOPICS.forEach((topic, index) => {
    const [aAge, aUpdatedAge] = A_AGES[index % A_AGES.length]
    const day = (n) => SYNTHETIC_NOW - Math.round(n) * DAY_MS
    const tagsA = [...topic.tags]
    const id = (slot) => `mem-${topic.key}-${slot}`

    // --- A 组：同一条知识的三种写法，group = <topic>.a ---
    const aGroup = `${topic.key}.a`
    record({
      id: id('a-zh'), group: aGroup, topic: topic.key, content: topic.a.zh, tags: tagsA,
      kind: 'procedure', importance: 0.62, accessCount: 2,
      createdAt: day(aAge), updatedAt: day(aUpdatedAge), lastAccessedAt: day(aUpdatedAge + 5), lastUsedAt: day(aUpdatedAge + 5),
    })
    record({
      id: id('a-en'), group: aGroup, topic: topic.key, content: topic.a.en, tags: tagsA,
      kind: 'fact', importance: 0.55, accessCount: 1,
      createdAt: day(aAge + 5), updatedAt: day(aUpdatedAge + 3), lastAccessedAt: day(aUpdatedAge + 8), lastUsedAt: day(aUpdatedAge + 8),
    })
    record({
      id: id('a-alt'), group: aGroup, topic: topic.key, content: topic.a.alt, tags: tagsA,
      kind: 'fact', importance: 0.5, accessCount: 0,
      createdAt: day(aAge + 10), updatedAt: day(aUpdatedAge + 6), lastAccessedAt: day(aUpdatedAge + 10), lastUsedAt: day(aUpdatedAge + 10),
    })

    // --- B 组：旧值（陷阱）/ 新值，group = <topic>.b（旧值单独 group）---
    record({
      id: id('b-old'), group: `${topic.key}.b.old`, topic: topic.key, content: topic.b.old, tags: [
        ...topic.tags,
        '旧值',
      ],
      kind: 'state', importance: 0.55, accessCount: 14,
      createdAt: day(topic.b.oldAgeDays), updatedAt: day(topic.b.oldAgeDays), lastAccessedAt: day(25), lastUsedAt: day(25),
    })
    record({
      id: id('b-new'), group: `${topic.key}.b`, topic: topic.key, content: topic.b.new, tags: [...topic.tags, '当前'],
      kind: 'state', importance: 0.72, accessCount: 2,
      createdAt: day(topic.b.newAgeDays), updatedAt: day(topic.b.newAgeDays), lastAccessedAt: day(topic.b.newAgeDays), lastUsedAt: day(topic.b.newAgeDays),
    })

    // --- 主题内噪声：相关但不回答问题的说明性记录 ---
    topic.noise.forEach((text, i) => {
      record({
        id: id(`n${i + 1}`), group: `${topic.key}.noise.${i + 1}`, topic: topic.key, content: text, tags: [...topic.tags, 'note'],
        kind: 'note', importance: 0.3, accessCount: 0,
        createdAt: day(60 + i * 20), updatedAt: day(40 + i * 20), lastAccessedAt: day(40 + i * 20), lastUsedAt: day(40 + i * 20),
      })
    })

    // --- 四类查询 ---
    const q = topic.queries
    queries.push(
      { id: `q-${topic.key}-paraphrase`, topic: topic.key, type: 'paraphrase', text: q.paraphrase, labels: [aGroup] },
      { id: `q-${topic.key}-cross`, topic: topic.key, type: 'cross-lingual', text: q.cross, labels: [aGroup] },
      { id: `q-${topic.key}-temporal`, topic: topic.key, type: 'temporal', text: q.temporal, labels: [`${topic.key}.b`] },
      { id: `q-${topic.key}-conflict`, topic: topic.key, type: 'conflict-noise', text: q.conflict, labels: [`${topic.key}.b`] },
    )
  })

  // --- 跨主题噪声 ---
  GLOBAL_NOISE.forEach((text, i) => {
    record({
      id: `mem-global-noise-${String(i + 1).padStart(2, '0')}`, group: `global.noise.${i + 1}`, topic: 'global', content: text, tags: ['noise'],
      kind: 'note', importance: 0.25, accessCount: 0,
      createdAt: SYNTHETIC_NOW - Math.round(30 + i * 9) * DAY_MS, updatedAt: SYNTHETIC_NOW - Math.round(25 + i * 9) * DAY_MS,
      lastAccessedAt: SYNTHETIC_NOW - Math.round(25 + i * 9) * DAY_MS, lastUsedAt: SYNTHETIC_NOW - Math.round(25 + i * 9) * DAY_MS,
    })
  })

  // 记录顺序打散（不影响结果：排序同分时按 id 升序，与插入顺序无关；
  // 打散只是为了让"顺序无关"这件事在测试里被真的覆盖到）。
  for (let i = records.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[records[i], records[j]] = [records[j], records[i]]
  }

  const byType = {}
  for (const query of queries) byType[query.type] = (byType[query.type] ?? 0) + 1

  return {
    records,
    queries,
    meta: {
      name: 'synthetic-v1',
      seed,
      now: SYNTHETIC_NOW,
      topics: TOPICS.length,
      records: records.length,
      queries: queries.length,
      byType,
      groups: new Set(records.map((r) => r.group)).size,
    },
  }
}
