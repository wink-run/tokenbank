/**
 * 雇佣远程智能体时，正文里的出租方绝对路径换成中转地址。
 * 没有对应成品的路径只留文件名，避免把对方磁盘路径展示出来。
 */

const LOCAL_PATH_RE = /(?:~\/|\/(?:Users|home|tmp|var|opt|private|Volumes)|(?<![A-Za-z])[A-Za-z]:[\\/])[^\s`'"<>|]+/g;

function artifactUrlOk(url) {
  const s = String(url || '');
  return /^https?:\/\/\S+\/media\/agent\/[A-Za-z0-9_-]+\/[^/?#\s]+$/i.test(s)
    || /^\/media\/agent\/[A-Za-z0-9_-]+\/[^/?#\s]+$/.test(s);
}

function pathBasename(full) {
  const parts = String(full || '').split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : full;
}

function swapRemoteArtifactPaths(text, artifacts) {
  let s = String(text || '');
  for (const file of artifacts || []) {
    const url = String(file && file.url || '');
    const name = String(file && file.name || '');
    if (!artifactUrlOk(url) || !name) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 盘符前不能是字母，避免把 https:// 里的 s:/ 再拼一次
    const re = new RegExp(
      '(?:~/|/(?:Users|home|tmp|var|opt|private|Volumes)|(?<![A-Za-z])[A-Za-z]:[\\\\/])[^\\s`\'"<>|]*?' + esc,
      'g',
    );
    s = s.replace(re, url);
  }
  return s;
}

export function presentRemoteAgentText(text, artifacts) {
  const swapped = swapRemoteArtifactPaths(text, artifacts);
  return swapped.replace(LOCAL_PATH_RE, (full) => pathBasename(full));
}

export function presentRemoteAgentSteps(steps, artifacts) {
  if (!Array.isArray(steps)) return steps;
  return steps.map((step) => {
    if (!step || typeof step.content !== 'string' || !step.content) return step;
    const content = presentRemoteAgentText(step.content, artifacts);
    if (content === step.content) return step;
    return { ...step, content };
  });
}

export function presentRemoteAgentResult(result, artifacts) {
  if (!result || typeof result !== 'object') return result;
  const arts = artifacts || result.artifacts;
  let next = result;
  for (const key of ['summary', 'output']) {
    if (typeof next[key] !== 'string' || !next[key]) continue;
    const value = presentRemoteAgentText(next[key], arts);
    if (value === next[key]) continue;
    if (next === result) next = { ...result };
    next[key] = value;
  }
  return next;
}
