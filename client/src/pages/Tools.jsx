import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import { api } from '../api/adapter';

export default function Tools() {
  const { t } = useLang();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState([]);
  const [scenes, setScenes] = useState([]);
  const [selectedScene, setSelectedScene] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    loadTools();
  }, [selectedScene, searchQuery]);

  const loadTools = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedScene) params.append('scene', selectedScene);
      if (searchQuery) params.append('search', searchQuery);
      params.append('limit', '20');
      
      const response = await api.get(`/api/tools/discover?${params.toString()}`);
      setTools(response.tools || []);
      if (response.scenes) {
        setScenes(response.scenes);
      }
    } catch (error) {
      console.error('Failed to load tools:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    loadTools();
  };

  const getTrustBadge = (trustLevel) => {
    const badges = {
      official: { text: '官方', color: 'bg-blue-500' },
      verified: { text: '认证', color: 'bg-green-500' },
      community: { text: '社区', color: 'bg-gray-500' },
    };
    return badges[trustLevel] || badges.community;
  };

  return (
    <div className="tb-page-container min-h-full bg-gradient-to-br from-zinc-50 to-white dark:from-zinc-900 dark:to-zinc-800">
      <div className="max-w-7xl mx-auto px-6 py-10">
        {/* 页头 - 消费者友好的调性 */}
        <div className="mb-10 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 mb-4 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-full text-sm font-medium">
            <span>🎯</span>
            <span>打开就能用</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-zinc-900 dark:text-white mb-4 tracking-tight">
            {t('tools.title')}
          </h1>
          <p className="text-lg text-zinc-600 dark:text-zinc-400 max-w-3xl mx-auto leading-relaxed">
            {t('tools.subtitle')}
          </p>
        </div>

        {/* 搜索框 - 更大更友好 */}
        <div className="mb-8 max-w-2xl mx-auto">
          <form onSubmit={handleSearch} className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('tools.searchPlaceholder')}
              className="w-full px-6 py-4 pr-14 rounded-2xl border-2 border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white text-lg placeholder-zinc-400 focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all shadow-sm hover:shadow-md"
            />
            <button
              type="submit"
              className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-zinc-400 hover:text-blue-500 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
            </button>
          </form>
        </div>

        {/* 场景筛选 - 横向滚动胶囊 */}
        {scenes.length > 0 && (
          <div className="mb-10 overflow-x-auto scrollbar-hide">
            <div className="flex gap-3 pb-2 justify-center">
              <button
                onClick={() => setSelectedScene('')}
                className={`px-5 py-2.5 rounded-full whitespace-nowrap font-medium transition-all ${
                  selectedScene === ''
                    ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30'
                    : 'bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700'
                }`}
              >
                {t('tools.allScenes')}
              </button>
              {scenes.map((scene) => (
                <button
                  key={scene.value}
                  onClick={() => setSelectedScene(scene.value)}
                  className={`px-5 py-2.5 rounded-full whitespace-nowrap font-medium transition-all ${
                    selectedScene === scene.value
                      ? 'bg-blue-500 text-white shadow-lg shadow-blue-500/30'
                      : 'bg-white dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  {scene.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* 产品理念说明卡片 */}
        <div className="mb-10 p-6 rounded-2xl bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-blue-200 dark:border-blue-800">
          <h3 className="text-lg font-bold text-zinc-900 dark:text-white mb-3">
            💡 {t('tools.howItWorks')}
          </h3>
          <div className="space-y-2 text-sm text-zinc-700 dark:text-zinc-300">
            <p>{t('tools.step1')}</p>
            <p>{t('tools.step2')}</p>
            <p>{t('tools.step3')}</p>
            <p>{t('tools.step4')}</p>
          </div>
          <p className="mt-3 pt-3 border-t border-blue-200 dark:border-blue-800 text-sm text-blue-700 dark:text-blue-300 font-medium">
            {t('tools.benefit')}
          </p>
        </div>

        {/* 工具网格 */}
        {loading ? (
          <div className="text-center py-12 text-zinc-500 dark:text-zinc-400">
            {t('common.loading')}
          </div>
        ) : tools.length === 0 ? (
          <div className="text-center py-12 text-zinc-500 dark:text-zinc-400">
            {t('tools.noTools')}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {tools.map((tool) => {
              const badge = getTrustBadge(tool.trust_level);
              return (
                <div
                  key={tool.id}
                  onClick={() => navigate(`/tools/${tool.id}`)}
                  className="group relative tb-press p-6 rounded-3xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 hover:shadow-2xl hover:scale-[1.02] hover:border-blue-300 dark:hover:border-blue-700 cursor-pointer transition-all duration-300"
                >
                  {/* 精选角标 */}
                  {tool.featured === 1 && (
                    <div className="absolute top-4 right-4">
                      <span className="flex items-center gap-1 px-2.5 py-1 bg-gradient-to-r from-yellow-400 to-orange-400 text-white text-xs font-bold rounded-full shadow-lg">
                        <span>⭐</span>
                        <span>精选</span>
                      </span>
                    </div>
                  )}
                  
                  {/* 图标 */}
                  <div className="flex items-center gap-4 mb-4">
                    <div className="flex-shrink-0 w-16 h-16 flex items-center justify-center text-5xl bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-800 dark:to-zinc-900 rounded-2xl group-hover:scale-110 transition-transform">
                      {tool.icon || '🔧'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-xl font-bold text-zinc-900 dark:text-white mb-1 truncate">
                        {tool.display_name}
                      </h3>
                      <span className={`inline-block px-2.5 py-1 text-xs font-semibold text-white rounded-full ${badge.color}`}>
                        {badge.text}
                      </span>
                    </div>
                  </div>

                  {/* 描述 */}
                  <p className="text-sm text-zinc-600 dark:text-zinc-400 line-clamp-2 mb-4 leading-relaxed">
                    {tool.description}
                  </p>

                  {/* 价格栏 */}
                  <div className="flex items-center justify-between pt-3 border-t border-zinc-100 dark:border-zinc-700">
                    <div className="flex items-center gap-2 text-sm">
                      {tool.pricing_type === 'ad_or_paid' && (
                        <>
                          <span className="px-2 py-1 bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400 rounded font-medium">
                            📺 {t('tools.watchAd')}
                          </span>
                          <span className="text-zinc-400">或</span>
                          <span className="px-2 py-1 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded font-medium">
                            {tool.pricing_amount} 积分
                          </span>
                        </>
                      )}
                    </div>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5 text-zinc-400 group-hover:text-blue-500 group-hover:translate-x-1 transition-all">
                      <path d="m9 18 6-6-6-6" />
                    </svg>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
