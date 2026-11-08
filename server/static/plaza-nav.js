// 公开页共用：顶部「用智能体 / 开发者」切换、开发者二级导航和页尾导引的文案。
// 各页的 Vue 文案对象合并 window.TBNAV[lang] 即可。
(function () {
  window.TBNAV = {
    zh: {
      modeUse: '用智能体', modeDev: '开发者',
      dOverview: '概览', dManage: '统一管理', dMarket: '资源市场', dShare: '分享与收益', dCircles: '圈子协作',
      signIn: '登录', account: '我的账户', download: '下载客户端', home: '首页',
      whoKicker: 'WHO ARE YOU', whoTitle: '你是哪一类用户？',
      who: [
        { href: '/agents', k: '普通用户', t: '让智能体帮我把事办成', d: '像打车一样：挑一个高手调好的智能体，说清要做什么，网页里就能用。', cta: '去智能体广场' },
        { href: '/dev', k: '开发者', t: '管理、分享、获取智能体和模型', d: '统一管理自己的 runtime 和模型；分享出去分摊费用；从市场拿资源，自用或加工后上架。', cta: '进入开发者中心' },
      ],
      devKicker: 'FOR DEVELOPERS', devTitle: '开发者的三件事',
      dev: [
        { href: '/harness', n: '01', t: '统一管理', d: 'Pi、Claude Code、Cursor 等 runtime 和各家模型供应商，一个界面、一套接口。' },
        { href: '/network', n: '02', t: '分享与收益', d: '把智能体和模型分享给自己、圈子或全网，分摊费用，一起协作。' },
        { href: '/market', n: '03', t: '资源市场', d: '拿别人分享的模型、Skill、智能体模板，自用或加工后上架给普通用户。' },
      ],
    },
    en: {
      modeUse: 'Use agents', modeDev: 'Developers',
      dOverview: 'Overview', dManage: 'Manage', dMarket: 'Market', dShare: 'Share & earn', dCircles: 'Circles',
      signIn: 'Sign in', account: 'My account', download: 'Download', home: 'Home',
      whoKicker: 'WHO ARE YOU', whoTitle: 'Which kind of user are you?',
      who: [
        { href: '/agents', k: 'Everyday user', t: 'Get an agent to do the job', d: 'Like hailing a ride: pick an agent an expert tuned, say what you need, use it in the browser.', cta: 'Go to the Agent Plaza' },
        { href: '/dev', k: 'Developer', t: 'Manage, share and source agents and models', d: 'One place for your runtimes and model providers; share to split costs; take resources from the market, use or remix and list them.', cta: 'Open the developer hub' },
      ],
      devKicker: 'FOR DEVELOPERS', devTitle: 'Three things developers do here',
      dev: [
        { href: '/harness', n: '01', t: 'Manage', d: 'Pi, Claude Code, Cursor and other runtimes plus every model provider — one UI, one API.' },
        { href: '/network', n: '02', t: 'Share & earn', d: 'Share agents and models with yourself, a circle or everyone; split costs and collaborate.' },
        { href: '/market', n: '03', t: 'Market', d: 'Take models, skills and agent templates others shared; use them or remix and list them for everyday users.' },
      ],
    },
  };
})();
