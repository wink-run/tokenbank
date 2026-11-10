import React from 'react';
import { useLang } from '../store/lang';
import GuardianPanel from '../components/GuardianPanel';

/**
 * 自我进化页：侧边栏 Logo 旁的小圆点、设置页的「看护设置」都跳到这里。
 * 运行环境、各类处理方式、定期自省、自动处理记录都在这一页，设置页只留一个入口。
 */
export default function Guardian() {
  const { t } = useLang();
  return (
    <div className="px-4 py-4 space-y-4 w-full max-w-4xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">{t('guardian.title')}</h1>
        <p className="text-sm text-gray-500 mt-0.5">{t('guardian.pageHint')}</p>
      </div>
      <GuardianPanel page />
    </div>
  );
}
