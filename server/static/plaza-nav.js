// 公开页共用：顶部「用智能体 / 开发者」切换、开发者二级导航和页尾导引的文案。
// 各页的 Vue 文案对象合并 window.TBNAV[lang] 即可。
(function () {
  window.TBNAV = {
    zh: {
      modeUse: '用智能体', modeDev: '开发者',
      appPlaza: '智能体广场', appMarket: '资源市场', appNetwork: '共享网络', appCircles: '圈子', appAbout: '了解产品', openPlaza: '打开智能体广场', openMarket: '打开资源市场', openNetwork: '看实时网络',
      dOverview: '概览', dManage: '统一管理', dMarket: '资源市场', dShare: '分享与收益', dCircles: '圈子协作',
      signIn: '登录', account: '我的账户', download: '下载客户端', home: '首页',
      whoKicker: 'WHO ARE YOU', whoTitle: '你是哪一类用户？',
      who: [
        { href: '/why', k: '普通用户', t: '让智能体帮我把事办成', d: '像打车一样：挑一个高手调好的智能体，说清要做什么，网页里就能用。', cta: '去智能体广场' },
        { href: '/dev', k: '开发者', t: '智能体应用工厂', d: '统一管理 runtime 和模型，把应用架在上面；分享出去分摊费用，从市场拿资源加工后上架。', cta: '进入开发者中心' },
      ],
      devKicker: 'FOR DEVELOPERS', devTitle: '开发者的三件事',
      dev: [
        { href: '/harness', n: '01', t: '统一管理', d: '智能体纳管、一键换模型、场景路由、Trace、资产、用量看板、跨端归集，一个界面、一套接口。' },
        { href: '/share', n: '02', t: '分享与收益', d: '把智能体和模型分享给自己、圈子或全网，分摊费用，一起协作。' },
        { href: '/market', n: '03', t: '资源市场', d: '公开或圈子内的模型、Skill、模板，自用或加工上架。' },
      ],
    },
    en: {
      modeUse: 'Use agents', modeDev: 'Developers',
      appPlaza: 'Agent Plaza', appMarket: 'Market', appNetwork: 'Network', appCircles: 'Circles', appAbout: 'About', openPlaza: 'Open the Agent Plaza', openMarket: 'Open the market', openNetwork: 'See the live network',
      dOverview: 'Overview', dManage: 'Manage', dMarket: 'Market', dShare: 'Share & earn', dCircles: 'Circles',
      signIn: 'Sign in', account: 'My account', download: 'Download', home: 'Home',
      whoKicker: 'WHO ARE YOU', whoTitle: 'Which kind of user are you?',
      who: [
        { href: '/why', k: 'Everyday user', t: 'Get an agent to do the job', d: 'Like hailing a ride: pick an agent an expert tuned, say what you need, use it in the browser.', cta: 'Go to the Agent Plaza' },
        { href: '/dev', k: 'Developer', t: 'An agent app factory', d: 'Manage runtimes and models and build apps on top; share to split costs, remix market resources and list them.', cta: 'Open the developer hub' },
      ],
      devKicker: 'FOR DEVELOPERS', devTitle: 'Three things developers do here',
      dev: [
        { href: '/harness', n: '01', t: 'Manage', d: 'Agent onboarding, model swap, scene routing, trace, assets, usage dashboards and cross-device roll-up — one UI, one API.' },
        { href: '/share', n: '02', t: 'Share & earn', d: 'Share agents and models with yourself, a circle or everyone; split costs and collaborate.' },
        { href: '/market', n: '03', t: 'Market', d: 'Public or circle-only models, skills and templates to use or remix.' },
      ],
    },
  };
})();
