// MCP 工具选择评测的任务。
// expect：算对的 [MCP, 工具]（用途确实相同的都算对）；args：必须填对的参数，值是字符串时要求包含它（不分大小写），
// 数组时包含任一个就行（同一个意思的不同说法），true 只要求有值。参数名必须对。
// 模型先调只读工具查一步（找频道、看 issue）不算错，看它最后真正要做的那一步。
// named：用户点了服务名（GitHub、Slack…）；没点名的要模型自己判断用哪个。
'use strict';

const WEB_SEARCH = [['brave-search', 'brave_web_search'], ['tavily', 'tavily_search']];
const FETCH = [['fetch', 'fetch'], ['tavily', 'tavily_extract']];

const TASKS = [
  // GitHub
  { id: 'gh-create', named: true, prompt: '在 GitHub 的 wink-run/tokenbank 仓库开一个 issue，标题「设备列表刷新慢」，内容写：盘点页打开后要等 5 秒才出来设备。', expect: [['github', 'create_issue']], args: { owner: 'wink-run', repo: 'tokenbank', title: '设备列表刷新慢' } },
  { id: 'gh-list-open', named: true, prompt: '看看 GitHub 上 wink-run/tokenbank 现在还开着的 issue 有哪些。', expect: [['github', 'list_issues']], args: { owner: 'wink-run', repo: 'tokenbank' } },
  { id: 'gh-search', named: true, prompt: '在 GitHub 上搜一下有没有人报过 "electron sqlite readonly database" 这个问题。', expect: [['github', 'search_issues']], args: { q: 'readonly' } },
  { id: 'gh-pr', named: true, prompt: '给 GitHub 仓库 wink-run/tokenbank 提个 PR：把 claude/mcp-merge 分支合到 main，标题「MCP 合成一个 tokenbank」。', expect: [['github', 'create_pull_request']], args: { owner: 'wink-run', repo: 'tokenbank', head: 'claude/mcp-merge', base: 'main' } },
  { id: 'gh-pr-get', named: true, prompt: 'GitHub 上 wink-run/tokenbank 的第 42 号 PR 现在什么状态？', expect: [['github', 'get_pull_request']], args: { owner: 'wink-run', repo: 'tokenbank', pull_number: '42' } },
  { id: 'gh-comment', named: true, prompt: '在 GitHub 的 wink-run/tokenbank 第 17 号 issue 下面回复：已在 0.8.1 修复。', expect: [['github', 'add_issue_comment']], args: { owner: 'wink-run', repo: 'tokenbank', issue_number: '17', body: '0.8.1' } },
  { id: 'gh-create-implicit', named: false, prompt: '帮我在 https://github.com/wink-run/tokenbank 记一个 bug：Windows 上托盘图标不显示。', expect: [['github', 'create_issue']], args: { owner: 'wink-run', repo: 'tokenbank', title: ['托盘', 'tray'] } },
  { id: 'gh-label', named: false, prompt: 'github.com/wink-run/tokenbank 里打了 bug 标签、还没关的问题列一下。', expect: [['github', 'list_issues']], args: { owner: 'wink-run', repo: 'tokenbank' } },

  // 网页搜索 / 抓取
  { id: 'web-news', named: false, prompt: '查一下最近关于 MCP 协议新版本的新闻。', expect: WEB_SEARCH, args: { query: ['MCP', 'Model Context Protocol'] } },
  { id: 'web-named', named: true, prompt: '用 Brave 搜一下 "streamable http transport" 是什么。', expect: [['brave-search', 'brave_web_search']], args: { query: 'streamable http' } },
  { id: 'web-local', named: false, prompt: '上海静安寺附近有什么评分高的咖啡馆？', expect: [['brave-search', 'brave_local_search']], args: { query: '咖啡' } },
  { id: 'web-price', named: false, prompt: '现在 Mac mini M4 在国内官网卖多少钱？搜一下。', expect: WEB_SEARCH, args: { query: 'Mac mini' } },
  { id: 'fetch-url', named: false, prompt: '把 https://modelcontextprotocol.io/specification 这页的内容读出来给我总结。', expect: FETCH, args: { url: 'modelcontextprotocol.io' } },
  { id: 'fetch-named', named: true, prompt: '用 fetch 抓一下 https://example.com/changelog 的内容。', expect: [['fetch', 'fetch']], args: { url: 'example.com/changelog' } },
  { id: 'fetch-readme', named: false, prompt: '看看 https://raw.githubusercontent.com/wink-run/tokenbank/main/README.md 里写了哪些功能。', expect: FETCH, args: { url: 'README.md' } },

  // Slack
  { id: 'sl-post', named: true, prompt: '在 Slack 的 #release 频道发一条：0.8.1 已发布。', expect: [['slack', 'slack_post_message']], args: { channel: 'release', text: '0.8.1' } },
  { id: 'sl-history', named: true, prompt: 'Slack #support 频道最近大家在聊什么？', expect: [['slack', 'slack_get_channel_history']], args: { channel: 'support' } },
  { id: 'sl-channels', named: true, prompt: '我们 Slack 里都有哪些公开频道？', expect: [['slack', 'slack_list_channels']], args: {} },
  { id: 'sl-reply', named: true, prompt: '回复 Slack #support 里时间戳 1732500000.000100 那条消息：已经在看了。', expect: [['slack', 'slack_reply_to_thread']], args: { channel: 'support', thread_ts: '1732500000.000100', text: '在看' } },
  { id: 'sl-react', named: true, prompt: '给 Slack #release 里 1732500100.000200 那条消息点个 :tada:。', expect: [['slack', 'slack_add_reaction']], args: { channel: 'release', timestamp: '1732500100.000200', reaction: 'tada' } },
  { id: 'sl-users', named: true, prompt: 'Slack 工作区里有多少人？列一下成员。', expect: [['slack', 'slack_get_users']], args: {} },
  { id: 'sl-profile', named: true, prompt: '看一下 Slack 用户 U02ABCDEF 的资料。', expect: [['slack', 'slack_get_user_profile']], args: { user_id: 'U02ABCDEF' } },
  { id: 'sl-post-implicit', named: false, prompt: '在团队的 #general 频道（Slack）通知大家：今晚 10 点停机维护。', expect: [['slack', 'slack_post_message']], args: { channel: 'general', text: ['10', '22'] } },
  { id: 'sl-history-implicit', named: false, prompt: '#design 频道（我们用 Slack）昨天有人提到新 logo 吗？翻一下最近的消息。', expect: [['slack', 'slack_get_channel_history']], args: { channel: 'design' } },

  // 用途相近、容易选错的
  { id: 'conf-search-vs-fetch', named: false, prompt: '我只有一个地址 https://blog.example.com/post/123 ，把这篇文章的正文拿给我。', expect: FETCH, args: { url: 'blog.example.com' } },
  { id: 'conf-list-vs-search', named: true, prompt: '在 GitHub 全站搜一下标题里带 "token budget" 的 issue。', expect: [['github', 'search_issues']], args: { q: 'token budget' } },
  { id: 'conf-history-vs-post', named: true, prompt: 'Slack #release 频道上一条消息是谁发的？', expect: [['slack', 'slack_get_channel_history']], args: { channel: 'release' } },
  { id: 'conf-local-vs-web', named: false, prompt: '附近（北京三里屯）有没有能修 MacBook 的店？', expect: [['brave-search', 'brave_local_search']], args: { query: '三里屯' } },
  { id: 'conf-comment-vs-create', named: true, prompt: 'GitHub wink-run/tokenbank 的 #88 是我提的问题，帮我补充一句：只在 macOS 15 上出现。', expect: [['github', 'add_issue_comment']], args: { owner: 'wink-run', repo: 'tokenbank', issue_number: '88', body: 'macOS 15' } },
  { id: 'conf-pr-vs-issue', named: true, prompt: 'GitHub 上 wink-run/tokenbank 的 PR #120 改了哪些东西？', expect: [['github', 'get_pull_request']], args: { owner: 'wink-run', repo: 'tokenbank', pull_number: '120' } },
];

module.exports = { TASKS };
