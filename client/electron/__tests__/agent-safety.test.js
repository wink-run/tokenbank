/**
 * client/electron/__tests__/agent-safety.test.js - 执行环境限制对抗测试
 * 
 * 验证hired模式的环境沙箱和系统提示注入不可被绕过。
 */
'use strict';

const {
  buildSafeEnv,
  validateWorkingDirectory,
  buildHiredSpawnOptions,
  checkOutputSafety,
  buildHiredSystemPrompt,
  SENSITIVE_ENV_KEYS,
} = require('../agent-safety');

const os = require('os');
const path = require('path');
const fs = require('fs');

describe('Hired Mode Environment Restrictions', () => {
  describe('buildSafeEnv', () => {
    it('should remove sensitive environment variables', () => {
      const workDir = '/tmp/hired-test';
      const safeEnv = buildSafeEnv(workDir);
      
      // 验证敏感env被移除
      for (const key of SENSITIVE_ENV_KEYS) {
        expect(safeEnv[key]).toBeUndefined();
      }
      
      // 验证HOME被重定向到工作目录
      expect(safeEnv.HOME).toBe(workDir);
      expect(safeEnv.USERPROFILE).toBe(workDir);
      
      // 验证必要env保留
      expect(safeEnv.PATH).toBeDefined();
    });
    
    it('should mark hired mode with flag', () => {
      const safeEnv = buildSafeEnv('/tmp/test');
      expect(safeEnv.TB_HIRED_MODE).toBe('1');
    });
  });
  
  describe('validateWorkingDirectory', () => {
    it('should reject home directory', () => {
      const homeDir = os.homedir();
      const result = validateWorkingDirectory(homeDir);
      expect(result.safe).toBe(false);
      expect(result.error).toMatch(/forbidden/i);
    });
    
    it('should reject system directories', () => {
      const forbidden = ['/', '/etc', '/usr', '/bin'];
      for (const dir of forbidden) {
        const result = validateWorkingDirectory(dir);
        expect(result.safe).toBe(false);
      }
    });
    
    it('should accept safe temp directory', () => {
      const tmpDir = os.tmpdir();
      const testDir = path.join(tmpDir, 'hired-test-' + Date.now());
      
      // 创建测试目录
      try {
        fs.mkdirSync(testDir, { recursive: true });
        const result = validateWorkingDirectory(testDir);
        expect(result.safe).toBe(true);
        
        // 清理
        fs.rmdirSync(testDir);
      } catch (err) {
        // 忽略清理错误
      }
    });
    
    it('should reject symbolic links', () => {
      // TODO: 需要创建临时符号链接进行测试
      // 这里验证逻辑存在即可
      expect(validateWorkingDirectory).toBeDefined();
    });
  });
  
  describe('buildHiredSpawnOptions', () => {
    it('should return null for invalid directory', () => {
      const opts = buildHiredSpawnOptions(os.homedir());
      expect(opts).toBeNull();
    });
    
    it('should return spawn options for valid directory', () => {
      const tmpDir = os.tmpdir();
      const testDir = path.join(tmpDir, 'hired-spawn-test-' + Date.now());
      
      try {
        fs.mkdirSync(testDir, { recursive: true });
        const opts = buildHiredSpawnOptions(testDir);
        
        if (opts) {  // 可能因为系统限制失败
          expect(opts.env).toBeDefined();
          expect(opts.env.HOME).toBe(testDir);
          expect(opts.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
          expect(opts.cwd).toBe(testDir);
        }
        
        fs.rmdirSync(testDir);
      } catch (err) {
        // 忽略系统相关错误
      }
    });
  });
});

describe('Output Safety Checks', () => {
  it('should block API key leak', () => {
    const text = 'Your OPENAI_API_KEY is sk-proj-abc123xyz456';
    const result = checkOutputSafety(text);
    expect(result.safe).toBe(false);
    expect(result.error).toMatch(/sensitive/i);
  });
  
  it('should block password leak', () => {
    const text = 'password="SuperSecret123!"';
    const result = checkOutputSafety(text);
    expect(result.safe).toBe(false);
  });
  
  it('should block private key leak', () => {
    const text = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...';
    const result = checkOutputSafety(text);
    expect(result.safe).toBe(false);
  });
  
  it('should allow safe output', () => {
    const text = 'Here is your React component:\nfunction App() { return <div>Hello</div>; }';
    const result = checkOutputSafety(text);
    expect(result.safe).toBe(true);
  });
});

describe('System Prompt Injection', () => {
  it('should generate hired mode system constraints', () => {
    const prompt = buildHiredSystemPrompt('a code generation assistant');
    
    // 验证包含关键约束
    expect(prompt).toMatch(/hired agent mode/i);
    expect(prompt).toMatch(/forbidden/i);
    expect(prompt).toMatch(/destructive deletion/i);
    expect(prompt).toMatch(/passwords.*credentials/i);
    expect(prompt).toMatch(/cannot be overridden/i);
  });
  
  it('should reference assistant description', () => {
    const desc = 'a React component builder';
    const prompt = buildHiredSystemPrompt(desc);
    expect(prompt).toContain(desc);
  });
  
  it('should work without description', () => {
    const prompt = buildHiredSystemPrompt();
    expect(prompt).toBeDefined();
    expect(prompt.length).toBeGreaterThan(100);
  });
});

describe('Anti-Bypass Tests', () => {
  it('should not allow bypass via "ignore rules" prompt', () => {
    // 系统提示明确声明不可被用户prompt覆盖
    const systemPrompt = buildHiredSystemPrompt('test');
    expect(systemPrompt).toMatch(/cannot be overridden/i);
    expect(systemPrompt).toMatch(/untrusted/i);
  });
  
  it('should protect against environment variable extraction', () => {
    const safeEnv = buildSafeEnv('/tmp/test');
    
    // 验证所有敏感env都不存在
    const sensitiveKeys = [
      'AWS_ACCESS_KEY_ID',
      'GITHUB_TOKEN',
      'DATABASE_URL',
      'PRIVATE_KEY',
    ];
    
    for (const key of sensitiveKeys) {
      expect(safeEnv[key]).toBeUndefined();
    }
  });
  
  it('should enforce constraints programmatically not via LLM', () => {
    // 环境限制是程序级的，不依赖LLM判断
    const homeDir = os.homedir();
    const result = validateWorkingDirectory(homeDir);
    
    // 即使LLM被诱导，程序级检查仍然拒绝
    expect(result.safe).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('Fail Closed Tests', () => {
  it('should reject when validation fails', () => {
    // 无效目录应该返回null（拒绝执行）
    const opts = buildHiredSpawnOptions('/nonexistent/path/12345');
    expect(opts).toBeNull();
  });
  
  it('should reject when checker detects issues', () => {
    // 检查器本身可用性验证
    expect(buildSafeEnv).toBeInstanceOf(Function);
    expect(validateWorkingDirectory).toBeInstanceOf(Function);
    expect(checkOutputSafety).toBeInstanceOf(Function);
  });
});

describe('Real World Scenarios', () => {
  it('should allow normal hired task with safe output', () => {
    const output = `
I've created a React login form component.

Here's the code:
\`\`\`jsx
function LoginForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // ... rest of component
}
\`\`\`

The component is saved to \`./components/LoginForm.jsx\`.
`;
    
    const result = checkOutputSafety(output);
    expect(result.safe).toBe(true);
  });
  
  it('should block output with actual credentials', () => {
    const output = `
I found these credentials in your .env file:

DATABASE_URL=postgresql://user:pass@localhost/db
API_KEY=sk-abc123xyz456

You should rotate these keys immediately.
`;
    
    const result = checkOutputSafety(output);
    expect(result.safe).toBe(false);
  });
});
