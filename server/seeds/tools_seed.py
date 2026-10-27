"""工具合集站种子数据"""

import asyncio
import logging

from database import connect

logger = logging.getLogger(__name__)


async def seed_tools():
    """插入示例工具数据"""
    
    async with connect() as conn:
        # 检查是否已有数据
        count = await conn.fetch_one("SELECT COUNT(*) as cnt FROM tools")
        if count["cnt"] > 0:
            logger.info("Tools already seeded, skipping")
            return
        
        # 精选工具列表（V1 精简到 5 个，全部站内调度）
        tools_data = [
            {
                "name": "pdf-to-word",
                "display_name": "PDF 转 Word",
                "description": "办一件事：把 PDF 变成可编辑的 Word",
                "detail_desc": "上传 PDF，智能体帮你转成 Word，保留格式、图片和表格。转完直接下载，适合改合同、编辑报告。\n\n💡 本工具由开发者出租的智能体完成，算力在开发者机器，你只管用。",
                "icon": "📄",
                "scene": "office",
                "scene_display_name": "办公文档",
                "featured": 1,
                "trust_level": "verified",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 2.0,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/tools/pdf-to-word",
            },
            {
                "name": "video-watermark-remover",
                "display_name": "视频去水印",
                "description": "办一件事：抹掉视频里的水印",
                "detail_desc": "上传视频，AI 自动找水印、抹干净，画质不掉。批量传也行。\n\n💡 本工具调用开发者智能体处理，处理完了回传给你，开发者的配置和密钥不出本地。",
                "icon": "🎬",
                "scene": "watermark",
                "scene_display_name": "去水印",
                "featured": 1,
                "trust_level": "verified",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 3.0,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/tools/video-watermark",
            },
            {
                "name": "image-background-remover",
                "display_name": "一键抠图",
                "description": "办一件事：把人或物从照片里抠出来",
                "detail_desc": "传照片，AI 认出主体，背景全去掉，导出透明 PNG。做电商图、证件照都能用。\n\n💡 抠图任务发给开发者出租的智能体，干完了你拿结果。",
                "icon": "🖼️",
                "scene": "image",
                "scene_display_name": "图片处理",
                "featured": 1,
                "trust_level": "official",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 1.0,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/tools/remove-bg",
            },
            {
                "name": "image-compress",
                "display_name": "图片压缩",
                "description": "办一件事：把图片变小但不糊",
                "detail_desc": "传图片，智能压缩算法帮你减体积，肉眼看不出区别。支持 JPG、PNG。\n\n💡 调度到开发者智能体压缩，完成后直接下载。",
                "icon": "🗜️",
                "scene": "image",
                "scene_display_name": "图片处理",
                "featured": 1,
                "trust_level": "community",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 0.5,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/tools/compress",
            },
            {
                "name": "audio-transcribe",
                "display_name": "语音转文字",
                "description": "办一件事：把录音变成文字稿",
                "detail_desc": "上传音频或视频，智能体自动识别语音转成文字，支持中英文。会议记录、采访整理都能用。\n\n💡 转写任务派发到开发者智能体，识别完成后返回文本结果。",
                "icon": "🎙️",
                "scene": "audio",
                "scene_display_name": "音频处理",
                "featured": 1,
                "trust_level": "verified",
                "pricing_type": "ad_or_paid",
                "pricing_amount": 2.0,
                "dispatch_type": "rented_agent",
                "dispatch_url": "http://localhost:8001/tools/transcribe",
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
        logger.info(f"Seeded {len(tools_data)} tools")


if __name__ == "__main__":
    asyncio.run(seed_tools())
