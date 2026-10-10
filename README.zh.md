# dsh-plugin-patcher

把「这个 profile 需要长期维持的改动」写在一处，再用一个页面看它们现在还成不成立。

要解决的问题很具体。profile 里的第三方插件会漂移 —— harness 改了它调用的 API，或者插件升了版、和 profile 原本假设的形状对不上 —— 通常的修法是直接手改 `node_modules`。但这个改动活不下来：插件管理器每次装卸都实跑 `pnpm add`，没有 manifest 背书的手改会被剪掉。于是同样的修法一遍遍重来，而且没人知道，profile 悄悄变回错的状态。

这个插件把修法变成声明式的。你写下「应该是什么样」，宿主每次 reconcile 都去核对，告诉你什么时候不成立了，并把它改回去。

## 能绑什么

| 目标 | 改什么 | 谁来写 |
| --- | --- | --- |
| `settings` | 另一个插件设置命名空间里的某个路径 | 宿主，走设置服务 |
| `patch-row` | profile `cordis.patch.yml` 里某行的 `config:` 或 `disabled:` | 宿主，走插件管理器 |
| `package-file` | 已安装包里的源码 | 独立进程的 CLI，宿主绝不写 |

最后一行是关键，这个限制是刻意的。pnpm 装出来的文件是硬链接进 CAS store 的，原地写会污染同版本的所有副本；而插件管理器自己持锁、自己对「这个树该长什么样」有判断。所以宿主对包文件**只读**：它报漂移、说清看到了什么、并打印出修它的命令。那条命令走 `pnpm patch`，所以产出的补丁有 manifest 背书，下一次装卸也活得下来。

```bash
node scripts/apply-code-patch.mjs --patch-id reasoning-ladder --pkg dsh-reasoning-effort
```

## 两半

浏览器那半拥有 spec。它通过本插件自己的设置命名空间写入 —— 和 profile 行 id 是同一个字符串，所以只有一份配置、一个文档、一个宿主要盯的东西。每次编辑都会把 `reconcileNonce` 加一，因为值没变的写入，宿主根本看不见。

宿主那半负责 reconcile。启动时、自己命名空间有任何变化时、以及页面上手动点时，它从零重算整份 spec，把缺的补上。

「全部重算」正是重点所在。一次设置写入可以同时改掉「有哪些补丁」「各自瞄准什么」「各自期望什么」；对「这个 profile 现在该是什么样」没有更便宜的正确算法，而全量重算也让这个循环天然幂等。

## 状态

| 状态 | 含义 |
| --- | --- |
| `in-sync` | 目标就是补丁要的样子 |
| `drifted` | 不是了；重新应用会覆盖现在有的值 |
| `pending` | 还没核对 |
| `conflict` | 两条补丁认领同一行、find 命中多处、或别人也在往这儿写 |
| `unsupported` | 这个宿主做不了：包文件补丁没钉版本，或钉的版本不是已装版本 |
| `absent` | 目标不在这个部署里 |
| `failed` | 上一次没做完，细节在 detail 里 |

把补丁关掉会从 journal 回滚，所以「停用一条补丁」同时也是「撤销一条补丁」。journal 里只有半对记录（写 before 之后、写 after 之前崩了）时报冲突并**不**自动回滚 —— 半截记录唯一稳妥的读法是：补丁停了以后，别人又动过这个目标。

## 内置生成器

有一条补丁以生成器而不是固定值的形式提供：思维强度阶梯。该上阶梯的模型清单在写 spec 时是不知道的 —— 它取决于宿主 reconcile 那一刻各家 provider 声明了什么 —— 所以展开发生在看得见活值的地方，也就是设置适配器。

```json
{ "$gen": "reasoning-ladder", "args": { "config": { "rungs": ["off", "medium", "high", "xhigh", "max"] } } }
```

## 三个例子，都来自一个真实的 profile

`examples/` 里躺着三条 spec，是从一个背了三处手改的 profile 上抄下来的。它们就是普通 spec：打开一个、复制文本、粘进页面的导入框。

| 文件 | 它声明的是哪处手改 | 在原 profile 上的状态 |
| --- | --- | --- |
| `plan-build-switch-command-arity.json` | `dsh-plan-build-switch` 调 `commands/execute` 只传两个参数，0.1.7 的客户端契约要三个 | `drifted` —— 就是它把开关弄坏的 |
| `subagent-roles-configforms.json` | `dsh-plugin-subagent-roles` 绑的是 0.1.7 已经删掉的 `ctx.settingsScope` | `in-sync` —— 该 profile 已经带着这个补丁 |
| `think-translate-icons-and-seat.json` | `dsh-think-translate` 找的是 0.1.7 之前的图标导出，现在全是 null | `in-sync` —— 靠 `file:` vendor 加一个校验和脚本带着的 |

把第二条第三条声明出来，取代的就是那个校验脚本：它们的修复从来没进过 manifest，所以没有任何东西在看着它们；现在宿主每次 reconcile 都会重读这两个文件，并在页面上说出来。第一条是例外，它的修复得落一次地 —— 走 CLI，或者走卡片上那两个按钮，它们跑的就是同一个 CLI。

三条里每一个 `find` 都对着「发布时的样子」和「现在装在 node_modules 里的样子」各核了一遍。已经修好的那两条读出来是 `in-sync`，没修的那条读出来是 `drifted`，并打印出能落地的命令。

会插入内容的 edit 写成「找到这个锚点，换成锚点加新增的几行」，所以它落完之后，find 还在——就坐在自己那份替换文本里面。漂移检查判的是这个包含关系，而不是 find 有没有消失；否则每一段插入都会被读成「还没改」，CLI 就会再插一遍。

## 装上就有的三条

空 spec 等于什么都不看，所以第一次启动时宿主会把 `examples/` 里的三条写进本插件自己的命名空间，写完当轮就 reconcile。

种一次，靠的是 spec 里的 `initialized` 标志：它在的时候是「有人做过选择」，宿主一个字都不再动。所以你把列表清空，清空就是清空，不会因为下次重启又被塞回来。spec 读不出来（坏了）的时候也绝不覆盖 —— 宁可什么都不写，也不能拿默认值盖掉一份操作者改过的东西。

从旧版本升上来也走同一条路：老 spec 里没有这个字段，`initialized` 缺省成 false，也就是「还没种过」，所以升级后第一次启动会补种一次。已经带着手改补丁的 profile 补进来的是三条同样 in-sync 的声明，reconcile 之后状态不变。

默认值不会自己往回跑。操作者清空之后想再加回来，页面上有「补全内置默认」这一条路，但那是一个要人点的动作 —— 默认值和突袭之间差的就是这一下。

## 页面上那两个按钮

`package-file` 补丁漂移时，卡片上会出现两个按钮：

- **先看改动** —— 跑一遍 `--dry-run`，打印 diff 然后丢掉，什么都不写。
- **应用修复** —— 跑真正的命令，末尾带 `--install`（`pnpm patch-commit` 只产出补丁文件，装好的副本要等 install 才对）。

这是整个插件唯一会启动子进程的地方，所以值得说清楚它凭什么安全：

- 请求体只有 `{ patchId, dryRun }`。**argv 完全由宿主从 spec 拼出来** —— 页面永远不能指定一个要执行什么。
- 必须带自定义头 `x-dsh-plugin-patcher`。不带预检的跨域页面设不出这个头，于是那个响应本来就过不去。
- 一次只跑一个。第二个请求是 409，因为 pnpm 持着 profile 的锁，两个一起来只会互相抢。
- 三重上限：请求体 4 KiB、输出 60 000 字符（超了保尾部，失败信息在最后）、5 分钟超时（SIGTERM，5 秒后 SIGKILL）。
- 真跑只接受 `drifted`；预览接受 `drifted`/`conflict`/`failed`。已经是 `in-sync` 的补丁点下去没有意义，接口直接拒。

跑完的输出原样回到页面上。pnpm 失败时 stderr 就是全部价值，所以它不会被压扁成一句「出错了」。

## 安装

```bash
pnpm add dsh-plugin-patcher
```

bundle 自带 `cordis.patch.yml` 会注册自己的 profile 行，不需要手工添加。

## 几条安全约定

- **没有 journal 就不写。** journal 写不进去，apply 根本不会执行。
- **命中次数必须精确。** 代码编辑必须只命中一次；0 次和 2 次都拒绝，绝不靠猜。
- **spec 是唯一的写通道。** 页面与宿主共用一个字符串，`scripts/verify-package.mjs` 会在两者不再一致时失败。
- **宿主不跑 pnpm。** 它自己不执行任何 pnpm；有人点了按钮，它才起一个独立进程跑 `scripts/apply-code-patch.mjs`，而那个脚本是唯一碰 pnpm 的地方。

## 开发

```bash
pnpm test     # 单测，不需要浏览器
pnpm build    # 宿主 bundle（esm）和浏览器 bundle（cjs）
pnpm verify   # manifest、bundle 与文件形态检查
```

`test/client-bundle.test.ts` 会在 VM 里按宿主模块加载器的方式求值构建出来的浏览器 bundle，因为一个加载时就抛异常的 bundle，在终端看来和一个正常的插件毫无区别。

## License

MIT