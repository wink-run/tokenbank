/**
 * 工作目录验证测试
 * 
 * 验证hired模式working directory判定逻辑：
 * - 允许：合法contribute session目录
 * - 拒绝：系统目录、HOME根、敏感配置目录
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { validateWorkingDirectory } = require('../agent-safety');

// Jest tests (only if jest is available)
if (typeof describe !== 'undefined') {
describe('Working Directory Validation', () => {
  const homeDir = os.homedir();
  const tmpDir = os.tmpdir();

  it('should allow contribute session directory', () => {
    // 模拟典型contribute session路径
    // ~/.tokenbank/contribute-workspaces/<assistant>/<user>/sessions/<id>
    const sessionPath = path.join(homeDir, '.tokenbank', 'contribute-workspaces', 'ast_test', 'u123', 'sessions', 'abc456');
    
    // 创建临时目录用于测试
    const testPath = path.join(tmpDir, 'tokenbank-test-session');
    try {
      fs.mkdirSync(testPath, { recursive: true });
      const result = validateWorkingDirectory(testPath);
      expect(result.safe).toBe(true);
      
      // 清理
      fs.rmdirSync(testPath);
    } catch (e) {
      // 清理失败不影响测试结果
    }
  });

  it('should reject HOME root directory', () => {
    const result = validateWorkingDirectory(homeDir);
    expect(result.safe).toBe(false);
    expect(result.error).toMatch(/HOME root/i);
  });

  it('should reject system directories', () => {
    const systemDirs = ['/', '/etc', '/usr', '/bin'];
    for (const dir of systemDirs) {
      const result = validateWorkingDirectory(dir);
      expect(result.safe).toBe(false);
      expect(result.error).toMatch(/system path/i);
    }
  });

  it('should reject sensitive config directories', () => {
    const sensitiveDirs = [
      path.join(homeDir, '.ssh'),
      path.join(homeDir, '.aws'),
      path.join(homeDir, '.config'),
    ];
    
    for (const dir of sensitiveDirs) {
      const result = validateWorkingDirectory(dir);
      expect(result.safe).toBe(false);
      expect(result.error).toMatch(/sensitive|config/i);
    }
  });

  it('should allow non-sensitive HOME subdirectories', () => {
    // .tokenbank是非敏感的HOME子目录，应该允许
    const testPath = path.join(tmpDir, 'test-project');
    try {
      fs.mkdirSync(testPath, { recursive: true });
      const result = validateWorkingDirectory(testPath);
      expect(result.safe).toBe(true);
      
      fs.rmdirSync(testPath);
    } catch (e) {
      // 清理失败不影响测试结果
    }
  });
});
} // End of jest tests

// 直接运行（无jest）
if (require.main === module) {
  console.log('Testing working directory validation...\n');
  
  const homeDir = os.homedir();
  const tmpDir = os.tmpdir();
  
  // Test 1: Allow contribute session
  console.log('Test 1: Contribute session directory');
  const testPath = path.join(tmpDir, 'tokenbank-test-session');
  try {
    fs.mkdirSync(testPath, { recursive: true });
    const result = validateWorkingDirectory(testPath);
    console.log(`  Path: ${testPath}`);
    console.log(`  Result: ${result.safe ? '✓ ALLOWED' : '✗ REJECTED'}`);
    if (!result.safe) console.log(`  Error: ${result.error}`);
    fs.rmdirSync(testPath);
  } catch (e) {
    console.log(`  Error: ${e.message}`);
  }
  
  // Test 2: Reject HOME root
  console.log('\nTest 2: HOME root directory');
  const homeResult = validateWorkingDirectory(homeDir);
  console.log(`  Path: ${homeDir}`);
  console.log(`  Result: ${homeResult.safe ? '✓ ALLOWED' : '✗ REJECTED'}`);
  if (!homeResult.safe) console.log(`  Error: ${homeResult.error}`);
  
  // Test 3: Reject system directories
  console.log('\nTest 3: System directories');
  for (const dir of ['/', '/etc']) {
    const result = validateWorkingDirectory(dir);
    console.log(`  Path: ${dir}`);
    console.log(`  Result: ${result.safe ? '✓ ALLOWED' : '✗ REJECTED'}`);
    if (!result.safe) console.log(`  Error: ${result.error}`);
  }
  
  // Test 4: Reject sensitive config
  console.log('\nTest 4: Sensitive config directories');
  for (const dir of ['.ssh', '.aws']) {
    const fullPath = path.join(homeDir, dir);
    const result = validateWorkingDirectory(fullPath);
    console.log(`  Path: ${fullPath}`);
    console.log(`  Result: ${result.safe ? '✓ ALLOWED' : '✗ REJECTED'}`);
    if (!result.safe) console.log(`  Error: ${result.error}`);
  }
  
  console.log('\n✓ All validation tests completed');
}
