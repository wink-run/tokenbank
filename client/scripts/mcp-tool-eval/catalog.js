// MCP 工具选择评测：模拟的第三方 MCP 目录。
// small = 任务会用到的 4 个 MCP（约 16 个工具）；large = 再加 10 个干扰的（约 60 个工具），里面有意放了用途相近的。
'use strict';

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });

const SERVERS = [
  // ── 任务会用到的 ──────────────────────────────────────────────
  {
    name: 'github', description: 'GitHub：仓库、issue、pull request', small: true,
    tools: [
      { name: 'create_issue', description: 'Create a new issue in a GitHub repository', inputSchema: S({ owner: str('Repository owner'), repo: str('Repository name'), title: str('Issue title'), body: str('Issue body') }, ['owner', 'repo', 'title']) },
      { name: 'list_issues', description: 'List issues in a GitHub repository, optionally filtered by state or labels', inputSchema: S({ owner: str('Repository owner'), repo: str('Repository name'), state: { type: 'string', enum: ['open', 'closed', 'all'] }, labels: { type: 'array', items: { type: 'string' } } }, ['owner', 'repo']) },
      { name: 'search_issues', description: 'Search issues and pull requests across GitHub with a search query', inputSchema: S({ q: str('GitHub search query, e.g. "memory leak repo:owner/name"') }, ['q']) },
      { name: 'create_pull_request', description: 'Create a new pull request', inputSchema: S({ owner: str('Repository owner'), repo: str('Repository name'), title: str('PR title'), head: str('Branch with changes'), base: str('Branch to merge into'), body: str('PR description') }, ['owner', 'repo', 'title', 'head', 'base']) },
      { name: 'get_pull_request', description: 'Get details of a pull request', inputSchema: S({ owner: str('Repository owner'), repo: str('Repository name'), pull_number: num('PR number') }, ['owner', 'repo', 'pull_number']) },
      { name: 'add_issue_comment', description: 'Add a comment to an issue or pull request', inputSchema: S({ owner: str('Repository owner'), repo: str('Repository name'), issue_number: num('Issue or PR number'), body: str('Comment text') }, ['owner', 'repo', 'issue_number', 'body']) },
    ],
  },
  {
    name: 'brave-search', description: '网页搜索', small: true,
    tools: [
      { name: 'brave_web_search', description: 'Search the web for pages, news and articles', inputSchema: S({ query: str('Search query'), count: num('Number of results, max 20') }, ['query']) },
      { name: 'brave_local_search', description: 'Search for local businesses and places near a location', inputSchema: S({ query: str('What and where, e.g. "coffee near Shanghai Jing\'an"') }, ['query']) },
    ],
  },
  {
    name: 'fetch', description: '抓取网页内容', small: true,
    tools: [
      { name: 'fetch', description: 'Fetch a URL and return its content as markdown', inputSchema: S({ url: str('URL to fetch'), max_length: num('Maximum characters to return') }, ['url']) },
    ],
  },
  {
    name: 'slack', description: 'Slack 消息和频道', small: true,
    tools: [
      { name: 'slack_post_message', description: 'Post a new message to a Slack channel', inputSchema: S({ channel: str('Channel name or id, e.g. #general'), text: str('Message text') }, ['channel', 'text']) },
      { name: 'slack_list_channels', description: 'List public channels in the workspace', inputSchema: S({ limit: num('Max channels') }) },
      { name: 'slack_get_channel_history', description: 'Get recent messages from a channel', inputSchema: S({ channel: str('Channel name or id'), limit: num('Number of messages') }, ['channel']) },
      { name: 'slack_reply_to_thread', description: 'Reply to a specific message thread', inputSchema: S({ channel: str('Channel'), thread_ts: str('Timestamp of the parent message'), text: str('Reply text') }, ['channel', 'thread_ts', 'text']) },
      { name: 'slack_add_reaction', description: 'Add an emoji reaction to a message', inputSchema: S({ channel: str('Channel'), timestamp: str('Message timestamp'), reaction: str('Emoji name without colons') }, ['channel', 'timestamp', 'reaction']) },
      { name: 'slack_get_users', description: 'List users in the workspace', inputSchema: S({ limit: num('Max users') }) },
      { name: 'slack_get_user_profile', description: 'Get a user profile', inputSchema: S({ user_id: str('User id') }, ['user_id']) },
    ],
  },
  // ── 干扰的（large 才有）──────────────────────────────────────
  {
    name: 'gitlab', description: 'GitLab：项目、issue、merge request',
    tools: [
      { name: 'create_issue', description: 'Create a new issue in a GitLab project', inputSchema: S({ project_id: str('Project path or id'), title: str('Title'), description: str('Description') }, ['project_id', 'title']) },
      { name: 'list_issues', description: 'List issues in a GitLab project', inputSchema: S({ project_id: str('Project path or id'), state: str('opened or closed') }, ['project_id']) },
      { name: 'create_merge_request', description: 'Create a merge request', inputSchema: S({ project_id: str('Project'), title: str('Title'), source_branch: str('Source'), target_branch: str('Target') }, ['project_id', 'title', 'source_branch', 'target_branch']) },
      { name: 'search_repositories', description: 'Search GitLab projects', inputSchema: S({ search: str('Query') }, ['search']) },
    ],
  },
  {
    name: 'linear', description: 'Linear 任务管理',
    tools: [
      { name: 'create_issue', description: 'Create a Linear issue in a team', inputSchema: S({ team: str('Team key'), title: str('Title'), description: str('Description') }, ['team', 'title']) },
      { name: 'search_issues', description: 'Search Linear issues by text', inputSchema: S({ query: str('Query') }, ['query']) },
      { name: 'update_issue', description: 'Update status, assignee or priority of a Linear issue', inputSchema: S({ id: str('Issue id'), status: str('New status'), assignee: str('Assignee') }, ['id']) },
    ],
  },
  {
    name: 'tavily', description: 'AI 搜索与网页提取',
    tools: [
      { name: 'tavily_search', description: 'AI-optimized web search returning summarized results', inputSchema: S({ query: str('Query'), max_results: num('Max results') }, ['query']) },
      { name: 'tavily_extract', description: 'Extract the main content from one or more URLs', inputSchema: S({ urls: { type: 'array', items: { type: 'string' } } }, ['urls']) },
    ],
  },
  {
    name: 'puppeteer', description: '浏览器自动化',
    tools: [
      { name: 'puppeteer_navigate', description: 'Open a URL in the browser', inputSchema: S({ url: str('URL') }, ['url']) },
      { name: 'puppeteer_screenshot', description: 'Take a screenshot of the current page', inputSchema: S({ name: str('Screenshot name') }, ['name']) },
      { name: 'puppeteer_click', description: 'Click an element', inputSchema: S({ selector: str('CSS selector') }, ['selector']) },
      { name: 'puppeteer_fill', description: 'Fill an input field', inputSchema: S({ selector: str('CSS selector'), value: str('Value') }, ['selector', 'value']) },
      { name: 'puppeteer_evaluate', description: 'Run JavaScript in the page', inputSchema: S({ script: str('JavaScript') }, ['script']) },
    ],
  },
  {
    name: 'gmail', description: '邮件',
    tools: [
      { name: 'send_email', description: 'Send an email', inputSchema: S({ to: str('Recipient'), subject: str('Subject'), body: str('Body') }, ['to', 'subject', 'body']) },
      { name: 'search_emails', description: 'Search emails with Gmail query syntax', inputSchema: S({ query: str('Query') }, ['query']) },
      { name: 'read_email', description: 'Read an email by id', inputSchema: S({ id: str('Message id') }, ['id']) },
      { name: 'draft_email', description: 'Create an email draft', inputSchema: S({ to: str('Recipient'), subject: str('Subject'), body: str('Body') }, ['to', 'subject']) },
    ],
  },
  {
    name: 'discord', description: 'Discord 消息',
    tools: [
      { name: 'send_message', description: 'Send a message to a Discord channel', inputSchema: S({ channel_id: str('Channel id'), content: str('Message') }, ['channel_id', 'content']) },
      { name: 'read_messages', description: 'Read recent messages in a Discord channel', inputSchema: S({ channel_id: str('Channel id'), limit: num('Count') }, ['channel_id']) },
      { name: 'add_reaction', description: 'React to a Discord message', inputSchema: S({ channel_id: str('Channel'), message_id: str('Message'), emoji: str('Emoji') }, ['channel_id', 'message_id', 'emoji']) },
    ],
  },
  {
    name: 'notion', description: 'Notion 文档',
    tools: [
      { name: 'notion_search', description: 'Search Notion pages and databases', inputSchema: S({ query: str('Query') }, ['query']) },
      { name: 'notion_create_page', description: 'Create a Notion page', inputSchema: S({ parent_id: str('Parent page id'), title: str('Title'), content: str('Markdown content') }, ['parent_id', 'title']) },
      { name: 'notion_append_block', description: 'Append content to a page', inputSchema: S({ page_id: str('Page id'), content: str('Markdown') }, ['page_id', 'content']) },
      { name: 'notion_query_database', description: 'Query a Notion database with filters', inputSchema: S({ database_id: str('Database id'), filter: { type: 'object' } }, ['database_id']) },
    ],
  },
  {
    name: 'google-calendar', description: '日历',
    tools: [
      { name: 'list_events', description: 'List calendar events in a time range', inputSchema: S({ time_min: str('ISO start'), time_max: str('ISO end') }, ['time_min', 'time_max']) },
      { name: 'create_event', description: 'Create a calendar event', inputSchema: S({ summary: str('Title'), start: str('ISO start'), end: str('ISO end'), attendees: { type: 'array', items: { type: 'string' } } }, ['summary', 'start', 'end']) },
      { name: 'find_free_time', description: 'Find free slots for attendees', inputSchema: S({ attendees: { type: 'array', items: { type: 'string' } }, duration_minutes: num('Duration') }, ['attendees', 'duration_minutes']) },
    ],
  },
  {
    name: 'postgres', description: '数据库',
    tools: [
      { name: 'query', description: 'Run a read-only SQL query', inputSchema: S({ sql: str('SQL') }, ['sql']) },
      { name: 'list_tables', description: 'List tables in the database', inputSchema: S({ schema: str('Schema name') }) },
      { name: 'describe_table', description: 'Show the columns of a table', inputSchema: S({ table: str('Table') }, ['table']) },
    ],
  },
  {
    name: 'filesystem', description: '本地文件',
    tools: [
      { name: 'read_file', description: 'Read a file from disk', inputSchema: S({ path: str('Path') }, ['path']) },
      { name: 'write_file', description: 'Write a file to disk', inputSchema: S({ path: str('Path'), content: str('Content') }, ['path', 'content']) },
      { name: 'list_directory', description: 'List a directory', inputSchema: S({ path: str('Path') }, ['path']) },
      { name: 'search_files', description: 'Search files by name pattern', inputSchema: S({ path: str('Root'), pattern: str('Glob') }, ['path', 'pattern']) },
      { name: 'move_file', description: 'Move or rename a file', inputSchema: S({ source: str('From'), destination: str('To') }, ['source', 'destination']) },
      { name: 'get_file_info', description: 'Get file metadata', inputSchema: S({ path: str('Path') }, ['path']) },
    ],
  },
  {
    name: 'weather', description: '天气',
    tools: [
      { name: 'get_forecast', description: 'Get the weather forecast for a city', inputSchema: S({ city: str('City'), days: num('Days') }, ['city']) },
      { name: 'get_alerts', description: 'Get active weather alerts for a region', inputSchema: S({ region: str('Region') }, ['region']) },
    ],
  },
  {
    name: 'stripe', description: '支付',
    tools: [
      { name: 'list_customers', description: 'List Stripe customers', inputSchema: S({ email: str('Filter by email') }) },
      { name: 'create_payment_link', description: 'Create a Stripe payment link', inputSchema: S({ product: str('Product name'), amount: num('Amount in cents'), currency: str('Currency') }, ['product', 'amount', 'currency']) },
      { name: 'list_invoices', description: 'List invoices', inputSchema: S({ customer: str('Customer id') }) },
    ],
  },
];

function serversFor(size) {
  return size === 'small' ? SERVERS.filter((s) => s.small) : SERVERS;
}

function countTools(size) {
  return serversFor(size).reduce((n, s) => n + s.tools.length, 0);
}

module.exports = { SERVERS, serversFor, countTools };
