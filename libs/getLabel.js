/**
 * 获取元素的可读名称
 * 优先级：aria-label > title > placeholder > 文本内容 > name > id > 图标类名 > tagName
 */
function getElementLabelName(element) {
    if (!element) return '元素';
    
    const tagName = element.tagName.toLowerCase();
    
    // 1. 语义化属性
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();
    
    const title = element.getAttribute('title');
    if (title) return title.trim();
    
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    
    // 2. 文本内容（排除子元素的干扰）
    let directText = '';
    for (const node of element.childNodes) {
        if (node.nodeType === 3) { // 文本节点
            directText += node.textContent.trim();
        }
    }
    if (directText && directText.length >= 2 && directText.length <= 30) {
        return directText;
    }
    
    // 3. 相邻兄弟节点的文本（适用于图标）
    if (['i', 'svg', 'span'].includes(tagName)) {
        const siblings = element.parentNode ? element.parentNode.children : [];
        for (const sib of siblings) {
            if (sib !== element && sib.textContent) {
                const sibText = sib.textContent.trim();
                if (sibText && sibText.length >= 2 && sibText.length <= 20) {
                    return sibText;
                }
            }
        }
    }
    
    // 4. 父级按钮/标签的文本
    const parent = element.closest('button, a, label, [role="button"]');
    if (parent && parent !== element) {
        const parentText = parent.textContent.trim();
        if (parentText && parentText.length >= 2 && parentText.length <= 20) {
            return parentText;
        }
    }
    
    // 5. 图标类名提取
    const classAttr = element.getAttribute('class') || '';
    const classes = classAttr.split(/\s+/);
    for (const cls of classes) {
        // Element UI 图标
        if (/^el-icon-([\w-]+)$/.test(cls)) {
            return cls.replace('el-icon-', '').replace(/-/g, ' ');
        }
        // iconfont 图标
        if (/^icon-([\w-]+)$/.test(cls) && cls !== 'icon') {
            return cls.replace('icon-', '').replace(/-/g, ' ');
        }
        // Lucide 图标
        if (/^lucide-([\w-]+)$/.test(cls) && cls !== 'lucide') {
            return cls.replace('lucide-', '').replace(/-/g, ' ');
        }
        // Font Awesome 图标
        if (/^fa-([\w-]+)$/.test(cls)) {
            return cls.replace('fa-', '').replace(/-/g, ' ');
        }
    }
    
    // 6. name 或 id
    const name = element.getAttribute('name');
    if (name) return name;
    
    const id = element.id;
    if (id && !/^[a-z0-9]{8,}$/i.test(id)) { // 排除动态生成的 ID
        return id;
    }
    
    // 7. 回退到 tagName
    return tagName;
}