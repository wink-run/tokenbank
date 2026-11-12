# Token Bank 宣传视频

成片默认输出到 `out/tokenbank-promo.mp4`（中文）/ `out/tokenbank-promo-en.mp4`（英文）/ `out/tokenbank-promo-cine.mp4`（电影感版）。78.5 秒 · 1920×1080 · 30fps · H.264 + AAC，配乐为代码合成（无版权素材）。渲染产物为大体积二进制，已加入 `.gitignore`，不会提交到仓库；如需在官网 `#film` 区块播放，请在部署流程中手动复制到 `server/static/video/`，而不要直接提交。

## 分镜

| 时间 | 段落 | 画面 | 声音 |
|---|---|---|---|
| 0–7s | 痛点开场 | 六个痛点快切（每个配一行说明 +「痛点 n / 6」）：AI 工具越装越多 / 账单越来越长 / 额度月底清零 / Skill·MCP 越装越乱 / 好模型用不起 / 闲置能力白白浪费 → 「你的 AI，**该有个管家了**」，收缩成金点 | 低频 drone + 时钟滴答，每个痛点一记重击，答案句 impact + riser |
| 7–11.5s | Logo 揭幕 | 金币 Logo 3D 翻转入场，P2P 网格连线逐条绘出，高光扫过；「Token Bank · 你的个人 AI 中枢」 | 爆点 impact + 钟琴琶音 |
| 11.5–18s | 01 一键纳管 | Claude Code / Codex / Cursor / WorkBuddy / Kimi Code / OpenClaw 依次开关点亮，光流汇入本地网关 `localhost:11430/v1` | 120 BPM 节拍进入，开关音阶上行 |
| 18–24.5s | 02 用的明白 | 用量仪表盘：Token 计数、按小时柱状图、实时 Trace 流 | 轻微数据滴答 |
| 24.5–32s | 03 用的节省 | 三个请求经智能路由分发到本地模型 / 免费额度 / 社区算力，模型名不变、协议自动转换、花费 ¥0 | 路由“嗖”声 + 命中铃音 |
| 32–38s | 04 越用越懂你 | 工作画像雷达图生长，MCP / Skill / Prompt / Agent 个性化推荐一键添加 | 添加提示音 |
| 38–44.5s | 05 AI 资产 · 一处纳管 | 散落在各工具里的 MCP / Skill / Prompt / Agent 配置文件（重复、版本不一致、忘了放哪）飞入统一资产库：分类 Tab、搜索、来源应用一目了然 | 杂乱 glitch → 归位 whoosh + 落位音阶 |
| 44.5–51s | 06 资源投射 | Skill / MCP / Prompt / Agent 经「投射门控」投射到已纳管且已安装的 Claude Code / Codex / Cursor / Kimi Code，未安装的 Trae 被跳过 | 汇聚 whoosh + 门控铃音 + 逐个命中 |
| 51–57.5s | 07 游乐场 · 智能体编排 | 一句话任务（含截图）交给主 Agent，经 `tb_dispatch_agent` 并行派发给 Codex、Kimi Code 与远端执行的社区智能体，结果回流合并 | 打字声 + 派发 zap + 完成铃音 |
| 57.5–66.5s | 08 共享市场 · 闲置赚钱 | 双边市场：出租方上架闲置订阅额度 / 内网私有模型 / 智能体（只公开名片），API Key、Skill、Prompt、配置锁在「本机保险箱」、任务在本机执行只回传结果；使用方按次付积分租用稀有模型、雇佣智能体解决问题；出租方积分实时增长 | 任务 / 结果往返 whoosh + 保险箱微光 + 金币音 |
| 66.5–71.5s | 五条主线 | 用的明白 · 用的节省 · 用的简单 · 越用越懂你 · 闲置赚钱（中英双语，每秒一击） | 每词一次重击 |
| 71.5–78.5s | 结尾 | Logo + Slogan +「开源 · 不改使用习惯 · 随时一键还原」+ 平台 +「免费下载」官网 `tokenbank.wink.run` + GitHub `github.com/wink-run/tokenbank`（正片期间右下角常驻官网水印） | 终章 impact，淡出 |

画面中的用量、积分等数字均为演示用示意数据。

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
- 修改文案 / 时长：编辑 `video.html` 中对应场景的 DOM 与 `renderFrame` 分段；配乐的 cue 点在 `soundtrack.py` 中与之对齐。
