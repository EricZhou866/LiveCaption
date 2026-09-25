# Firefox AMO 上架详细步骤

英文版的表单文案、审核员备注和构建说明在 [amo-submission.md](amo-submission.md)，
这里是按点击顺序走的中文操作手册。

> 界面文案 AMO 会不定期调整。遇到和下面描述对不上的步骤，按「这一步在问什么」
> 去理解即可，字段的实质内容不会变。

---

## 第 0 步：本地准备（5 分钟）

```bash
git pull                 # 确保在最新的 main 上
npm ci                   # 按 package-lock.json 精确安装
npm run lint             # 必须 0 error（2 个 warning 是预期内的，见第 5 步）
npm run build            # -> web-ext-artifacts/local-live-captions-1.0.0.xpi
npm run source           # -> web-ext-artifacts/source-1.0.0.zip
```

然后**亲自装一遍**再提交：`about:debugging#/runtime/this-firefox` → 载入临时附加组件 →
选 `extension/manifest.json` → 打开一个有声音的页面刷新 → 确认字幕出现、面板标题是
**Local Live Captions**。

两个产物的用途：

| 文件 | 用途 | 是否必须 |
|---|---|---|
| `local-live-captions-1.0.0.xpi` | 上传的插件包 | 必须 |
| `source-1.0.0.zip` | 给审核员的源码 | **必须**，见第 4 步 |

---

## 第 1 步：登录，进开发者后台

1. 打开 https://addons.mozilla.org/developers/
2. 用你的 **Firefox Account** 登录（没有单独的 AMO 账号，就是发布 Waveform Viewer 用的那个）
3. 右上角 **Submit a New Add-on**

---

## 第 2 步：选择分发方式

| 选项 | 含义 | 建议 |
|---|---|---|
| **On this site** | 列在 AMO 商店，可被搜索，自动更新 | ✅ 选这个 |
| On your own | 只签名不上架，自己分发安装包 | 不需要 |

选 On this site，下一步。

---

## 第 3 步：上传插件包

1. 拖入 `web-ext-artifacts/local-live-captions-1.0.0.xpi`
2. 等待自动校验（Add-on Validation）跑完
3. **兼容性**：只勾 **Firefox**，不要勾 Firefox for Android —— 这个插件没在安卓上测过，
   而且面板交互是为桌面设计的。最低版本由 manifest 里的 `strict_min_version: 128.0` 决定，
   不用手填。

校验结果里会出现 **2 个 warning**，都是 `DANGEROUS_EVAL`，来自
`extension/vendor/transformers.min.js`（onnxruntime 的 wasm 加载器用了 `Function` 构造器）。
**warning 不阻止提交**，第 5 步的备注里已经解释了它们的来源。

如果出现的是 **error**，先在本地 `npm run lint` 复现再改，不要直接重传。

---

## 第 4 步：提交源码（这一步不能跳）

校验通过后会问 **Do You Need to Submit Source Code?**

**必须选 Yes。** 规则是：只要包里含有压缩/打包/转译过的代码，就要提供源码和构建方式。
本插件的 `extension/vendor/transformers.min.js` 就是压缩过的第三方代码。

上传 `web-ext-artifacts/source-1.0.0.zip`。它是 `git archive` 出来的，不含
`node_modules`，也不含 vendor 里的二进制，只有 49 个文件、94 KB。

构建说明写在下一步的「审核备注」里（源码包里的 README 和 `docs/amo-submission.md`
也带着同样的说明，双保险）。

> 跳过这一步的后果：审核员会以 "source code required" 驳回，等于白等一轮。

---

## 第 5 步：版本信息与审核备注

**Release Notes（版本说明）**，首版可以写：

```
First release.
```

**Notes to Reviewer（给审核员的备注）** —— 直接复制 [amo-submission.md](amo-submission.md)
第 2、3 节里的两段：构建说明（`npm ci` → `npm run vendor` → `npm run build`，以及 vendor 里
两个文件的上游出处）和审核员备注（两个 eval warning 的来源、网络访问的具体内容是数据不是代码、
`capture.js` 给页面原型打补丁的原因、`<all_urls>` 是可选权限由用户主动授予）。

这段备注是这次上架最关键的东西：它提前回答了审核员一定会问的三个问题，能省掉一到两轮来回。

---

## 第 6 步：商店信息

| 字段 | 填什么 |
|---|---|
| **Name** | `Local Live Captions` |
| **Add-on URL (slug)** | `local-live-captions` |
| **Summary** | 复制 amo-submission.md 第 4 节的 Summary（≤250 字符） |
| **Description** | 复制第 4 节的 Description |
| **Categories** | 主分类 **Accessibility**；副分类 Photos, Music & Videos |
| **Tags** | captions, subtitles, accessibility, speech recognition, whisper, offline |
| **Support Email** | `EricZhou866@gmail.com` |
| **Support Site** | `https://github.com/EricZhou866/LiveCaption` |
| **License** | MIT |
| **Privacy Policy** | 勾上「有隐私政策」，把 [PRIVACY.md](../PRIVACY.md) 全文粘进去 |
| **This add-on is experimental** | 不勾 —— 功能是完整的 |

想同时上中文描述：保存后在同一页面切换语言（Locale）下拉，选「中文（简体）」，
把本文件末尾《中文本地化文案》一节粘进去。英文是必填的主语言。

---

## 第 7 步：图片

- **截图**：上传 `docs/listing/` 下的两张，顺序如下（第一张会显示在搜索结果里）

  1. `screenshot-captions.png` —— 字幕面板叠在播放器上；说明文字可写
     `Captions appear automatically over any player`
  2. `screenshot-settings.png` —— 设置页；说明文字可写
     `Pick your model, panel style and timing`

- **图标**：AMO 直接用 manifest 里的 `icons`（本插件是 SVG）。如果表单里出现单独的
  图标上传项，用 `docs/listing/icon-128.png`。

---

## 第 8 步：数据收集声明

新版 AMO 会问插件收集哪些用户数据。本插件在 manifest 里已经声明：

```json
"data_collection_permissions": { "required": ["none"] }
```

所以选 **不收集任何数据 / No data collected**，与 manifest 一致（不一致会被系统挡下）。

用户自己在设置里填远程转写地址的那种情况，已经写在审核备注和隐私政策里了，不属于
「开发者收集数据」。

---

## 第 9 步：提交，等审核

提交后状态会是 **Awaiting Review**（等待审核）或直接 **Approved**（自动通过后仍可能被抽查人工复审）。

- 自动通过：几分钟内插件页就能打开
- 人工审核：几天到一两周。含 WebAssembly、给页面原型打补丁、运行时下载模型这三点，
  基本可以预期会走人工
- 期间不要重复提交同一个版本；有问题会发邮件到 `EricZhou866@gmail.com`

审核通过后地址是：`https://addons.mozilla.org/firefox/addon/local-live-captions/`

---

## 第 10 步：之后的维护

**发新版本（推荐：一条命令）：**

1. 改代码，两处版本号一起改（`extension/manifest.json` 和 `package.json`），写好
   `docs/amo/<版本号>.json`（审核员备注 + 中英文版本说明），然后**先提交**。
2. 在终端里设置凭据（只存在于这个终端会话，不写进任何文件），再发布：

```bash
export WEB_EXT_API_KEY=你的JWT_issuer WEB_EXT_API_SECRET=你的JWT_secret
```

```bash
npm run publish:amo
```

它依次做：跑测试 → 打包 → 生成源码包 → 上传插件、源码包、审核员备注和版本说明。
源码包脚本会**拒绝**在有未提交改动、或已提交的版本号与要发布的不一致时运行——
之前就因为先打包后提交，导致源码包比插件落后一个版本。

3. **隐私政策改了的话**，还要到开发者后台手动更新商店页面的隐私政策栏（API 改不了它）。

1.4.2 的版本说明（Release Notes）可以直接用：

```
设置页新增「Use recommended settings」按钮：一键恢复最快、最稳定的语音设置，并会显示你
当前是否已在使用推荐设置。外观和字幕记录等个人选择不受影响。精度选项的说明已按实测结果
修正——此前 int4 被错误地标为最快。
```

1.4.1 的版本说明：

```
修复：在字幕进行中更换语音模型或其他引擎设置后，字幕会永久停止。另外，识别引擎卡住时
现在会自动重启而不是让字幕冻结；WebGPU 不可用或卡住时，会自动改用 CPU 继续生成字幕，
并在字幕面板上提示。
```

1.4.0 的版本说明：

```
新功能（默认关闭）：把字幕保存为文本文件。在「设置 → Transcript」中开启后，插件会在内存里
保留每个标签页的字幕；点击工具栏弹窗里的「Save transcript」或字幕面板上的 ↓ 按钮，就会把
它们写入「下载」文件夹下的 .txt 文件，每条字幕一行并带时间。不开启就什么都不保留；不点
保存就不写入任何文件；关闭标签页或关闭该功能时，对应的字幕记录会被丢弃。
```

这一版有**新的可选权限 downloads**，审核员备注（Notes to Reviewer）请用英文版文档第 5 节
1.4.0 下面那段，它说明了权限何时申请、只用于哪一次调用。隐私政策也已更新，提交时把
PRIVACY.md 的新内容同步到商店的隐私政策栏。

1.3.0 的版本说明：

```
现在能给「加载音频时未请求 CORS」的电台/新闻播放器生成字幕了——这类情况下服务器本身
其实允许跨域，只是浏览器仍然只给扩展静音数据。插件会再取一次同一条流（带 CORS），
仅用于识别；这条连接永远不会播放出来，你听到的仍是页面自己的播放器。可以在设置里关闭，
那里也写明了它会让该流的流量翻倍。

插件版本号现在显示在工具栏弹窗和设置页顶部。

修复：关闭字幕时可能抛出异常，导致 tap（以及麦克风模式下的麦克风）在标签页关闭前
一直占用。
```

1.2.1 的版本说明：

```
不再让页面静音。遇到无法捕获的媒体（跨域且未带 CORS 头的音频，新闻站的嵌入播放器很常见）
时，插件原先会退回到用 Web Audio 改道该元素，而这类媒体在 Web Audio 里只会输出静音——
结果是字幕出不来、页面播放几秒后也没声音了。现在会保持该播放器原样不动，并提示改用
麦克风模式。

修复一个会跑满 CPU 的缺陷。遇到无法捕获的媒体（跨域且未带 CORS 头的音频，新闻站的
嵌入播放器很常见）时，恢复逻辑会在音频回调里无限循环，只要标签页开着，该页面的进程
就一直满载。现在只升级一次捕获方式，提示该媒体无法生成字幕，然后停止重试。

CPU 占用大幅下降。识别默认改用 Moonshine——它的计算量随音频长度变化，而 Whisper 无论
多短都要跑满 30 秒窗口：同样的识别结果，短句只需约七分之一的计算量。在 75 秒收听场景下
实测，识别引擎的占用时间从 1.0.0 的 60% 降到 17%，而实时字幕的刷新次数反而比以前更多。

从未改过模型的老用户会自动迁移到新默认模型；你自己选过的模型不会被改动。

需要其他语言或翻译成英文时，设置里仍可选择 Whisper。
```

1.1.0 的版本说明：

```
性能：识别不再几乎连续运行——这正是 Firefox 提示「扩展拖慢浏览器」的原因。临时字幕更新
现在受 CPU 预算限制，标签页在后台时完全不做；已成句的字幕永远不会被跳过。

新增设置「CPU usage」：最流畅（等同 1.0.0）、平衡（新默认，CPU 约降三分之一）、
低（只在停顿处出整句）。

另外，没有字幕任务的页面几乎不再有开销：不跑任何定时器，音频块改用低成本探测而不是
逐块重采样。
```

开发者后台 → 该插件 → **Manage Status & Versions** → **Upload New Version**，
同样要传源码包。用户会自动更新。

**被驳回怎么办：** 邮件里会写明具体条款和需要改的点。改完提交新版本即可（版本号必须递增，
不能覆盖同号版本）。别急着申诉，多数驳回就是缺源码或备注没说清。

**收集用户反馈：** 遇到「某站没字幕」的反馈，让用户打开
设置 → Diagnostics → **Run diagnostics**，把那段 JSON 发来，比任何描述都直接。

---

## 中文本地化文案

**摘要（Summary）：**

```
给标签页里的任何声音加英文实时字幕——视频、播客、会议、直播。语音识别用 Whisper 在你自己的
浏览器里本地完成，音频不会离开你的电脑。
```

**描述（Description）：**

```
Local Live Captions 会在正在播放的标签页上叠加一个字幕面板，就像 Chrome 的 Live Caption
那样——区别是语音识别完全跑在你自己的机器上，用编译成 WebAssembly 的 Whisper 模型，在
Firefox 内部完成。

• 标签页一开始出声，字幕自动出现
• 全部本地：模型一次性下载完成后即可离线使用，音频不会被上传
• 支持普通的 <video>/<audio> 播放器、用 Web Audio 播放的站点，以及麦克风输入
  （用于通话，或 Firefox 抓不到音频的站点）
• 面板可拖动、可缩放、可调字号，深浅两种配色
• 精度与速度可选：Moonshine 最快，需要其他语言时可切换到 Whisper；支持 WebGPU 的版本可以开启
• 可用多语言模型把其他语言翻译成英文
• 也可以改用你自己的转写服务（OpenAI 兼容接口）

快捷键：Ctrl+Shift+L（macOS 为 Cmd+Shift+L）开关当前标签页的字幕。

首次运行会下载语音模型（默认约 40 MB）。Firefox 会要求你授予站点访问权限后，插件才能读取
页面音频。

已知限制：跨域且未带 CORS 头的媒体无法捕获（这种情况请用麦克风模式）；DRM 视频完全无法捕获；
字幕延迟大致等于当前这句话的长度。
```
