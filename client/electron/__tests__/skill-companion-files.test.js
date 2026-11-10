'use strict';
// 社区目录技能的配套文件：写入、路径校验、推荐打包、再次纳管补缺。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  materializeSkillDir,
  syncSkillContentToAuthority,
  fillMissingSkillFiles,
  packSkillCompanionFiles,
  SKILL_PACK_MAX_FILE_BYTES,
} = require('../resource-canonical');

const FILES = [
  { path: 'references/core/style.md', content: '# 样式\n保持留白\n' },
  { path: 'scripts/run.sh', content: 'echo hi\n', encoding: 'utf8' },
  { path: 'assets/icon.bin', content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' },
  // 根上的 SKILL.md 即使出现在 files 里也不再写一遍
  { path: 'SKILL.md', content: 'from-files-should-not-win' },
];

function readIcon(dir) {
  return fs.readFileSync(path.join(dir, 'assets', 'icon.bin'));
}

test('materializeSkillDir 写入 SKILL.md 与 utf8/base64 配套文件，忽略 files 里的 SKILL.md', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-mat-'));
  try {
    const authority = materializeSkillDir(dir, '# From content\n', FILES);
    assert.equal(authority, path.resolve(dir));
    assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '# From content\n');
    assert.equal(fs.readFileSync(path.join(dir, 'references', 'core', 'style.md'), 'utf8'), '# 样式\n保持留白\n');
    assert.equal(fs.readFileSync(path.join(dir, 'scripts', 'run.sh'), 'utf8'), 'echo hi\n');
    assert.deepEqual(readIcon(dir), Buffer.from([0, 1, 2, 255]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('配套路径拒绝绝对路径、..、反斜杠和空段，不写出技能目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-path-'));
  const outside = path.join(dir, '..', `tb-escape-${path.basename(dir)}.txt`);
  const absTarget = path.join(os.tmpdir(), `tb-abs-${path.basename(dir)}.txt`);
  try {
    materializeSkillDir(dir, '# skill\n', [
      { path: '../outside.txt', content: 'no' },
      { path: `foo/../../${path.basename(outside)}`, content: 'no' },
      { path: absTarget, content: 'no' },
      { path: 'foo\\bar.txt', content: 'no' },
      { path: 'foo//bar.txt', content: 'no' },
      { path: '/etc/passwd', content: 'no' },
      { path: 'ok/note.txt', content: 'yes' },
      { path: 'root.txt', content: 'root' },
      { path: 'bad.txt', content: 'zz', encoding: 'hex' },
    ]);
    assert.equal(fs.readFileSync(path.join(dir, 'ok', 'note.txt'), 'utf8'), 'yes');
    assert.equal(fs.readFileSync(path.join(dir, 'root.txt'), 'utf8'), 'root');
    assert.equal(fs.existsSync(path.join(dir, 'foo', 'bar.txt')), false);
    assert.equal(fs.existsSync(outside), false);
    assert.equal(fs.existsSync(absTarget), false);
    assert.equal(fs.existsSync(path.join(dir, 'bad.txt')), false);
    assert.equal(fs.existsSync(path.join(dir, '..', 'outside.txt')), false);

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-link-'));
    try {
      fs.symlinkSync(outsideDir, path.join(dir, 'linked-dir'));
      materializeSkillDir(dir, '# skill\n', [
        { path: 'linked-dir/pwned.txt', content: 'no' },
        { path: 'linked-dir/nested/pwned.txt', content: 'no' },
      ]);
      assert.equal(fs.existsSync(path.join(outsideDir, 'pwned.txt')), false);
      assert.equal(fs.existsSync(path.join(outsideDir, 'nested', 'pwned.txt')), false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    try { fs.rmSync(absTarget, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(outside, { force: true }); } catch { /* ignore */ }
  }
});

test('syncSkillContentToAuthority 同步配套文件；非技能目录不写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-sync-'));
  try {
    materializeSkillDir(dir, '# v1\n', [{ path: 'references/a.md', content: 'a' }]);
    fs.writeFileSync(path.join(dir, 'references', 'a.md'), 'local', 'utf8');
    const synced = syncSkillContentToAuthority(dir, '# v2\n', [
      { path: 'references/a.md', content: 'from-sync' },
      { path: 'references/b.md', content: 'b' },
    ]);
    assert.ok(synced);
    assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '# v2\n');
    assert.equal(fs.readFileSync(path.join(dir, 'references', 'a.md'), 'utf8'), 'from-sync');
    assert.equal(fs.readFileSync(path.join(dir, 'references', 'b.md'), 'utf8'), 'b');

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-empty-'));
    try {
      assert.equal(syncSkillContentToAuthority(empty, '# no\n', [{ path: 'x.txt', content: 'x' }]), null);
      assert.equal(fs.existsSync(path.join(empty, 'x.txt')), false);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fillMissingSkillFiles 只补缺失文件，不覆盖已有内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-fill-'));
  try {
    materializeSkillDir(dir, '# body\n', [{ path: 'references/a.md', content: 'orig' }]);
    fs.writeFileSync(path.join(dir, 'references', 'a.md'), 'user', 'utf8');
    const result = fillMissingSkillFiles(dir, [
      { path: 'references/a.md', content: 'catalog-new' },
      { path: 'references/b.md', content: 'added' },
      { path: 'SKILL.md', content: 'nope' },
    ]);
    assert.deepEqual(result.written, ['references/b.md']);
    assert.equal(fs.readFileSync(path.join(dir, 'references', 'a.md'), 'utf8'), 'user');
    assert.equal(fs.readFileSync(path.join(dir, 'references', 'b.md'), 'utf8'), 'added');
    assert.equal(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), '# body\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('推荐打包：技能目录配套文件进入 metadata.files，跳过 SKILL.md、.git、依赖和超大文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-skill-pack-'));
  const dir = path.join(root, 'demo-skill');
  try {
    fs.mkdirSync(path.join(dir, 'references', 'core'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'leftpad'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '# skill body\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'references', 'core', 'style.md'), '# 样式\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo hi\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'assets', 'icon.bin'), Buffer.from([0, 1, 2, 255]));
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'gitdir\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'node_modules', 'leftpad', 'index.js'), 'module.exports=1\n', 'utf8');
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk', 'utf8');
    fs.writeFileSync(path.join(dir, 'aaa-huge.bin'), Buffer.alloc(SKILL_PACK_MAX_FILE_BYTES + 1));
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'kept\n', 'utf8');
    fs.writeFileSync(path.join(root, 'secret.txt'), 'secret', 'utf8');
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(dir, 'linked.txt'));

    // 传入 SKILL.md 路径时，打包的是它所在的技能目录，而不是上层仓库
    const files = packSkillCompanionFiles(path.join(dir, 'SKILL.md'));
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), [
      'assets/icon.bin',
      'keep.txt',
      'references/core/style.md',
      'scripts/run.sh',
    ]);
    assert.equal(byPath['references/core/style.md'].content, '# 样式\n');
    assert.equal(byPath['references/core/style.md'].encoding, undefined);
    assert.equal(byPath['scripts/run.sh'].content, 'echo hi\n');
    assert.equal(byPath['keep.txt'].content, 'kept\n');
    assert.equal(byPath['assets/icon.bin'].encoding, 'base64');
    assert.deepEqual(Buffer.from(byPath['assets/icon.bin'].content, 'base64'), Buffer.from([0, 1, 2, 255]));
    assert.equal(files.some((f) => f.path === 'SKILL.md' || f.path.includes('.git') || f.path.includes('node_modules')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const CACHE = path.join(os.homedir(), '.tokenbank', 'community-catalog.yaml');

function withCatalog(run) {
  const backup = fs.existsSync(CACHE) ? fs.readFileSync(CACHE) : null;
  const rc = require('../resource-catalog');
  try {
    run();
  } finally {
    if (backup) fs.writeFileSync(CACHE, backup);
    else {
      try { fs.unlinkSync(CACHE); } catch { /* ignore */ }
    }
    rc.resetCatalogCache();
    try { require('../mcp-catalog').resetCatalogCache(); } catch { /* ignore */ }
  }
}

function cleanupResource(name) {
  const id = `res-skill-${name}`;
  const hub = path.join(os.homedir(), '.agents', 'skills', name);
  try { fs.rmSync(hub, { recursive: true, force: true }); } catch { /* ignore */ }
  try {
    const localStats = require('../local-stats');
    const { STATS_DIR } = require('../../shared/telemetry');
    const db = localStats.requireDb(STATS_DIR);
    db.prepare('DELETE FROM resource_projections WHERE resource_id = ?').run(id);
    db.prepare('DELETE FROM resources WHERE id = ?').run(id);
  } catch { /* ignore */ }
}

test('社区缓存 upsert / normalize 保留 metadata.files', () => {
  const files = [
    { path: 'references/core/style.md', content: '# style\n' },
    { path: 'assets/icon.bin', content: Buffer.from([0, 1, 2, 255]).toString('base64'), encoding: 'base64' },
    { path: 'flag.txt', content: 'true' },
  ];
  withCatalog(() => {
    const catalogSync = require('../catalog-sync');
    const rc = require('../resource-catalog');
    const wrote = catalogSync.writeCommunityCatalogCache({
      version: 1,
      mcp: [],
      prompts: [],
      skills: [{
        catalog_id: 'tb-cf-cache',
        type: 'skill',
        name: 'tb-cf-cache',
        content: '# skill\n',
        metadata: { tags: ['draw'], files },
      }],
      assistants: [],
    });
    assert.equal(wrote, true);
    rc.resetCatalogCache();
    const fromCache = rc.getCatalogItem('tb-cf-cache');
    assert.deepEqual(fromCache.metadata.files, files);
    assert.equal(fromCache.content, '# skill\n');

    const upserted = catalogSync.upsertCommunitySkillItem({
      catalog_id: 'tb-cf-upsert',
      type: 'skill',
      name: 'tb-cf-upsert',
      content: '# upsert\n',
      metadata: { files, tags: ['pack'] },
    });
    assert.equal(upserted, true);
    rc.resetCatalogCache();
    const fromUpsert = rc.getCatalogItem('tb-cf-upsert');
    assert.deepEqual(fromUpsert.metadata.files, files);
    assert.deepEqual(rc.getCatalogItem('tb-cf-cache').metadata.files, files);
  });
});

test('目录纳管把 metadata.files 落到 ~/.agents/skills，再次纳管只补缺失文件', () => {
  const rm = require('../resource-manager');
  const rc = require('../resource-catalog');
  const catalogSync = require('../catalog-sync');
  const fresh = 'tb-cf-fresh';
  const refill = 'tb-cf-refill';
  const localName = 'tb-cf-local';
  const names = [fresh, refill, localName];
  const escapeName = 'tb-cf-should-not-escape.txt';
  for (const name of names) cleanupResource(name);

  withCatalog(() => {
    try {
      const iconB64 = Buffer.from([9, 8, 7]).toString('base64');
      catalogSync.writeCommunityCatalogCache({
        version: 1,
        mcp: [],
        prompts: [],
        skills: [{
          catalog_id: fresh,
          type: 'skill',
          name: fresh,
          display_name: fresh,
          description: 'fresh pack',
          content: '# fresh body\n',
          metadata: {
            tags: ['t'],
            files: [
              { path: 'references/core/style.md', content: '# 样式\n保持留白\n' },
              { path: 'assets/icon.bin', content: iconB64, encoding: 'base64' },
              { path: 'SKILL.md', content: 'from-files-should-not-win' },
              { path: `../${escapeName}`, content: 'nope' },
            ],
          },
        }, {
          catalog_id: refill,
          type: 'skill',
          name: refill,
          display_name: refill,
          description: 'refill',
          content: '# refill v1\n',
          metadata: { tags: ['t'] },
        }],
        assistants: [],
      });
      rc.resetCatalogCache();

      const installed = rm.installFromCatalog(fresh);
      assert.equal(installed.alreadyInstalled, false);
      const hub = path.join(os.homedir(), '.agents', 'skills', fresh);
      assert.equal(fs.readFileSync(path.join(hub, 'SKILL.md'), 'utf8'), '# fresh body\n');
      assert.equal(fs.readFileSync(path.join(hub, 'references', 'core', 'style.md'), 'utf8'), '# 样式\n保持留白\n');
      assert.deepEqual(fs.readFileSync(path.join(hub, 'assets', 'icon.bin')), Buffer.from([9, 8, 7]));
      assert.equal(fs.existsSync(path.join(os.homedir(), '.agents', 'skills', escapeName)), false);
      assert.equal(installed.resource.source, 'catalog');

      const first = rm.installFromCatalog(refill);
      assert.equal(first.alreadyInstalled, false);
      const refillHub = path.join(os.homedir(), '.agents', 'skills', refill);
      assert.equal(fs.readFileSync(path.join(refillHub, 'SKILL.md'), 'utf8'), '# refill v1\n');
      assert.equal(fs.existsSync(path.join(refillHub, 'references', 'core', 'style.md')), false);

      // 目录后来补上配套文件；已安装的 SKILL.md 保持不动，只补缺失文件
      catalogSync.writeCommunityCatalogCache({
        version: 1,
        mcp: [],
        prompts: [],
        skills: [{
          catalog_id: fresh,
          type: 'skill',
          name: fresh,
          content: '# fresh body\n',
          metadata: { files: FILES },
        }, {
          catalog_id: refill,
          type: 'skill',
          name: refill,
          content: '# refill v2 should not replace\n',
          metadata: {
            files: [
              { path: 'references/core/style.md', content: 'catalog-v1' },
              { path: 'scripts/run.sh', content: 'echo hi\n' },
            ],
          },
        }],
        assistants: [],
      });
      rc.resetCatalogCache();
      const again = rm.installFromCatalog(refill);
      assert.equal(again.alreadyInstalled, true);
      assert.equal(fs.readFileSync(path.join(refillHub, 'SKILL.md'), 'utf8'), '# refill v1\n');
      assert.equal(fs.readFileSync(path.join(refillHub, 'references', 'core', 'style.md'), 'utf8'), 'catalog-v1');
      assert.equal(fs.readFileSync(path.join(refillHub, 'scripts', 'run.sh'), 'utf8'), 'echo hi\n');
      assert.ok(Array.isArray(again.resource.metadata.files));

      // 扫描同步会把 source 改成 agent:*，只要 source_url 仍是 catalog: 就继续补缺
      const localStats = require('../local-stats');
      const { STATS_DIR } = require('../../shared/telemetry');
      const db = localStats.requireDb(STATS_DIR);
      db.prepare(`UPDATE resources SET source = 'agent:agents-hub' WHERE id = ?`).run(`res-skill-${refill}`);
      fs.rmSync(path.join(refillHub, 'scripts', 'run.sh'));
      rm.installFromCatalog(refill);
      assert.equal(fs.readFileSync(path.join(refillHub, 'scripts', 'run.sh'), 'utf8'), 'echo hi\n');
      assert.equal(fs.readFileSync(path.join(refillHub, 'references', 'core', 'style.md'), 'utf8'), 'catalog-v1');

      fs.writeFileSync(path.join(refillHub, 'references', 'core', 'style.md'), 'user-edit', 'utf8');
      catalogSync.writeCommunityCatalogCache({
        version: 1,
        mcp: [],
        prompts: [],
        skills: [{
          catalog_id: refill,
          type: 'skill',
          name: refill,
          content: '# refill v3\n',
          metadata: {
            files: [
              { path: 'references/core/style.md', content: 'catalog-v2' },
              { path: 'scripts/run.sh', content: 'echo hi\n' },
              { path: 'assets/extra.txt', content: 'extra' },
            ],
          },
        }],
        assistants: [],
      });
      rc.resetCatalogCache();
      rm.installFromCatalog(refill);
      assert.equal(fs.readFileSync(path.join(refillHub, 'SKILL.md'), 'utf8'), '# refill v1\n');
      assert.equal(fs.readFileSync(path.join(refillHub, 'references', 'core', 'style.md'), 'utf8'), 'user-edit');
      assert.equal(fs.readFileSync(path.join(refillHub, 'assets', 'extra.txt'), 'utf8'), 'extra');

      // 同名的本机技能不是目录来源，不能被目录条目改写
      const saved = rm.saveResource({
        type: 'skill',
        name: localName,
        description: 'local',
        content: '# local body\n',
        source: 'local',
      });
      assert.equal(saved.resource.source, 'local');
      const localHub = path.join(os.homedir(), '.agents', 'skills', localName);
      fs.writeFileSync(path.join(localHub, 'notes.txt'), 'mine', 'utf8');
      catalogSync.upsertCommunitySkillItem({
        catalog_id: localName,
        type: 'skill',
        name: localName,
        content: '# catalog overwrite\n',
        metadata: {
          files: [{ path: 'notes.txt', content: 'theirs' }, { path: 'extra.txt', content: 'extra' }],
        },
      });
      rc.resetCatalogCache();
      const localInstall = rm.installFromCatalog(localName);
      assert.equal(localInstall.alreadyInstalled, true);
      assert.equal(fs.readFileSync(path.join(localHub, 'SKILL.md'), 'utf8'), '# local body\n');
      assert.equal(fs.readFileSync(path.join(localHub, 'notes.txt'), 'utf8'), 'mine');
      assert.equal(fs.existsSync(path.join(localHub, 'extra.txt')), false);
      assert.notEqual(rm.getResource(saved.resource.id).source, 'catalog');
    } finally {
      for (const name of names) cleanupResource(name);
    }
  });
});
