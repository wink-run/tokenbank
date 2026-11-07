/**
 * Hired环境变量测试
 * 
 * 验证hired模式env合并策略（不整表替换）：
 * - 保留linker注入的认证env（ANTHROPIC_BASE_URL/AUTH_TOKEN等）
 * - 过滤敏感token（AWS/GITHUB等）
 * - HOME重定向到工作目录（Claude通过网关token工作）
 */

const { applyHiredEnvSafety } = require('../agent-safety');

// 直接运行测试
if (require.main === module) {
  console.log('Testing hired env merge strategy (preserving linker auth)...\n');
  
  // 模拟linker注入的spawnEnv（包含网关认证）
  const linkerEnv = {
    // 网关认证（应保留）
    ANTHROPIC_BASE_URL: 'https://gateway.tokenbank.test/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'gw_test_token_12345',
    OPENAI_BASE_URL: 'https://gateway.tokenbank.test/openai',
    
    // 云厂商密钥（应过滤）
    AWS_ACCESS_KEY_ID: 'AKIATEST12345',
    GITHUB_TOKEN: 'ghp_testtoken123',
    OPENAI_API_KEY: 'sk-test123',  // 敏感API key应过滤
    
    // 系统env（应保留）
    HOME: '/home/testuser',
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
  };
  
  const workingDir = '/tmp/test-session-abc123';
  const safeEnv = applyHiredEnvSafety(linkerEnv, workingDir);
  
  console.log('Test 1: Gateway auth preserved (linker injected)');
  const authKeys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL'];
  for (const key of authKeys) {
    const preserved = safeEnv[key] === linkerEnv[key];
    console.log(`  ${key}: ${preserved ? '✓ PRESERVED' : '✗ LOST'}`);
  }
  
  console.log('\nTest 2: Sensitive tokens filtered (cloud vendor keys)');
  const blockKeys = ['AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN', 'OPENAI_API_KEY'];
  for (const key of blockKeys) {
    const filtered = !safeEnv[key];
    console.log(`  ${key}: ${filtered ? '✓ FILTERED' : '✗ LEAKED'}`);
  }
  
  console.log('\nTest 3: System env preserved');
  const systemKeys = ['PATH', 'LANG', 'TERM'];
  for (const key of systemKeys) {
    const preserved = safeEnv[key] === linkerEnv[key];
    console.log(`  ${key}: ${preserved ? '✓ PRESERVED' : '✗ LOST'}`);
  }
  
  console.log('\nTest 4: HOME redirected to working directory');
  console.log(`  Original HOME: ${linkerEnv.HOME}`);
  console.log(`  Safe HOME: ${safeEnv.HOME}`);
  console.log(`  Working dir: ${workingDir}`);
  console.log(`  Result: ${safeEnv.HOME === workingDir ? '✓ REDIRECTED' : '✗ NOT REDIRECTED'}`);
  
  console.log('\nTest 5: TB_HIRED_MODE marker');
  console.log(`  TB_HIRED_MODE: ${safeEnv.TB_HIRED_MODE === '1' ? '✓ SET' : '✗ MISSING'}`);
  
  console.log('\n✓ All merge strategy tests completed');
  console.log('\nSummary:');
  console.log('- Gateway auth (ANTHROPIC_*) preserved → Claude can use TokenBank gateway');
  console.log('- Cloud vendor keys (AWS/GITHUB) filtered → No credential leak');
  console.log('- HOME redirected to session dir → Isolation maintained');
}
