# dsh-miu-music

给 DeepSeek Harness 里的 agent 一对**耳朵**：让它知道你在听什么歌、能取到歌词、能搜歌、能切歌，还能按名字点播。

不是"播放器插件"——它不内置播放器，而是**读系统媒体状态 + 驱动 QQ 音乐**。

```
你："我在听什么"
她：（听了两秒）在放《晴天》，周杰伦的，第二段主歌那块。

你："帮我放一首适合下雨天的"
她：找到了三首，Miu 放第一首了——《雨爱》杨丞琳。
```

---

## 五个工具

| 工具 | 作用 |
|---|---|
| `miu_music_now` | 现在在听什么：歌名、歌手、进度、播放状态 |
| `miu_music_lyric` | 按歌名取歌词正文（可只取开头一段） |
| `miu_music_search` | 搜歌，返回歌名 / 歌手 / 专辑 / 时长 |
| `miu_music_play` | 点播：在 QQ 音乐里搜出来并播放 |
| `miu_music_control` | `next` / `prev` / `pause` |

---

## 安装

```bash
# 在 DSH 里
plugin_manager install_bundle <这个仓库的路径或 npm 包名>
```

或者手动放进 profile 的 `node_modules`，再在 `cordis.patch.yml` 里 insert。

---

## 原理（也是它的限制）

**1. 播放状态走 Windows SMTC**

系统媒体控制（System Media Transport Controls）。任何支持 SMTC 的播放器都能读到——**不只是 QQ 音乐**，Spotify、网易云、浏览器里的 B站/YouTube 也能读。

所以 `miu_music_now` 其实是"系统层面现在在放什么"，不只 QQ 音乐。

**1.5 读取优先级（很重要）**

Windows 的 SMTC 允许多个播放器同时注册会话，而 `GetCurrentSession()` 返回的是"最后一次活跃"的那个——
浏览器里放个视频就能把音乐播放器盖掉。所以本插件不是直接用它，而是：

1. 枚举所有媒体会话，优先 **状态是 Playing 的**
2. 其中优先**音乐播放器**（QQMusic / Spotify / 网易云 / 酷狗 / foobar2000）
3. 如果播放器**不往 SMTC 上报**（QQ 音乐有些版本如此），退回读**播放器窗口标题**（`歌名 - 歌手`）
4. 都没有才用 SMTC 的当前会话

窗口标题这条兜底拿不到播放进度（`position/duration` 会是 -1），会带 `note` 说明来源。

**2. 歌词和搜索走 QQ 音乐的公开接口**

`u.y.qq.com/cgi-bin/musicu.fcg`，POST，**不需要登录、不需要 cookie**。所以搜歌和歌词在任何机器上都能用。

**3. 点播是模拟 UI 操作（最脆的一环）**

`miu_music_play` 会：把 QQ 音乐窗口调到前台 → 搜索 → 点第一首。

- QQ 音乐改版、换分辨率、窗口被遮挡，都可能失效
- 失败时工具会**明确返回失败**，不会假装播上了
- 它会抢焦点，所以 agent 应该在你没在忙的时候用

**4. 平台**

只支持 **Windows**。SMTC 读取和 UI 自动化都是 Windows 的东西；非 Windows 会直接抛错。

---

## 需要什么

- Windows 10 / 11
- [Node.js](https://nodejs.org/) 18+
- PowerShell 5.1（系统自带）
- 想用点播的话：装了 QQ 音乐（装在别处也能用 QQMUSIC_EXE 环境变量指定路径）

---

## 给 agent 的用法建议

插件本身不含人格。如果你把它接给自己的角色，建议在人格里写清三件事：

1. **别主动翻**——主人没提音乐时不要去查他在听什么
2. **切歌要授权**——只有主人明说让你动才按 next/prev/pause
3. **点播可能失败**——失败就照实说"没播上"，不要假装成功

这三条能让它不像个监控工具，而像真的在旁边听着。

---

## 隐私

- 不联网上报任何东西
- 歌词/搜索请求只发到 QQ 音乐的公开接口，不带你的账号
- 播放状态只在本机读，不落盘

---

## License

MIT
