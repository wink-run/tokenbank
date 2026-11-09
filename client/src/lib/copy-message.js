// 把一条消息的文字和图片一起放进剪贴板。
// 纯文本给输入框，HTML 给能排版的应用，第一张图再单独放一份，方便只贴图。
import { B64_OMITTED, fileMarkerName, resolveImageSrc } from './debug-image-store';
import { resolveMediaUrl } from './mediaUrl';

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read blob'));
    reader.readAsDataURL(blob);
  });
}

/** 剪贴板的图片位只认 png。其它格式画到画布上再导出。 */
function toPngBlob(blob) {
  if (!blob) return Promise.resolve(null);
  if (blob.type === 'image/png') return Promise.resolve(blob);
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || 1;
      canvas.height = img.naturalHeight || 1;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((out) => {
        URL.revokeObjectURL(url);
        resolve(out);
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

async function imageBlob(src) {
  let resolved = src;
  try { resolved = await resolveImageSrc(src); } catch { /* 原样再试一次 */ }
  if (!resolved || resolved === B64_OMITTED || fileMarkerName(resolved)) return null;
  const url = resolveMediaUrl(String(resolved));
  if (!url || url === B64_OMITTED) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const blob = await res.blob();
  if (blob.type && !blob.type.startsWith('image/') && !url.startsWith('data:image/')) return null;
  return blob.type ? blob : new Blob([blob], { type: 'image/png' });
}

/** 用户附图、工具读到的图、远程成品图，收成可复制的地址。 */
export function messageImageSrcs(images, artifacts) {
  const out = [];
  for (const src of images || []) {
    if (typeof src !== 'string' || !src || src === B64_OMITTED || fileMarkerName(src)) continue;
    out.push(src);
  }
  for (const file of artifacts || []) {
    const name = String(file?.name || '');
    const image = file?.kind === 'image' || /\.(png|jpe?g|gif|webp)$/i.test(name);
    if (!image) continue;
    const src = file.dataUrl || file.url || '';
    if (src) out.push(src);
  }
  return out;
}

export async function copyMessageContent({ text = '', images = [] } = {}) {
  const plain = String(text || '');
  const pngs = [];
  const htmlImgs = [];
  for (const src of images || []) {
    try {
      const blob = await imageBlob(src);
      if (!blob) continue;
      const png = await toPngBlob(blob);
      if (png) pngs.push(png);
      const dataUrl = await blobToDataUrl(png || blob);
      if (dataUrl) htmlImgs.push(`<img src="${dataUrl}">`);
    } catch { /* 一张失败不影响其它 */ }
  }
  const htmlParts = [];
  if (plain.trim()) htmlParts.push(`<div>${escapeHtml(plain).replace(/\n/g, '<br>')}</div>`);
  htmlParts.push(...htmlImgs);
  if (!plain.trim() && !pngs.length && !htmlParts.length) return false;

  const payload = {};
  if (plain) payload['text/plain'] = new Blob([plain], { type: 'text/plain' });
  if (htmlParts.length) payload['text/html'] = new Blob([htmlParts.join('')], { type: 'text/html' });
  if (pngs[0]) payload['image/png'] = pngs[0];

  try {
    await navigator.clipboard.write([new ClipboardItem(payload)]);
    return true;
  } catch { /* 有的环境不接受图文混在一条里 */ }
  try {
    if (plain.trim()) {
      await navigator.clipboard.writeText(plain);
      return true;
    }
  } catch { /* 再试只贴图 */ }
  try {
    if (pngs[0]) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngs[0] })]);
      return true;
    }
  } catch { /* 剪贴板不可用 */ }
  return false;
}

/** 选区里带了图片时，Cmd+C 也把图写进剪贴板。只选文字则交给浏览器。 */
export function onMessageCopy(event) {
  const root = event.currentTarget;
  const sel = window.getSelection();
  if (!root || !sel || sel.isCollapsed || !sel.rangeCount) return;
  if (!root.contains(sel.anchorNode)) return;
  const range = sel.getRangeAt(0);
  const imgs = [...root.querySelectorAll('img')].filter((img) => {
    try { return range.intersectsNode(img); } catch { return false; }
  });
  if (!imgs.length) return;
  event.preventDefault();
  const srcs = imgs.map((img) => img.currentSrc || img.src).filter(Boolean);
  copyMessageContent({ text: sel.toString(), images: srcs });
}
