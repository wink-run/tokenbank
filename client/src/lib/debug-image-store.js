/** 调试页生图 / 附图：IndexedDB 落盘，localStorage 只存短引用，刷新后仍可预览 */

export const B64_OMITTED = '__b64_omitted__';
export const IMAGE_REF_PREFIX = 'tbimg:';
/** 非图片附件只记文件名，正文在执行时另传 */
export const FILE_REF_PREFIX = 'tbfile:';

export function fileMarker(name) {
  const n = String(name || 'file').slice(0, 180);
  return FILE_REF_PREFIX + encodeURIComponent(n);
}

export function fileMarkerName(src) {
  if (typeof src !== 'string' || !src.startsWith(FILE_REF_PREFIX)) return '';
  try { return decodeURIComponent(src.slice(FILE_REF_PREFIX.length)); }
  catch { return src.slice(FILE_REF_PREFIX.length); }
}

const DB_NAME = 'tokenbank-debug-media';
const DB_VER = 1;
const STORE = 'images';

export function isImageRef(src) {
  return typeof src === 'string' && src.startsWith(IMAGE_REF_PREFIX);
}

/** 可直接写入 localStorage 的图：http(s) 或已落盘引用 */
export function isKeptImageSrc(src) {
  if (!src || src === B64_OMITTED) return false;
  if (isImageRef(src)) return true;
  const s = String(src);
  return s.startsWith('http://') || s.startsWith('https://');
}

export function serializeImageSrc(src) {
  if (fileMarkerName(src)) return src;
  if (isKeptImageSrc(src)) return src;
  return B64_OMITTED;
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no indexedDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb open failed'));
  });
}

function idbReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function parseImagePayload(src) {
  const s = String(src || '');
  const mm = /^data:([^;]+);base64,(.+)$/s.exec(s);
  if (mm) return { mime: mm[1] || 'image/png', b64: mm[2] };
  // 裸 base64（生图 API 常直接给 b64_json）
  if (s.length > 80 && !s.includes('://') && !s.startsWith('tbimg:')) {
    return { mime: 'image/png', b64: s.replace(/\s/g, '') };
  }
  return null;
}

function newId() {
  try { return crypto.randomUUID(); } catch {
    return `img_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

export async function persistImageSrc(src) {
  if (!src || src === B64_OMITTED) return B64_OMITTED;
  if (fileMarkerName(src)) return src;
  if (isKeptImageSrc(src)) return src;
  const parsed = parseImagePayload(src);
  if (!parsed?.b64) return B64_OMITTED;
  const id = newId();
  const db = await openDb();
  try {
    await idbReq(db.transaction(STORE, 'readwrite').objectStore(STORE).put(parsed, id));
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return IMAGE_REF_PREFIX + id;
}

export async function persistImageList(images) {
  if (!Array.isArray(images)) return images;
  const out = [];
  for (const src of images) {
    try { out.push(await persistImageSrc(src)); }
    catch { out.push(isKeptImageSrc(src) ? src : B64_OMITTED); }
  }
  return out;
}

export async function resolveImageSrc(src) {
  if (!src || src === B64_OMITTED) return B64_OMITTED;
  if (!isImageRef(src)) return src;
  const id = src.slice(IMAGE_REF_PREFIX.length);
  try {
    const db = await openDb();
    try {
      const rec = await idbReq(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
      if (!rec?.b64) return B64_OMITTED;
      return `data:${rec.mime || 'image/png'};base64,${rec.b64}`;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return B64_OMITTED;
  }
}

export async function resolveImageList(images) {
  if (!Array.isArray(images)) return images;
  return Promise.all(images.map((src) => resolveImageSrc(src).catch(() => B64_OMITTED)));
}

/** 无需异步即可用于 <img> 的地址；tbimg 引用返回空串，交给 resolveImageSrc */
export function toImmediateDisplaySrc(src) {
  if (!src || src === B64_OMITTED || isImageRef(src)) return '';
  const s = String(src);
  if (s.startsWith('data:') || s.startsWith('http://') || s.startsWith('https://')
    || s.startsWith('blob:') || s.startsWith('file:')) return s;
  return `data:image/png;base64,${s}`;
}

export function imageRefId(src) {
  if (!isImageRef(src)) return '';
  return src.slice(IMAGE_REF_PREFIX.length);
}

/** 从消息 / 会话结构里收集 tbimg 引用 id */
export function collectImageRefIds(...bags) {
  const ids = new Set();
  const visit = (v) => {
    if (!v) return;
    if (typeof v === 'string') {
      const id = imageRefId(v);
      if (id) ids.add(id);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (typeof v === 'object') {
      if (Array.isArray(v.images)) visit(v.images);
      if (Array.isArray(v.conversation)) visit(v.conversation);
      if (Array.isArray(v.conversationTurns)) visit(v.conversationTurns);
    }
  };
  for (const bag of bags) visit(bag);
  return ids;
}

export async function deleteImageIds(ids) {
  const list = [...(ids || [])].filter(Boolean);
  if (!list.length) return 0;
  const db = await openDb();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (const id of list) store.delete(id);
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return list.length;
}

/** 删除 drop 中未被 keep 引用的图片（清空聊天时避免误删历史会话里的图） */
export function unreferencedImageIds(dropIds, keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
  const drop = [];
  for (const id of (dropIds || [])) {
    if (id && !keep.has(id)) drop.push(id);
  }
  return drop;
}

export async function deleteUnreferencedImageIds(dropIds, keepIds) {
  const drop = unreferencedImageIds(dropIds, keepIds);
  if (!drop.length) return 0;
  return deleteImageIds(drop);
}
