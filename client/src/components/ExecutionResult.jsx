// client/src/components/ExecutionResult.jsx
// Agent 执行结果组件
import React from 'react';
import { useLang } from '../store/lang';
import { PathLink } from './RichMediaContent';
import { resolveMediaUrl } from '../lib/mediaUrl';

/** 把 data URL 存成文件。坏数据只是下不下来，不打断结果卡。 */
function downloadDataUrl(file) {
  const url = String(file?.dataUrl || '');
  const comma = url.indexOf(',');
  if (comma < 0) return;
  const mime = (url.slice(0, comma).match(/^data:([^;]+)/) || [])[1] || 'application/octet-stream';
  try {
    const bin = atob(url.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let n = 0; n < bin.length; n += 1) bytes[n] = bin.charCodeAt(n);
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = file.name || 'file';
    a.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
  } catch { /* ignore */ }
}

function artifactHref(file) {
  const url = String(file?.url || '');
  if (/^https?:\/\//i.test(url) || url.startsWith('/media/agent/')) return resolveMediaUrl(url);
  return '';
}

/** 远程成品：图片直接看，其余提供下载。地址是中转链接，不走本机路径预览。 */
export function RemoteArtifacts({ artifacts }) {
  const list = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item && (item.dataUrl || artifactHref(item)));
  if (!list.length) return null;
  return (
    <div className="mt-2 space-y-2">
      {list.map((file, index) => {
        const href = artifactHref(file);
        const name = String(file.name || '');
        const previewable = file.kind === 'image' || /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
        const src = previewable ? (href || file.dataUrl) : '';
        return (
          <figure key={`${file.name || 'file'}-${index}`} className="space-y-1">
            {src && (
              <img
                src={src}
                alt={file.name || ''}
                className="max-h-64 max-w-full rounded-lg border border-black/10 dark:border-white/10"
              />
            )}
            {href ? (
              <a
                href={href}
                download={file.name || 'file'}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-zinc-700 dark:text-zinc-300 underline-offset-2 hover:underline"
              >
                {file.name || 'file'}
              </a>
            ) : (
              <button
                type="button"
                onClick={() => downloadDataUrl(file)}
                className="text-xs font-mono text-zinc-700 dark:text-zinc-300 underline-offset-2 hover:underline"
              >
                {file.name || 'file'}
              </button>
            )}
          </figure>
        );
      })}
    </div>
  );
}

export default function ExecutionResult({ result, task }) {
  const { t } = useLang();
  if (!result) return null;

  const success = result.success !== false;
  const duration = task?.completed_at && task?.started_at
    ? ((task.completed_at - task.started_at) / 1000).toFixed(1)
    : null;

  return (
    <div className="space-y-4">
      {/* 状态标题 */}
      <div className={`
        flex items-center gap-2 p-4 rounded-lg
        ${success 
          ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400'
          : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400'
        }
      `}>
        <span className="text-2xl">{success ? '✅' : '❌'}</span>
        <span className="font-medium">{success ? t('debug.result.success') : t('debug.result.failed')}</span>
      </div>

      {/* 错误信息 */}
      {!success && task?.error && (
        <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800">
          <div className="text-sm font-medium text-red-700 dark:text-red-400 mb-2">
            {t('debug.result.error')}
          </div>
          <div className="text-sm text-red-600 dark:text-red-400 whitespace-pre-wrap">
            {task.error}
          </div>
        </div>
      )}

      <RemoteArtifacts artifacts={result.artifacts} />

      {/* 修改的文件 */}
      {result.files && result.files.length > 0 && (
        <div className="tb-soft-card p-4 rounded-lg">
          <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
            {t('debug.result.files', { n: result.files.length })}
          </div>
          <div className="space-y-2">
            {result.files.map((file, index) => (
              <div key={index} className="flex items-center gap-2 text-sm">
                <span className="text-zinc-500 dark:text-zinc-400">
                  {file.operation === 'created' ? '📝' : file.operation === 'modified' ? '✏️' : '📄'}
                </span>
                <PathLink
                  path={file.path || file.file_path}
                  title={t('debug.preview.clickHint')}
                  className="text-zinc-700 dark:text-zinc-300 text-xs"
                />
                {file.operation && (
                  <span className={`
                    px-1.5 py-0.5 rounded text-xs
                    ${file.operation === 'created' 
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                    }
                  `}>
                    {file.operation === 'created' ? t('debug.result.created') : t('debug.result.modified')}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 执行统计 */}
      <div className="tb-soft-card p-4 rounded-lg">
        <div className="text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-3">
          {t('debug.result.stats')}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {duration && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 dark:text-zinc-400">⏱️</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">{t('debug.result.duration')}</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {duration}s
              </span>
            </div>
          )}
          
          {result.tokens && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 dark:text-zinc-400">🔤</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">Tokens:</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {result.tokens.input || 0} + {result.tokens.output || 0}
              </span>
            </div>
          )}
          
          {result.cost && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 dark:text-zinc-400">💰</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">{t('debug.result.cost')}</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                ${result.cost.toFixed(4)}
              </span>
            </div>
          )}
          
          {result.stepCount && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500 dark:text-zinc-400">📊</span>
              <span className="text-sm text-zinc-600 dark:text-zinc-400">{t('debug.result.steps')}</span>
              <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {t('debug.result.stepsCount', { n: result.stepCount })}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
