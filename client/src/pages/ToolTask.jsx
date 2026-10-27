import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useLang } from '../store/lang';
import { api } from '../api/adapter';

export default function ToolTask() {
  const { taskId } = useParams();
  const { t } = useLang();
  const navigate = useNavigate();
  
  const [loading, setLoading] = useState(true);
  const [task, setTask] = useState(null);
  const [polling, setPolling] = useState(true);

  useEffect(() => {
    loadTask();
    
    // 轮询任务状态
    const interval = setInterval(() => {
      if (polling) {
        loadTask();
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [taskId, polling]);

  const loadTask = async () => {
    try {
      const response = await api.get(`/api/tools/tasks/${taskId}`);
      setTask(response);
      
      // 任务完成或失败时停止轮询
      if (response.status === 'completed' || response.status === 'failed') {
        setPolling(false);
      }
    } catch (error) {
      console.error('Failed to load task:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusInfo = (status) => {
    const statusMap = {
      created: { text: t('tools.taskCreated'), color: 'text-zinc-500', icon: '⏳' },
      dispatched: { text: t('tools.taskDispatched'), color: 'text-blue-500', icon: '🚀' },
      processing: { text: t('tools.taskProcessing'), color: 'text-yellow-500', icon: '⚙️' },
      completed: { text: t('tools.taskCompleted'), color: 'text-green-500', icon: '✓' },
      failed: { text: t('tools.taskFailed'), color: 'text-red-500', icon: '✗' },
      redirect: { text: t('tools.taskRedirect'), color: 'text-purple-500', icon: '↗' },
    };
    return statusMap[status] || statusMap.created;
  };

  if (loading) {
    return (
      <div className="tb-page-container min-h-full flex items-center justify-center">
        <p className="text-zinc-500 dark:text-zinc-400">{t('common.loading')}</p>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="tb-page-container min-h-full flex items-center justify-center">
        <p className="text-zinc-500 dark:text-zinc-400">{t('tools.taskNotFound')}</p>
      </div>
    );
  }

  const statusInfo = getStatusInfo(task.status);

  return (
    <div className="tb-page-container min-h-full bg-gradient-to-br from-zinc-50 to-white dark:from-zinc-900 dark:to-zinc-800">
      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* 返回按钮 */}
        <button
          onClick={() => navigate('/tools')}
          className="mb-6 flex items-center gap-2 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
            <path d="m15 18-6-6 6-6" />
          </svg>
          {t('tools.backToTools')}
        </button>

        {/* 任务状态卡片 - 更友好的视觉 */}
        <div className="relative overflow-hidden p-8 rounded-3xl bg-white dark:bg-zinc-800 border-2 border-zinc-200 dark:border-zinc-700 shadow-2xl mb-8">
          {/* 背景装饰 */}
          <div className="absolute top-0 right-0 w-48 h-48 bg-blue-500/5 rounded-full blur-3xl"></div>
          
          <div className="relative text-center mb-8">
            <div className="inline-flex items-center justify-center w-24 h-24 mb-4 text-6xl bg-gradient-to-br from-zinc-50 to-zinc-100 dark:from-zinc-700 dark:to-zinc-800 rounded-3xl shadow-lg">
              {statusInfo.icon}
            </div>
            <h1 className={`text-3xl font-bold mb-3 ${statusInfo.color}`}>
              {statusInfo.text}
            </h1>
            <p className="text-lg text-zinc-600 dark:text-zinc-400">
              {task.tool_name}
            </p>
          </div>

          {/* 进度条 */}
          {task.status === 'processing' && (
            <div className="mb-6">
              <div className="flex justify-between text-sm text-zinc-600 dark:text-zinc-400 mb-2">
                <span>{t('tools.progress')}</span>
                <span>{Math.round(task.progress * 100)}%</span>
              </div>
              <div className="h-2 bg-zinc-200 dark:bg-zinc-700 rounded-full overflow-hidden">
                <div 
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${task.progress * 100}%` }}
                />
              </div>
            </div>
          )}

          {/* 任务信息 */}
          <div className="space-y-3 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">{t('tools.taskId')}:</span>
              <span className="text-zinc-900 dark:text-white font-mono text-xs">{task.task_id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">{t('tools.createdAt')}:</span>
              <span className="text-zinc-900 dark:text-white">
                {new Date(task.created_at).toLocaleString('zh-CN')}
              </span>
            </div>
            {task.completed_at && (
              <div className="flex justify-between">
                <span className="text-zinc-600 dark:text-zinc-400">{t('tools.completedAt')}:</span>
                <span className="text-zinc-900 dark:text-white">
                  {new Date(task.completed_at).toLocaleString('zh-CN')}
                </span>
              </div>
            )}
          </div>

          {/* 错误信息 */}
          {task.status === 'failed' && task.error_message && (
            <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
              <p className="text-sm text-red-700 dark:text-red-300">
                {task.error_message}
              </p>
            </div>
          )}

          {/* 结果数据 */}
          {task.status === 'completed' && task.result_data && (
            <div className="mt-6 pt-6 border-t border-zinc-200 dark:border-zinc-700">
              <h3 className="text-lg font-semibold text-zinc-900 dark:text-white mb-3">
                {t('tools.result')}
              </h3>
              
              {task.result_data.download_url ? (
                <a
                  href={task.result_data.download_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-xl"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  {t('tools.downloadResult')}
                </a>
              ) : (
                <pre className="p-4 bg-zinc-100 dark:bg-zinc-900 rounded-xl overflow-x-auto text-xs">
                  {JSON.stringify(task.result_data, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex gap-3">
          <button
            onClick={() => navigate('/tools')}
            className="flex-1 px-6 py-3 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            {t('tools.browseMore')}
          </button>
          {task.status === 'completed' && (
            <button
              onClick={() => navigate(`/tools/${task.tool_id}`)}
              className="flex-1 px-6 py-3 bg-blue-500 hover:bg-blue-600 text-white rounded-xl"
            >
              {t('tools.useAgain')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
