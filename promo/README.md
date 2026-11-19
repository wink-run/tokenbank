# Token Bank 宣传视频

成片默认输出到 `out/tokenbank-promo.mp4`（中文）/ `out/tokenbank-promo-en.mp4`（英文）/ `out/tokenbank-promo-cine.mp4`（电影感版）。117 秒 · 1920×1080 · 30fps · H.264 + AAC，配乐为代码合成（无版权素材）。渲染产物为大体积二进制，已加入 `.gitignore`，不会提交到仓库；如需在官网 `#film` 区块播放，请在部署流程中手动复制到 `server/static/video/`，而不要直接提交。

## 分镜

| 时间 | 段落 | 画面 | 声音 |
|---|---|---|---|
| 0–7s | 痛点开场 | 六个痛点快切（每个配一行说明 +「痛点 n / 6」）：AI 工具越装越多 / 账单越来越长 / 智能体各跑各的 / Skill·MCP 越装越乱 / 出了问题全靠自己查 / 闲置能力白白浪费 → 「你的 AI，**该有个中枢了**」，收缩成金点 | 低频 drone + 时钟滴答，每个痛点一记重击，答案句 impact + riser |
| 7–11.5s | Logo 揭幕 | 金币 Logo 3D 翻转入场，P2P 网格连线逐条绘出，高光扫过；「Token Bank · 个人 AI 中枢 · 智能体应用工厂」 | 爆点 impact + 钟琴琶音 |
| 11.5–18s | 01 统一接口 · 一把 Key（0.7.0） | 产品后台打出 `POST /v1/agent/responses`（带 `harness_id`），经网关的两个入口（模型 `:11430/v1` · 智能体 `:11430/v1/agent`）派给四类智能体之一：通用 / 专业 / 外部 / 雇来的，专业智能体亮起「完成」 | 打字声 + 派发 zap + 完成铃音 |
| 18–24.5s | 02 外部智能体 | 配对码 TB-5315，GrokBot 照 tokenbank-connect 技能注册 → 允许 → 在线；游乐场里给它派活：等它来取 → 已取走 → 回复，它还能主动推送 | 允许铃音 + 取走 whoosh + 推送提示音 |
| 24.5–31s | 03 智能管家 | 资产里「数据库巡检」排在最前、标「有问题」→ 看一下 → 管家逐步处理（找到缺的技能 → 装好启用 → 重新投射）→ 能用、随时可撤销 | 报错低音 + 逐步提示音 + 完成和弦 |
| 31–37.5s | 04 智能体应用工厂 | 模型 / 运行时 / 资产 / 接口 / 观测 / 分发六层依次叠起，托起「你的应用」；底部：macOS · Windows 桌面版 / Linux 命令行 / Docker 网页版 · 手机可用 | 逐层音阶 + 落定 impact + riser |
| 37.5–50s | 真实界面 | 0.7.0 实际截图（深色、`localhost:11431`）在窗口框里依次推近：网关 · 外部智能体 / 网关 · 专业智能体 / 资产 / 模型 / 游乐场，每页一行说明 | 每页一声轻扫 + 铃音 |
| 50–56.5s | 05 一键纳管 | Claude Code / Codex / Cursor / WorkBuddy / Kimi Code / OpenClaw 依次开关点亮，光流汇入本地网关 `localhost:11430/v1` | 120 BPM 节拍进入，开关音阶上行 |
| 56.5–63s | 06 用的明白 | 用量仪表盘：Token 计数、按小时柱状图、实时 Trace 流 | 轻微数据滴答 |
| 63–70.5s | 07 用的节省 | 三个请求经智能路由分发到本地模型 / 免费额度 / 社区算力，模型名不变、协议自动转换、花费 ¥0 | 路由“嗖”声 + 命中铃音 |
| 70.5–76.5s | 08 越用越懂你 | 智能管家对话：「写周报」这次派给 Codex？→ 你说以后这类都给「周报助手」→ 记住了；右侧是它记下 / 发现的四条：派活偏好、误报规则、重复技能、新版本 | 记住提示音 |
| 76.5–83s | 09 AI 资产 · 一处纳管 | 散落在各工具里的 MCP / Skill / Prompt / Agent 配置文件（重复、版本不一致、忘了放哪）飞入统一资产库：分类 Tab、搜索、来源应用一目了然 | 杂乱 glitch → 归位 whoosh + 落位音阶 |
| 83–89.5s | 10 资源投射 | Skill / MCP / Prompt / Agent 经「投射门控」投射到已纳管且已安装的 Claude Code / Codex / Cursor / Kimi Code，未安装的 Trae 被跳过 | 汇聚 whoosh + 门控铃音 + 逐个命中 |
| 89.5–96s | 11 游乐场 · 智能体编排 | 一句话任务（含截图）交给主 Agent，经 `tb_dispatch_agent` 并行派发给 Codex、Kimi Code 与远端执行的社区智能体，结果回流合并 | 打字声 + 派发 zap + 完成铃音 |
| 96–105s | 12 共享市场 · 闲置赚钱 | 双边市场：出租方上架闲置订阅额度 / 内网私有模型 / 智能体（只公开名片），API Key、Skill、Prompt、配置锁在「本机保险箱」、任务在本机执行只回传结果；使用方按次付积分租用稀有模型、雇佣智能体解决问题；出租方积分实时增长 | 任务 / 结果往返 whoosh + 保险箱微光 + 金币音 |
| 105–110s | 五条主线 | 用的明白 · 用的节省 · 用的简单 · 越用越懂你 · 闲置赚钱（中英双语，每秒一击） | 每词一次重击 |
| 110–117s | 结尾 | Logo +「个人 AI 中枢 · 智能体应用工厂」+「开源 · 不改使用习惯 · 随时一键还原」+ 平台 +「免费下载」官网 `tokenbank.wink.run` + GitHub `github.com/wink-run/tokenbank`（正片期间右下角常驻官网水印） | 终章 impact，淡出 |

画面中的用量、积分等数字均为演示用示意数据；「真实界面」一段是 Docker 版的实际截图，图片在 `shots/`（中英各一套），可用同样页面重新截取替换。

## 重新生成

整条片子是一个确定性的 HTML 时间轴（`video.html` 中的 `renderFrame(t)`），逐帧截图后用 ffmpeg 编码。

```bash
cd promo
npm install                      # 字体：Inter / Noto Sans SC / JetBrains Mono
pip install numpy scipy          # 配乐合成
python3 soundtrack.py            # -> out/soundtrack.wav
node render.mjs --stills         # 可选：导出关键帧预览 -> out/stills/
FFMPEG=/path/to/ffmpeg node render.mjs   # -> out/tokenbank-promo.mp4（需 libx264）
```

- 浏览器实时预览：用本地静态服务器打开 `video.html?play`（英文版 `video.html?lang=en&play`）。
- 电影感版本：`CINE=1 python3 soundtrack.py && CINE=1 node render.mjs` → `out/tokenbank-promo-cine.mp4`。在同一时间轴上叠加 2.39:1 宽银幕黑边、虚拟摄影机（推镜 / UI 镜头 3D 横移 / 手持微晃）、青橙调色、胶片颗粒、前景光斑、变形镜头光晕与段落间黑场硬切；配乐换成太鼓 + braam + 弦乐的预告片风格。可与 `LANG_EN=1` 叠加。
- 英文版：`LANG_EN=1 node render.mjs` → `out/tokenbank-promo-en.mp4`（`LANG_EN=1 node render.mjs --stills` 导出英文关键帧）。文案对照表在 `video.html` 的 `I18N` 中。
- 需要 Playwright（Chromium）；ffmpeg 需带 libx264，可用 `pip install imageio-ffmpeg` 获取。
- 0.7.0 章节（01–04）紧跟 Logo，在 `video.html` 里是一段插入：`V7_AT`/`V7_LEN` 之间由 `renderV7` 渲染，之后的老时间轴整体后移 `V7_LEN` 秒；配乐里对应 `V7_AT` / `V7`（`SHIFT` 打开时 `place()` 自动后移）。电影感版的镜头调度还没为这一段单独设计。
- 修改文案 / 时长：编辑 `video.html` 中对应场景的 DOM 与 `renderFrame` 分段；配乐的 cue 点在 `soundtrack.py` 中与之对齐。
