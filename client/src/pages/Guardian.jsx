import React from 'react';
import GuardianChat from '../components/GuardianChat';

/**
 * 看护页：就是和看护的对话。侧边栏 Logo 旁的火花图标点进来；有新消息时图标上有未读标记。
 * 没有设置区和列表：做过什么、定过什么规矩、换执行应用，都在对话里问、在对话里办。
 */
export default function Guardian() {
  return (
    <div className="h-full min-h-0 flex">
      <GuardianChat />
    </div>
  );
}
