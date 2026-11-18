// client/electron/mesh/frames.js
// 设备网络里一条流上的分帧：1 字节类型 + 4 字节长度 + 内容。
// 类型 0 是 JSON（请求头、响应头、控制消息），类型 1 是原样字节（请求体、响应体）。
// 流的适配器只要有 write(Buffer) / finish() / read(max)，read 读到头返回 null。
'use strict';

const KIND_JSON = 0;
const KIND_DATA = 1;
const MAX_FRAME = 4 * 1024 * 1024;   // 单帧上限。更大的内容由写的一方切开
const DATA_CHUNK = 64 * 1024;

function encode(kind, payload) {
  const head = Buffer.alloc(5);
  head.writeUInt8(kind, 0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

class FrameStream {
  /** @param {{ write(b: Buffer): Promise<void>, finish(): Promise<void>, read(max: number): Promise<Buffer|null> }} io */
  constructor(io) {
    this.io = io;
    this.buf = Buffer.alloc(0);
    this.eof = false;
    this.finished = false;
  }

  async writeJson(obj) {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    if (payload.length > MAX_FRAME) throw new Error('frame too large');
    await this.io.write(encode(KIND_JSON, payload));
  }

  async writeData(data) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (let i = 0; i < b.length; i += DATA_CHUNK) {
      await this.io.write(encode(KIND_DATA, b.subarray(i, i + DATA_CHUNK)));
    }
  }

  async finish() {
    if (this.finished) return;
    this.finished = true;
    await this.io.finish();
  }

  async _fill(n) {
    while (this.buf.length < n) {
      if (this.eof) return false;
      const chunk = await this.io.read(256 * 1024);
      if (!chunk || chunk.length === 0) { this.eof = true; continue; }
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    }
    return true;
  }

  /** 下一帧：{ kind: 'json', value } | { kind: 'data', value: Buffer } | null（对方写完了） */
  async next() {
    if (!(await this._fill(5))) {
      if (this.buf.length) throw new Error('truncated frame header');
      return null;
    }
    const kind = this.buf.readUInt8(0);
    const len = this.buf.readUInt32BE(1);
    if (len > MAX_FRAME) throw new Error('frame too large');
    if (!(await this._fill(5 + len))) throw new Error('truncated frame');
    const payload = this.buf.subarray(5, 5 + len);
    this.buf = this.buf.subarray(5 + len);
    if (kind === KIND_JSON) return { kind: 'json', value: JSON.parse(payload.toString('utf8')) };
    if (kind === KIND_DATA) return { kind: 'data', value: Buffer.from(payload) };
    throw new Error(`unknown frame kind ${kind}`);
  }

  /** 下一帧必须是 JSON；对方写完了返回 null */
  async nextJson() {
    const f = await this.next();
    if (!f) return null;
    if (f.kind !== 'json') throw new Error('expected json frame');
    return f.value;
  }
}

/** 测试和本机自连用：一对首尾相连的内存流 */
function memoryPair() {
  function side() {
    const queue = [];
    const waiters = [];
    let closed = false;
    return {
      push(b) { if (waiters.length) waiters.shift()(b); else queue.push(b); },
      close() { closed = true; while (waiters.length) waiters.shift()(null); },
      read() {
        if (queue.length) return Promise.resolve(queue.shift());
        if (closed) return Promise.resolve(null);
        return new Promise((r) => waiters.push(r));
      },
    };
  }
  const aToB = side();
  const bToA = side();
  const a = {
    write: async (b) => aToB.push(Buffer.from(b)),
    finish: async () => aToB.close(),
    read: () => bToA.read(),
  };
  const b = {
    write: async (x) => bToA.push(Buffer.from(x)),
    finish: async () => bToA.close(),
    read: () => aToB.read(),
  };
  return [a, b];
}

module.exports = { FrameStream, memoryPair, MAX_FRAME, DATA_CHUNK };
