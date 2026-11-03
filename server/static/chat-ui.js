// 模型 / 智能体网页对话页共用的小工具（无框架依赖）
window.ChatUI = (function () {
  const COLORS = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#db2777', '#0d9488', '#4f46e5', '#0a0a0a']

  function avatarColor(name) {
    let h = 0
    const s = String(name || '')
    for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h)
    return COLORS[Math.abs(h) % COLORS.length]
  }

  /** 给已净化的 HTML 中每个 <pre> 包一层并加「复制」按钮 */
  function wrapCode(html, label) {
    if (!html || html.indexOf('<pre') < 0) return html
    return html
      .replace(/<pre>/g, '<div class="pre"><button type="button" class="copy-btn">' + label + '</button><pre>')
      .replace(/<\/pre>/g, '</pre></div>')
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text)
    return new Promise((resolve) => {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* ignore */ }
      document.body.removeChild(ta)
      resolve()
    })
  }

  /** 消息区委托点击：代码块复制按钮 */
  function onCopyClick(e, copiedLabel, label) {
    const btn = e.target && e.target.closest ? e.target.closest('.copy-btn') : null
    if (!btn) return
    const pre = btn.parentElement && btn.parentElement.querySelector('pre')
    if (!pre) return
    copyText(pre.innerText || '').then(() => {
      btn.textContent = copiedLabel
      setTimeout(() => { btn.textContent = label }, 1400)
    })
  }

  const IMG_URL = /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg)(?:[?#]\S*)?$/i
  const IMG_PATH = /^\/media\/agent\/\S+\.(?:png|jpe?g|gif|webp|svg)(?:[?#]\S*)?$/i

  /** 链接或行内代码若是图片地址，返回可预览的 src */
  function imagePreviewSrc(node) {
    if (!node || !node.closest) return ''
    const el = node.closest('a, code')
    if (!el || el.closest('pre') || !el.closest('.md-body, .afiles')) return ''
    // 渲染时打在文件名上的地址优先，这样封面只写了文件名也能预览
    const marked = el.getAttribute('data-src')
      || (el.closest('a') && el.closest('a').getAttribute('data-src'))
      || ''
    if (IMG_URL.test(marked) || IMG_PATH.test(marked)) return marked
    let raw = ''
    if (el.tagName === 'A') raw = el.getAttribute('href') || ''
    else {
      const parent = el.parentElement && el.parentElement.tagName === 'A' ? el.parentElement : null
      const href = parent ? (parent.getAttribute('href') || '') : ''
      raw = (IMG_URL.test(href) || IMG_PATH.test(href)) ? href : (el.textContent || '')
    }
    raw = String(raw).trim().replace(/[),.;，。；]+$/, '')
    if (IMG_URL.test(raw) || IMG_PATH.test(raw)) return raw
    return ''
  }

  let imgPop = null
  let imgPopSrc = ''

  function ensureImagePop() {
    if (imgPop) return imgPop
    imgPop = document.createElement('div')
    imgPop.className = 'img-hover-pop'
    imgPop.hidden = true
    const img = document.createElement('img')
    img.alt = ''
    img.onload = () => { if (!imgPop.hidden) placeImagePop(imgPop._anchor) }
    img.onerror = () => { imgPop.hidden = true }
    imgPop.appendChild(img)
    document.body.appendChild(imgPop)
    return imgPop
  }

  function placeImagePop(anchor) {
    if (!imgPop || !anchor || !anchor.getBoundingClientRect) return
    const r = anchor.getBoundingClientRect()
    const w = imgPop.offsetWidth || 280
    const h = imgPop.offsetHeight || 180
    let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8)
    let top = r.top - h - 8
    if (top < 8) top = Math.min(r.bottom + 8, window.innerHeight - h - 8)
    imgPop.style.left = left + 'px'
    imgPop.style.top = Math.max(8, top) + 'px'
  }

  /** 悬停图片链接或图片地址时，在旁边显示预览 */
  function showImagePreview(e) {
    const node = e && e.target && e.target.closest ? e.target.closest('a, code') : null
    const src = imagePreviewSrc(node)
    if (!src) {
      // 指针移到普通文字或非图片文件上时收起，避免预览粘住
      if (imgPop && !imgPop.hidden && (!node || node !== imgPop._anchor)) imgPop.hidden = true
      return
    }
    const pop = ensureImagePop()
    const img = pop.querySelector('img')
    pop._anchor = node
    if (imgPopSrc !== src) {
      imgPopSrc = src
      img.src = src
    }
    pop.hidden = false
    placeImagePop(node)
  }

  function hideImagePreview(e) {
    if (!imgPop || imgPop.hidden) return
    const node = e && e.target && e.target.closest ? e.target.closest('a, code') : null
    const to = e && e.relatedTarget
    if (node && to && node.contains(to)) return
    imgPop.hidden = true
  }

  /** textarea 随内容自适应高度（上限由 CSS max-height 控制） */
  function autoGrow(el) {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  return { avatarColor, wrapCode, copyText, onCopyClick, autoGrow, showImagePreview, hideImagePreview }
})()
