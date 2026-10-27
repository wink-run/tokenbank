import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import { useAuth } from '../store/index';
import { api } from '../api/adapter';

export default function ToolDetail() {
  const { id } = useParams();
  const { t } = useLang();
  const { user, guest } = useAuth();
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [tool, setTool] = useState(null);
  const [gateType, setGateType] = useState('ad');
  const [processing, setProcessing] = useState(false);
  const [adWatched, setAdWatched] = useState(false);
  const [showAdModal, setShowAdModal] = useState(false);

  useEffect(() => {
    loadToolDetail();
  }, [id]);

  const loadToolDetail = async () => {
    setLoading(true);
    try {
      const response = await api.get(`/api/tools/${id}`);
      setTool(response);
    } catch (error) {
      console.error('Failed to load tool detail:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleStartTool = async () => {
    if (!user && !guest) {
      navigate('/login', { state: { from: `/tools/${id}` } });
      return;
    }

    if (gateType === 'ad' && !adWatched) {
      setShowAdModal(true);
      return;
    }

    setProcessing(true);
    try {
      // 通过通行门
      const gateResponse = await api.post('/api/tools/gate', {
        tool_id: parseInt(id),
        gate_type: gateType,
      });

      const { ticket_id } = gateResponse;

      // 启动任务
      const taskResponse = await api.post('/api/tools/tasks/start', {
        ticket_id,
        input_data: {},
      });

      // 根据任务状态处理
      if (taskResponse.status === 'redirect') {
        // 外链类型：跳转到外部链接
        window.open(taskResponse.redirect_url, '_blank');
      } else if (taskResponse.status === 'dispatched') {
        // 派发类型：跳转到任务状态页
        navigate(`/tools/tasks/${taskResponse.task_id}`);
      }
    } catch (error) {
      console.error('Failed to start tool:', error);
      alert(error.response?.data?.detail || t('tools.startFailed'));
    } finally {
      setProcessing(false);
    }
  };

  const simulateAdWatch = () => {
    // 模拟广告播放 3 秒
    setTimeout(() => {
      setAdWatched(true);
      setShowAdModal(false);
      handleStartTool();
    }, 3000);
  };

  const getTrustBadge = (trustLevel) => {
    const badges = {
      official: { text: '官方认证', color: 'bg-blue-500', icon: '✓' },
      verified: { text: '开发者认证', color: 'bg-green-500', icon: '✓' },
      community: { text: '社区贡献', color: 'bg-gray-500', icon: '•' },
    };
    return badges[trustLevel] || badges.community;
  };

  if (loading) {
    return (
      <div className="tb-page-container min-h-full flex items-center justify-center">
        <p className="text-zinc-500 dark:text-zinc-400">{t('common.loading')}</p>
      </div>
    );
  }

  if (!tool) {
    return (
      <div className="tb-page-container min-h-full flex items-center justify-center">
        <p className="text-zinc-500 dark:text-zinc-400">{t('tools.notFound')}</p>
      </div>
    );
  }

  const badge = getTrustBadge(tool.trust_level);

  return (
    <div className="tb-page-container min-h-full bg-gradient-to-br from-zinc-50 to-white dark:from-zinc-900 dark:to-zinc-800">
      <div className="max-w-4xl mx-auto px-6 py-8">
        {/* 返回按钮 */}
        <button
          onClick={() => navigate('/tools')}
          className="mb-6 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:border-zinc-300 dark:hover:border-zinc-600 transition-all"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="m15 18-6-6 6-6" />
          </svg>
          {t('common.back')}
        </button>

        {/* 工具头部 - 更突出的视觉 */}
        <div className="relative overflow-hidden p-8 rounded-3xl bg-gradient-to-br from-white to-zinc-50 dark:from-zinc-800 dark:to-zinc-900 border-2 border-zinc-200 dark:border-zinc-700 shadow-xl mb-8">
          {/* 背景装饰 */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-blue-500/5 rounded-full blur-3xl"></div>
          
          <div className="relative">
            <div className="flex items-start gap-6 mb-6">
              <div className="flex-shrink-0 w-24 h-24 flex items-center justify-center text-7xl bg-white dark:bg-zinc-800 rounded-3xl shadow-lg">
                {tool.icon || '🔧'}
              </div>
              <div className="flex-1">
                <h1 className="text-3xl md:text-4xl font-bold text-zinc-900 dark:text-white mb-3 tracking-tight">
                  {tool.display_name}
                </h1>
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-white rounded-full shadow-lg ${badge.color}`}>
                    <span>{badge.icon}</span>
                    <span>{badge.text}</span>
                  </span>
                  {tool.scene_display_name && (
                    <span className="px-3 py-1.5 text-sm font-medium bg-white dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-full border border-zinc-200 dark:border-zinc-600">
                      {tool.scene_display_name}
                    </span>
                  )}
                </div>
                <p className="text-lg text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {tool.description}
                </p>
              </div>
            </div>

            {/* 详细描述 */}
            {tool.detail_desc && (
              <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-700">
                <p className="text-base text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap leading-relaxed">
                  {tool.detail_desc}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* 使用方式 - 突出二选一通行门 */}
        <div className="p-8 rounded-3xl bg-white dark:bg-zinc-800 border-2 border-zinc-200 dark:border-zinc-700 shadow-xl">
          <div className="text-center mb-6">
            <h2 className="text-2xl font-bold text-zinc-900 dark:text-white mb-2">
              {t('tools.howToUse')}
            </h2>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              选一种方式开始 · 看广告免费 · 或付积分跳过
            </p>
          </div>
          
          <div className="space-y-4 mb-6">
            {/* 看广告选项 - 更突出 */}
            <label 
              className={`group flex items-start gap-4 p-5 rounded-2xl border-2 cursor-pointer transition-all ${
                gateType === 'ad'
                  ? 'border-green-500 bg-green-50 dark:bg-green-900/20 shadow-lg shadow-green-500/20'
                  : 'border-zinc-200 dark:border-zinc-700 hover:border-green-300 dark:hover:border-green-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              }`}
            >
              <input
                type="radio"
                name="gateType"
                value="ad"
                checked={gateType === 'ad'}
                onChange={(e) => setGateType(e.target.value)}
                className="mt-1.5 w-5 h-5 text-green-500 cursor-pointer"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-3xl">📺</span>
                  <span className="text-lg font-bold text-zinc-900 dark:text-white">
                    {t('tools.watchAdOption')}
                  </span>
                  <span className="px-3 py-1 text-xs font-bold bg-green-500 text-white rounded-full shadow-lg">
                    {t('tools.free')}
                  </span>
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {t('tools.watchAdDesc')}
                </p>
              </div>
            </label>

            {/* 付费选项 */}
            <label 
              className={`group flex items-start gap-4 p-5 rounded-2xl border-2 cursor-pointer transition-all ${
                gateType === 'paid'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 shadow-lg shadow-blue-500/20'
                  : 'border-zinc-200 dark:border-zinc-700 hover:border-blue-300 dark:hover:border-blue-700 hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
              }`}
            >
              <input
                type="radio"
                name="gateType"
                value="paid"
                checked={gateType === 'paid'}
                onChange={(e) => setGateType(e.target.value)}
                className="mt-1.5 w-5 h-5 text-blue-500 cursor-pointer"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-3xl">💎</span>
                  <span className="text-lg font-bold text-zinc-900 dark:text-white">
                    {t('tools.payToSkipAd')}
                  </span>
                  <span className="px-3 py-1 text-xs font-bold bg-blue-500 text-white rounded-full shadow-lg">
                    {tool.pricing_amount} {t('tools.credits')}
                  </span>
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {t('tools.payToSkipAdDesc')}
                </p>
              </div>
            </label>
          </div>

          {/* 立即使用按钮 - 更大更醒目 */}
          <button
            onClick={handleStartTool}
            disabled={processing}
            className="w-full px-8 py-4 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 disabled:from-zinc-400 disabled:to-zinc-400 text-white text-lg font-bold rounded-2xl shadow-xl hover:shadow-2xl disabled:shadow-none transition-all transform hover:scale-[1.02] disabled:scale-100 disabled:cursor-not-allowed"
          >
            {processing ? t('tools.starting') : t('tools.startNow')}
          </button>
        </div>
      </div>

      {/* 广告模态框 */}
      {showAdModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-zinc-800 rounded-2xl p-6 max-w-md w-full mx-4">
            <h3 className="text-xl font-semibold text-zinc-900 dark:text-white mb-4">
              {t('tools.adPlaying')}
            </h3>
            <div className="flex items-center justify-center py-8">
              <div className="text-center">
                <div className="animate-spin rounded-full h-16 w-16 border-4 border-zinc-200 border-t-blue-500 mx-auto mb-4"></div>
                <p className="text-zinc-600 dark:text-zinc-400">
                  {t('tools.adPlayingDesc')}
                </p>
              </div>
            </div>
            <button
              onClick={simulateAdWatch}
              className="w-full px-4 py-2 bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300 rounded-xl hover:bg-zinc-300 dark:hover:bg-zinc-600"
            >
              {t('tools.skipAdForDemo')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
