#!/usr/bin/env python3
"""
真实SQLite数据库集成测试：调用生产/turn/finish handler

测试范围：
- 调用真实database.py的finish_share_turn()函数
- 真实临时SQLite数据库
- turn_task_id清空验证
- messages表更新和artifact持久化验证
- token并发保护验证

测试边界：
- [Python Handler] 真实database.py::finish_share_turn()
- [数据库] 临时SQLite数据库（注入到database.connect）
- [HTTP层] 未测试（见test_playwright_real_page.js）
"""

import os
import sys
import json
import tempfile
import asyncio
from pathlib import Path
from unittest.mock import patch, AsyncMock
from contextlib import asynccontextmanager

# 添加server到path
sys.path.insert(0, str(Path(__file__).parent / 'server'))

print("=== SQLite集成测试：调用生产finish_share_turn ===\n")

results = {
    'tests': [],
    'errors': [],
    'import_errors': [],
}

def add_test(name, passed, detail=''):
    results['tests'].append({'name': name, 'passed': passed, 'detail': detail})
    status = '✓' if passed else '✗'
    print(f"  {status} {name}{': ' + detail if detail else ''}")
    if not passed:
        results['errors'].append(name)

# 尝试import真实的database模块
try:
    print("步骤1: import真实database模块")
    import database
    print(f"  ✓ database模块加载成功: {database.__file__}\n")
    add_test('import database模块', True)
except Exception as e:
    print(f"  ✗ import失败: {e}\n")
    results['import_errors'].append(f"database: {e}")
    add_test('import database模块', False, str(e))
    
    # 如果无法import，尝试单独import需要的依赖
    try:
        import aiosqlite
        print(f"  ✓ aiosqlite可用")
    except ImportError as e2:
        print(f"  ✗ aiosqlite不可用: {e2}")
        results['import_errors'].append(f"aiosqlite: {e2}")
    
    print("\n依赖错误，无法继续测试\n")
    print("=== 测试结果总结 ===\n")
    print(f"import错误: {len(results['import_errors'])} 项")
    for err in results['import_errors']:
        print(f"  - {err}")
    sys.exit(1)

async def run_test():
    # 创建临时数据库
    with tempfile.NamedTemporaryFile(mode='w', suffix='.db', delete=False) as f:
        db_path = f.name
    
    print(f"临时数据库: {db_path}\n")
    
    try:
        # 使用aiosqlite创建临时数据库连接
        import aiosqlite
        
        print("测试1: 初始化临时数据库schema\n")
        
        # 初始化数据库schema
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            
            # 创建agent_chat_shares表（简化版，包含关键字段）
            await db.execute('''
                CREATE TABLE agent_chat_shares (
                    id TEXT PRIMARY KEY,
                    assistant_id TEXT NOT NULL,
                    owner_id INTEGER,
                    messages TEXT,
                    preview TEXT,
                    turn_token TEXT,
                    turn_author TEXT,
                    turn_text TEXT,
                    turn_at INTEGER,
                    turn_task_id TEXT,
                    turn_started_at INTEGER,
                    turn_user_id INTEGER,
                    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                    created_at TEXT DEFAULT CURRENT_TIMESTAMP
                )
            ''')
            
            await db.commit()
        
        add_test('数据库schema创建', True)
        
        print('\n测试2: 插入测试share和active turn\n')
        
        # 插入测试share
        share_id = 'test-share-123'
        async with aiosqlite.connect(db_path) as db:
            await db.execute('''
                INSERT INTO agent_chat_shares 
                (id, assistant_id, owner_id, messages, turn_task_id, turn_token, turn_started_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (
                share_id,
                'test-agent',
                999,
                json.dumps([]),
                'task-active-123',
                'test-turn-token',
                1700000000
            ))
            await db.commit()
        
        add_test('share创建', True, f'share_id={share_id}')
        
        # 验证初始状态
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                'SELECT turn_task_id, turn_token, turn_started_at FROM agent_chat_shares WHERE id = ?',
                (share_id,)
            )
            row = await cursor.fetchone()
        
        add_test('turn_task_id初始设置', row['turn_task_id'] == 'task-active-123')
        add_test('turn_token初始设置', row['turn_token'] == 'test-turn-token')
        add_test('turn_started_at初始设置', row['turn_started_at'] == 1700000000)
        
        print('\n测试3: 调用真实finish_share_turn函数\n')
        
        # 准备测试消息（使用与agent_chat_share.py兼容的格式）
        test_messages = [
            {
                'role': 'user',
                'content': '画一幅画',
                'at': 1700001000,
            },
            {
                'role': 'assistant',
                'content': '画好了，文件在这里：\n\n![empty-room.png](/media/agent/task-test/empty-room.png)\n\n这是一幅图片。',
                'artifacts': [
                    {
                        'name': 'empty-room.png',
                        'url': '/media/agent/task-test/empty-room.png',
                        'kind': 'image',
                        'mime': 'image/png',
                    },
                ],
                'responseId': 'resp-test-789',
                'at': 1700002000,
            },
        ]
        
        messages_json = json.dumps(test_messages, ensure_ascii=False)
        
        # 创建mock PgConnection包装aiosqlite，保留SQL转换
        class MockPgConnection:
            def __init__(self, aio_db):
                self._aio_db = aio_db
                self.row_factory = aiosqlite.Row
            
            def execute(self, sql: str, params: tuple | list = ()):
                # 转换SQL（简化版，只处理NOW()）
                sql = sql.replace('NOW()', "datetime('now')")
                return MockExecuteContext(self._aio_db, sql, tuple(params))
            
            async def commit(self):
                await self._aio_db.commit()
        
        class MockExecuteContext:
            def __init__(self, aio_db, sql, params):
                self._aio_db = aio_db
                self._sql = sql
                self._params = params
                self._cursor = None
            
            def __await__(self):
                return self._ensure_cursor().__await__()
            
            async def _ensure_cursor(self):
                if self._cursor is None:
                    cursor = await self._aio_db.execute(self._sql, self._params)
                    self._cursor = MockCursor(cursor)
                return self._cursor
            
            async def __aenter__(self):
                return await self._ensure_cursor()
            
            async def __aexit__(self, *args):
                pass
        
        class MockCursor:
            def __init__(self, aio_cursor):
                self._cursor = aio_cursor
                self.rowcount = getattr(aio_cursor, 'rowcount', 0)
            
            async def fetchone(self):
                return await self._cursor.fetchone()
            
            async def fetchall(self):
                return await self._cursor.fetchall()
        
        # Patch database.connect()来使用我们的临时数据库
        @asynccontextmanager
        async def mock_connect():
            async with aiosqlite.connect(db_path) as db:
                db.row_factory = aiosqlite.Row
                yield MockPgConnection(db)
        
        print(f"  调用database.finish_share_turn(share_id='{share_id}', token='test-turn-token', messages_json=<{len(messages_json)} chars>)")
        
        with patch('database.connect', mock_connect):
            # 调用真实的finish_share_turn函数
            result = await database.finish_share_turn(share_id, 'test-turn-token', messages_json)
        
        print(f"  返回值: {result}")
        add_test('finish_share_turn调用成功', result is True, f'返回{result}')
        
        print('\n测试4: 验证数据库状态\n')
        
        # 验证turn字段已清空
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                'SELECT turn_task_id, turn_token, turn_started_at, turn_at, turn_author, turn_text, turn_user_id, messages, preview FROM agent_chat_shares WHERE id = ?',
                (share_id,)
            )
            row = await cursor.fetchone()
        
        add_test('turn_task_id已清空', row['turn_task_id'] is None)
        add_test('turn_token已清空', row['turn_token'] is None)
        add_test('turn_started_at已清空', row['turn_started_at'] is None)
        add_test('turn_at已清空', row['turn_at'] is None)
        add_test('turn_author已清空', row['turn_author'] == '')
        add_test('turn_text已清空', row['turn_text'] == '')
        
        # 验证messages已更新
        if row['messages']:
            saved_messages = json.loads(row['messages'])
            add_test('messages已保存', len(saved_messages) == 2, f'{len(saved_messages)} 条')
            
            # 验证assistant消息
            asst_msg = next((m for m in saved_messages if m['role'] == 'assistant'), None)
            if asst_msg:
                add_test('assistant消息有content', asst_msg.get('content') and len(asst_msg['content']) > 0)
                add_test('assistant消息有responseId', asst_msg.get('responseId') == 'resp-test-789')
                
                if asst_msg.get('artifacts'):
                    add_test('artifacts已保存', len(asst_msg['artifacts']) > 0)
                    
                    print(f"\n  assistant消息详情:")
                    print(f"    content: \"{asst_msg['content'][:60]}...\"")
                    print(f"    artifacts: {json.dumps(asst_msg['artifacts'], indent=6)}")
                    print(f"    responseId: {asst_msg['responseId']}")
                else:
                    add_test('artifacts已保存', False, 'no artifacts')
            else:
                add_test('assistant消息有content', False, 'no assistant message')
                add_test('assistant消息有responseId', False, 'no assistant message')
                add_test('artifacts已保存', False, 'no assistant message')
            
            # 验证preview
            if row['preview']:
                add_test('preview已生成', len(row['preview']) > 0)
            else:
                add_test('preview已生成', False, 'preview is empty')
        else:
            add_test('messages已保存', False, 'messages is None')
        
        print('\n测试5: token并发保护（旧token重复finish被拒绝）\n')
        
        # 尝试用相同token再次finish（应该失败，因为token已清空）
        with patch('database.connect', mock_connect):
            result2 = await database.finish_share_turn(share_id, 'test-turn-token', messages_json)
        
        print(f"  第二次finish返回值: {result2}")
        add_test('旧token重复finish被拒绝', result2 is False, f'返回{result2}')
        
        print('\n测试6: 新token不能清除旧任务（验证token匹配）\n')
        
        # 重新设置一个新的turn
        async with aiosqlite.connect(db_path) as db:
            await db.execute('''
                UPDATE agent_chat_shares 
                SET turn_task_id = ?, turn_token = ?, turn_started_at = ?
                WHERE id = ?
            ''', ('task-new-456', 'new-turn-token', 1700003000, share_id))
            await db.commit()
        
        # 尝试用错误的token finish
        with patch('database.connect', mock_connect):
            result3 = await database.finish_share_turn(share_id, 'wrong-token', messages_json)
        
        print(f"  错误token finish返回值: {result3}")
        add_test('错误token finish被拒绝', result3 is False, f'返回{result3}')
        
        # 验证turn_task_id未被清空
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                'SELECT turn_task_id FROM agent_chat_shares WHERE id = ?',
                (share_id,)
            )
            row = await cursor.fetchone()
        
        add_test('错误token不能清除任务', row['turn_task_id'] == 'task-new-456')
        
        print('')
        
    finally:
        # 清理临时数据库
        if os.path.exists(db_path):
            os.unlink(db_path)
            print(f"临时数据库已清理: {db_path}\n")

async def main():
    try:
        await run_test()
    except Exception as e:
        print(f"\n测试执行失败: {e}")
        import traceback
        traceback.print_exc()
        results['errors'].append(f"execution: {e}")
    
    # 打印总结
    print('=== 测试结果总结 ===\n')
    
    passed = len([t for t in results['tests'] if t['passed']])
    total = len(results['tests'])
    
    print(f"总计: {passed}/{total} 个测试通过\n")
    
    print('测试边界说明:')
    print('  [Python Handler] 真实database.py::finish_share_turn()')
    print('  [数据库] 临时SQLite数据库（patch database.connect）')
    print('  [HTTP层] 未测试（见test_playwright_real_page.js）')
    print('')
    
    if results['errors']:
        print('失败的测试:')
        for e in results['errors']:
            print(f"  - {e}")
        print('')
        sys.exit(1)
    
    print('✓ 所有测试通过')
    sys.exit(0)

if __name__ == '__main__':
    asyncio.run(main())
