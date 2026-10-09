# dsh-reasoning-ladder

为 DeepSeek Harness 强制写入固定的五档思维强度阶梯。

| 档位 | 值 |
| --- | --- |
| 最低 | `off` |
| 2 | `medium` |
| 3 | `high` |
| 4 | `xhigh` |
| 最高 | `max` |

阶梯会同时写入 `llm-pi-ai` 设置命名空间里声明的每一个模型，**以及** profile 的
`cordis.patch.yml` 里的模型列表——因为 patch 条目的优先级高于设置层，只改设置是
不生效的。

## 为什么单独做一个插件

阶梯本身和阶梯选择器是两件事，但上游把它们打在了同一个包里。这个插件的目的就是：
改阶梯的时候不用再去 fork 那个画 UI 的插件。

它和上游之间**没有任何 inter-plugin 耦合**，只依赖两个 DSH 核心标识：设置命名空间
`llm-pi-ai` 和 patch 条目 id `llm-pi-ai`。

和 `dsh-reasoning-effort` **一起安装**，并把上游插件置为惰性，让两边不会抢同一份数据：

```yaml
- id: reasoning-effort
  name: dsh-reasoning-effort
  config:
    auto: false
```

`auto: false` 且不配 `providers` 时，上游算出的 ops 恒为空数组，一次 `settings.mutate`
都不会发出去。它继续负责画选择器，值由本插件独家持有。

## 安装

```bash
dsh plugin add github:sqing33/dsh-reasoning-ladder
```

## 配置

所有键都是可选的，默认配置就是「五档阶梯 + 全局生效」。

```yaml
- id: reasoning-ladder
  name: dsh-reasoning-ladder
  config:
    # false = 只处理 providers 里显式列出的 provider
    auto: true
    # false = 不改 cordis.patch.yml，只写设置
    force: true
    defaults:
      efforts:
        off: off
        medium: medium
        high: high
        xhigh: xhigh
        max: max
    providers:
      anthropic:
        disabled: false
        models:
          claude-opus-5:
            disabled: false
    targets:
      # true  = 覆盖已经声明过的 reasoningEfforts
      # false = 原样保留（上游的行为）
      overwrite: true
      # true  = 一并处理 modelOverrides 段
      modelOverrides: true
```

### `targets.overwrite`

上游只填补**缺失**的声明，这正是「明明配了五档，模型上还挂着 `low`」的来源。
把它设成 `false` 就退回上游的「只补空缺」语义。

### `targets.modelOverrides`

provider 上可能有一张 `modelOverrides` 表会遮蔽模型列表，默认也会一并写入；
设成 `false` 可以让它保持原样。

## 安全性

改写 `cordis.patch.yml` 是本插件唯一破坏性的操作，所以做了加固：

- 首次改动前把原文件复制成 `cordis.patch.yml.ladder-backup`，之后不再覆盖；
- 新内容先写 `cordis.patch.yml.ladder-tmp` 再 `rename` 原子替换，中途崩掉也不会截断
  profile；
- 失败会带原因写日志并记进插件状态，不静默吞掉。`llm-pi-ai` 命名空间 40 次重试后
  仍未出现时，插件会明确报出来，而不是假装成功；
- 想彻底关掉改写，把 `force` 设成 `false`。

回滚：

```bash
cp /path/to/profile/cordis.patch.yml.ladder-backup /path/to/profile/cordis.patch.yml
```

## 与上游的关系

`src/reasoning-settings.ts` 是二开实现的移植，`test/fixtures/expected-ops.json` 由二开
代码在同一份快照上跑出来：所有共有用例逐字节相同。

三处刻意的差异：

1. **`targets` 两个开关**（`overwrite`、`modelOverrides`）上游表达不了——二开是永远覆盖。
2. **所有 provider 都会改写，不只第一个。** 二开实现扫到 `llm-pi-ai` 条目里第一个
   `models:` 块就停，所以一个 patch 条目里声明多个 provider 时，只有第一个拿到阶梯。
   本插件会走完所有块；阶梯块的缩进也改成从文件推导，不再写死 12 空格。
3. **patch 改写按上文加固。**

schemastery schema 被拆到 `src/schema.ts`，让阶梯计算保持零依赖纯模块，单测不装任何
依赖就能跑。

## 开发

```bash
pnpm install
pnpm test      # 51 个用例，零依赖
pnpm run build
pnpm run verify
```

## 许可证

MIT
