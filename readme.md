# koishi-plugin-w-sts2

[![npm](https://img.shields.io/npm/v/koishi-plugin-w-sts2?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-w-sts2)

杀戮尖塔 2 卡牌、遗物查询。使用 [Spire Codex](https://spire-codex.com/developers) 中文数据与图片，支持正式版 / beta 独立切换。

## 指令

```text
sts2 战鼓
sts2.card 独门技术 -c beta
sts2.card 专长 -u
sts2.card 打击
sts2.card 打击 -i 2
sts2.card STRIKE_SILENT -t
sts2.relic 燃烧之血
sts2.cache
sts2.cache -c beta
sts2.cache -a -t
```

- `sts2 [名称或 ID]`：同时搜索卡牌、遗物。
- `sts2.card` / `sts2.relic`：仅搜索卡牌 / 遗物。
- `-c, --channel stable|beta`：切换分支。默认正式版，可在插件配置中更改；接受“正式版”“测试版”。
- `-u, --upgrade`：显示升级后的卡牌，包括费用、效果、关键词和中文升级卡图。
- `-i, --index 序号`：从同名 / 模糊结果中选择。也可使用候选项的内部 ID。
- `-t, --text`：只发送文本，不发送图片。

支持当前中文名、旧游民中文名别名、大小写不敏感的完整内部 ID 及卡名包含搜索。名称可含空格。暂未提供英文效果 / 英文全称搜索；英文环境的指令提示仍使用中文游戏数据。

同名牌不自动任选，例如不同角色的“打击”会列为独立候选。已删除或无法确认新 ID 的旧牌不作为现行结果返回。旧胜率数据不展示，以免混淆版本与统计口径。

查询详情和候选列表通过合并转发发送。详情的文字与图片放在同一条转发节点中，来源、分支和选项提示也保留在转发内；错误和未找到结果等提示仍使用普通消息。`-t` 或 `showImages=false` 仅关闭图片，不改变合并转发形式。

## 数据与缓存

需要 Koishi `http` 服务，无需数据库。普通查询与全量缓存是两个独立入口，不会因普通查询自动拉取全表或预下载全部图片。

普通查询优先使用有效的同分支全量快照；没有或已过期时，按完整 ID 请求单条接口，或按名称调用带 `search` 的筛选接口，只缓存本次查询的结果。旧名称只补查对应的条目 ID，已删除条目的 404 不作为结果。单次结果按分支、类型、关键词在内存中缓存，最多保留 256 组，同一查询并发共享请求；结果与全量快照默认有效期均为一小时，由 `cacheAge` 配置。未过期的完整快照还支持内部 ID 片段的本地搜索，联网查询 ID 时请使用完整 ID。

`sts2.cache` 需要权限 **3**，专门负责全量缓存：

- 默认拉取配置分支的全部中文卡牌和遗物，校验成功后原子保存至 `cache/w-sts2/data`，可用 `dataCacheDir` 更改；重启后仍能复用。
- 默认同时预下载全部普通卡图、升级卡图、头像及遗物图片，相同 URL 去重并复用未过期文件。即使 `showImages=false`，显式全量缓存仍预下载图片；`-t / --text` 则仅缓存文本。
- `-c / --channel stable|beta` 指定分支；`-a / --all` 同时缓存两个分支。
- 图片最多并发 3 个、每秒最多发起 4 次新下载；完成后汇报条目和图片成功、失败数量。已有任务运行时，再次调用只显示进度，不新建任务；插件卸载后停止安排新下载。

普通查询不会刷新全量快照，全量快照也不会被某次查询的局部结果覆盖。刷新失败时，查询仅回退到本次查询或同分支全量快照的上次成功数据，并注明时间；没有可用数据则报错，不使用其它分支替代。失败后至少退避一分钟，并尊重服务端 `Retry-After`。没有后台重试或自动全量加载。

可配置 `apiKey`（私密字段），使用 Spire Codex 的 `X-API-Key`。无 Key 也可查询，长期部署建议申请自己的 Key。接口限额以 [上游最新文档](https://spire-codex.com/developers) 为准。

默认发送中文完整卡图，缺少对应卡图时回退头像。`showImages=false` 可全局关闭图片。

普通查询只按需下载本次选中的图片，缓存到 Koishi 工作目录下的 `cache/w-sts2/images`，可通过 `imageCacheDir` 更改。缓存跨重启复用，默认一天后在下次查询或全量缓存时刷新，期限由 `imageCacheAge` 设置；stable / beta 与不同来源 URL 分别缓存，同一图片的并发请求共享下载。候选列表、普通查询的 `-t` 和 `showImages=false` 不触发图片下载。

发送的是缓存图片的原始字节，不要求远端适配器访问 Koishi 本地文件，也不转换格式或移除动画。刷新失败时使用旧图并注明；没有可用旧图则仅发送文字并提示，失败后至少退避一分钟并尊重 `Retry-After`。磁盘写入失败不阻止本次已下载图片的发送。

仅下载来源站点允许的 HTTPS 图片，不跟随重定向；支持 WebP、PNG、JPEG、GIF，单张最多 10 MiB。缓存目录没有后台清理，过期文件保留供刷新失败时回退，可手动删除该目录清空缓存；下次查询会重新下载。

初次数据审计见 [docs/data-audit.md](docs/data-audit.md)。本插件代码为 MIT；第三方游戏数据、美术不因此获得 MIT 授权，需遵守各来源条款。

## 开发

在 Koishi 开发工作区中：

```sh
yarn workspace koishi-plugin-w-sts2 check
yarn workspace koishi-plugin-w-sts2 lint
yarn workspace koishi-plugin-w-sts2 test
yarn workspace koishi-plugin-w-sts2 audit:data
yarn workspace koishi-plugin-w-sts2 build
```

`build` / `bump` / `pub` 是开发工作区入口，不是独立包 CI 的构建实现。
