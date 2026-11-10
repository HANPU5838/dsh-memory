# DSH 记忆嵌入性能基准

纯 node 脚本、零额外依赖。测四件事：**写入吞吐 / 文档缓存收益 / 查询延迟 P50·P95 / ANN vs 全量余弦**，外加**回填吞吐**。

## 快速开始

```bash
# 自动探测本机 llama-server（127.0.0.1:8078）→ 探测不到就用合成嵌入
node tools/bench/run.mjs

# 只跑合成数据（不需要任何后端，CI/笔记本上可用）
node tools/bench/run.mjs --mode synthetic

# 连真实 bge-m3 压测（串行小批量、每请求 20s 超时；后端挂了会自动跳过）
node tools/bench/run.mjs --mode live --records 32 --queries 12

# 只测 ANN（2000 → 20000 条合成向量，不跑嵌入阶段）
node tools/bench/run.mjs --mode synthetic --skip-embed --ann-sizes 2000,10000,20000
```

Node ≥ 23.6 直接跑；更老的版本加 `--experimental-strip-types`（脚本会 import 源码 `.ts`）。

## 输出

结果写到 `tools/bench/out/bench-<时间戳>.json` 和 `.md`（`out/` 已 gitignore），
同时把 Markdown 表打到 stdout。JSON 里含设备信息（平台/CPU 型号/核数/内存/Node 版本），
便于把"在什么设备上量的"和数字一起存档。

## 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--mode` | `auto` | `auto` 探测后端 → live 否则 synthetic；`live` 强制真实后端；`synthetic` 强制合成 |
| `--endpoint` | `http://127.0.0.1:8078/v1/embeddings` | 也可用环境变量 `DSH_BENCH_EMBED_ENDPOINT` |
| `--model` | `bge-m3` | live 模式的模型名 |
| `--dims` | live 1024 / synthetic 256 | 嵌入维度 |
| `--records` | live 32 / synthetic 2000 | 写入/缓存/查询的记录数 |
| `--queries` | live 12 / synthetic 50 | 查询条数 |
| `--backfill` | live 16 / synthetic 400 | 回填队列长度 |
| `--batch-sizes` | `1,4,8,16` | 写入吞吐对比的批大小 |
| `--backfill-batch-sizes` | `8,16` | 回填批大小 |
| `--ann-sizes` | `2000,5000,10000,20000` | ANN 压测规模 |
| `--ann-dims` | `128` | ANN 合成向量维度（1024 维建图约慢 8 倍，按需调） |
| `--ann-queries` | `50` | 每个规模的 ANN 查询数 |
| `--timeout-ms` | `20000` | live 单请求超时 |
| `--seed` | `42` | 合成数据种子（可复现） |
| `--out` | `tools/bench/out` | 输出目录 |
| `--skip-ann` / `--skip-embed` / `--skip-live` | — | 跳过对应阶段 |

## 怎么读这些数字

- **写入吞吐**：批大小越大，`records/s` 越高、请求数越少。文档缓存的热跑数字代表"重启后重新嵌入全库"的开销，
  命中率的理论值是 100%（正文没变）。
- **查询延迟**：端到端 = 查询嵌入 + 余弦扫描。慢设备上 CPU 嵌入通常占大头；`--ann-sizes` 里全量扫描
  的 P50 才是 ANN 要优化的部分。
- **ANN**：`recall@10` 以全量扫描为 ground truth；HNSW 的价值在 **P50 提速**，召回率 <95% 时调大
  `efSearch` / `efConstruction` / `M`（见 `source/memory-local/src/ann/`）。
- 所有失败（后端不可用、单条超时）都记进 `notes` 并跳过，脚本退出码恒为 0，不会把 CI 搞红。
