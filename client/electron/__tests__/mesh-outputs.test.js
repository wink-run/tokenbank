// 产出（设计 §8.4、D15、D19）：独立工作树、临时索引提交、bundle 取回、outbox 快照、只读查看
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-outputs-home-'));
process.env.HOME = HOME;
const outputs = require('../mesh/outputs');

const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-outputs-repo-'));
  g(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'out/\n');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'init');
  return dir;
}

test('子任务在独立工作树里改代码：用户仓库的分支、暂存区、工作区都不动', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'wip.txt'), '用户自己没提交的东西\n');
  g(dir, 'add', 'wip.txt');
  const statusBefore = g(dir, 'status', '--porcelain');
  const headBefore = g(dir, 'rev-parse', 'HEAD');

  const a = await outputs.prepare({ cwd: dir, isolate: true, parentId: 'task_parent_1' });
  const b = await outputs.prepare({ cwd: dir, isolate: true, parentId: 'task_parent_1' });
  assert.notStrictEqual(a.cwd, b.cwd, '两个子任务各一个工作树');
  assert.match(a.info.branch, /^tb\/collab\//);
  // 两边同时改同一个文件，互不覆盖
  fs.writeFileSync(path.join(a.cwd, 'app.js'), 'console.log("a");\n');
  fs.writeFileSync(path.join(b.cwd, 'app.js'), 'console.log("b");\n');
  fs.mkdirSync(path.join(a.cwd, 'out'));
  fs.writeFileSync(path.join(a.cwd, 'out', 'report.md'), '# 报告\n');
  const ra = await outputs.finalize(a, 'task_child_a');
  const rb = await outputs.finalize(b, 'task_child_b');

  assert.ok(ra.git.changed && rb.git.changed);
  assert.strictEqual(ra.git.files_changed, 1);
  assert.strictEqual(ra.git.ref, 'refs/tokenbank/mesh/task_child_a');
  assert.notStrictEqual(ra.git.head, rb.git.head);
  assert.strictEqual(g(dir, 'show', `${ra.git.ref}:app.js`), 'console.log("a");');
  assert.strictEqual(g(dir, 'show', `${rb.git.ref}:app.js`), 'console.log("b");');
  // 被 .gitignore 忽略的报告不进提交，作为产出文件列出并复制到 outbox
  assert.ok(!g(dir, 'show', '--name-only', '--pretty=', ra.git.head).includes('out/report.md'));
  const report = ra.artifacts.find((x) => x.path === 'out/report.md');
  assert.ok(report && report.sha256 && report.snapshot);

  assert.strictEqual(g(dir, 'status', '--porcelain'), statusBefore, '用户的工作区、暂存区不变');
  assert.strictEqual(g(dir, 'rev-parse', 'HEAD'), headBefore, '用户的分支不变');
  assert.strictEqual(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});

test('不隔离时也不动用户的暂存区：没提交的改动用临时索引记成一个提交', async () => {
  const dir = repo();
  const p = await outputs.prepare({ cwd: dir });
  assert.strictEqual(p.cwd, dir);
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(2);\n');
  const r = await outputs.finalize(p, 'task_inplace');
  assert.ok(r.git.changed && r.git.commits === 1);
  assert.strictEqual(g(dir, 'status', '--porcelain'), 'M app.js', '改动仍然留在工作区，没被暂存');
  assert.strictEqual(g(dir, 'diff', '--cached', '--name-only'), '');
});

test('bundle 取回到另一份克隆：只新建 tb/mesh/ 分支，不切换', async () => {
  const dir = repo();
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-outputs-clone-'));
  execFileSync('git', ['clone', '-q', dir, clone]);
  const p = await outputs.prepare({ cwd: dir, isolate: true, parentId: 'p' });
  fs.writeFileSync(path.join(p.cwd, 'new.js'), 'export default 1;\n');
  const r = await outputs.finalize(p, 'mesh:dev-b:task_42');
  const file = outputs.inboxPath('mesh:dev-b:task_42', 'changes.bundle');
  await new Promise((resolve, reject) => {
    const proc = outputs.bundleStream(r.git, p.info.root);
    proc.stdout.pipe(fs.createWriteStream(file)).on('finish', resolve);
    proc.on('error', reject);
  });
  const got = await outputs.importBundle({ taskId: 'mesh:dev-b:task_42', bundlePath: file, gitInfo: r.git, repoDirs: ['/nonexistent', clone] });
  assert.ok(got.imported, got.reason);
  assert.match(got.branch, /^tb\/mesh\/42$/);
  assert.strictEqual(g(clone, 'rev-parse', got.branch), r.git.head);
  assert.strictEqual(g(clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', '当前分支不变');
  // 找不到有基准提交的仓库：留在收件箱
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-outputs-other-'));
  g(other, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(other, 'x.txt'), '别的项目\n');
  g(other, 'add', '-A');
  g(other, 'commit', '-qm', 'other');
  const miss = await outputs.importBundle({ taskId: 'x', bundlePath: file, gitInfo: r.git, repoDirs: [other] });
  assert.strictEqual(miss.imported, false);
  assert.ok(miss.bundle && /收件箱/.test(miss.reason));
});

test('产出文件后来被改：快照里还有原样；对不上的 sha256 回 changed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-outputs-plain-'));
  const p = await outputs.prepare({ cwd: dir });
  assert.strictEqual(p.info.isGit, false);
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'PDF v1');
  const r = await outputs.finalize(p, 'task_report');
  const art = r.artifacts.find((a) => a.path === 'report.pdf');
  assert.ok(art && art.mime === 'application/pdf');
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'PDF v2 被别人改了');
  const file = await outputs.locateArtifact('task_report', dir, 'report.pdf', art.sha256);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'PDF v1');
  await assert.rejects(() => outputs.locateArtifact('task_report', dir, 'report.pdf', 'f'.repeat(64)), (e) => e.status === 409);
  await assert.rejects(() => outputs.locateArtifact('task_report', dir, '../../etc/passwd', ''), (e) => e.status === 400);
});

test('只读查看：列目录、读文件、diff、log，路径出不了工作区', async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(3);\n');
  const ls = outputs.listDir(dir, '');
  assert.ok(ls.entries.some((e) => e.name === 'app.js') && !ls.entries.some((e) => e.name === '.git'));
  const f = outputs.readFile(dir, 'app.js', 0, 7);
  assert.strictEqual(f.content, 'console');
  assert.strictEqual(f.eof, false);
  assert.match((await outputs.diff(dir, {})).diff, /\+console\.log\(3\)/);
  assert.strictEqual((await outputs.log(dir, 5)).commits[0].subject, 'init');
  assert.throws(() => outputs.readFile(dir, '../outside'), (e) => e.status === 400);
  fs.symlinkSync('/etc', path.join(dir, 'etc-link'));
  assert.throws(() => outputs.listDir(dir, 'etc-link'), (e) => e.status === 400, '软链接解析后再判断');
});
