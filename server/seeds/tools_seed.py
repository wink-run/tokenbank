"""出租智能体市场种子数据（对齐虚拟智能体命名）"""

import asyncio
import logging

from database import connect

logger = logging.getLogger(__name__)


async def seed_tools():
    """插入示例出租智能体数据（用户出租 + 平台虚拟）"""
    
    async with connect() as conn:
        # 检查是否已有数据
        count = await conn.fetch_one("SELECT COUNT(*) as cnt FROM tools")
        if count["cnt"] > 0:
            logger.info("Agents for rent already seeded, skipping")
            return
        
        # 精选出租智能体（用户出租 + 平台虚拟）
        tools_data = [
            {
                "name": "pdf-to-word-agent",
                "display_name": "PDF 转 Word 智能体",
                "description": "把 PDF 变成可编辑的 Word",
                "detail_desc": "上传 PDF，智能体帮你转成 Word，保留格式、图片和表格。转完直接下载，适合改合同、编辑报告。\n\n🤖 由平台虚拟智能体执行（类似虚拟模型，算力由平台提供）",
                "icon": "📄",
                "scene": "office",
                "scene_display_name": "办公文档",
                "featured": 1,
                "trust_level": "virtual",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 2.0,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/agents/pdf-to-word",
            },
            {
                "name": "video-watermark-agent",
                "display_name": "视频去水印智能体",
                "description": "抹掉视频里的水印",
                "detail_desc": "上传视频，智能体自动找水印、抹干净，画质不掉。批量传也行。\n\n👤 由用户出租的智能体执行（开发者出租算力，配置和密钥不出本地）",
                "icon": "🎬",
                "scene": "watermark",
                "scene_display_name": "去水印",
                "featured": 1,
                "trust_level": "user_rented",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 3.0,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/agents/video-watermark",
            },
            {
                "name": "image-bg-remover-agent",
                "display_name": "一键抠图智能体",
                "description": "把人或物从照片里抠出来",
                "detail_desc": "传照片，智能体认出主体，背景全去掉，导出透明 PNG。做电商图、证件照都能用。\n\n🤖 由平台虚拟智能体执行（类似虚拟模型，算力由平台提供）",
                "icon": "🖼️",
                "scene": "image",
                "scene_display_name": "图片处理",
                "featured": 1,
                "trust_level": "virtual",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 1.0,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/agents/remove-bg",
            },
            {
                "name": "image-compress-agent",
                "display_name": "图片压缩智能体",
                "description": "把图片变小但不糊",
                "detail_desc": "传图片，智能体用压缩算法帮你减体积，肉眼看不出区别。支持 JPG、PNG。\n\n👤 由用户出租的智能体执行（开发者出租算力，配置和密钥不出本地）",
                "icon": "🗜️",
                "scene": "image",
                "scene_display_name": "图片处理",
                "featured": 1,
                "trust_level": "user_rented",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 0.5,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/agents/compress",
            },
            {
                "name": "audio-transcribe-agent",
                "display_name": "语音转文字智能体",
                "description": "把录音变成文字稿",
                "detail_desc": "上传音频或视频，智能体自动识别语音转成文字，支持中英文。会议记录、采访整理都能用。\n\n👤 由用户出租的智能体执行（开发者出租算力，配置和密钥不出本地）",
                "icon": "🎙️",
                "scene": "audio",
                "scene_display_name": "音频处理",
                "featured": 1,
                "trust_level": "user_rented",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 2.0,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/agents/transcribe",
            },
        ]
        
        # 插入工具
        for tool in tools_data:
            await conn.execute("""
                INSERT INTO tools 
                (name, display_name, description, detail_desc, icon, scene, scene_display_name, 
                 featured, trust_level, enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            """, [
                tool["name"], tool["display_name"], tool["description"], 
                tool["detail_desc"], tool["icon"], tool["scene"], 
                tool["scene_display_name"], tool["featured"], tool["trust_level"]
            ])
            
            # 获取插入的工具ID
            tool_id = await conn.fetch_one(
                "SELECT id FROM tools WHERE name = ?", 
                [tool["name"]]
            )
            
            # 插入工具版本
            manifest = {
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "file": {"type": "string", "description": "文件路径或URL"}
                    }
                }
            }
            
            await conn.execute("""
                INSERT INTO tool_versions 
                (tool_id, version, pricing_type, pricing_amount, dispatch_type, 
                 dispatch_url, timeout_seconds, manifest, is_active)
                VALUES (?, '1.0.0', ?, ?, ?, ?, 300, ?, 1)
            """, [
                tool_id["id"], 
                tool["pricing_type"], 
                tool["pricing_amount"],
                tool["dispatch_type"],
                tool.get("dispatch_url", ""),
                str(manifest),
            ])
        
        await conn.commit()
        logger.info(f"Seeded {len(tools_data)} agents for rent")


if __name__ == "__main__":
    asyncio.run(seed_tools())
