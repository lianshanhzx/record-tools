/**
 * autoFormFill.js — 自动填表核心模块
 * 负责扫描 Element UI 表单字段、执行 LLM 返回的填表动作。
 * 支持输入框、下拉框、日期选择器、单选、多选等字段类型。
 *
 * 依赖（由 manifest.json 保证加载顺序）：
 *   - 无外部依赖，独立运行
 *
 * 被调用位置：
 *   - content/messageHandler.js → onMessage (scanFields / executeActions)
 */

const AutoFormFill = {
  /**
   * 获取当前可见的表单容器（对话框/抽屉/整页）。
   * 优先查找可见的 el-dialog，其次 el-drawer，最后降级为 document。
   * 调用位置：autoFormFill.js → scanFields / fillFormField / selectOption / clickButtonForField / findElementByLabel
   */
  getContainer() {
    for (const d of document.querySelectorAll('.el-dialog'))
      if (d.offsetParent !== null) return d
    for (const d of document.querySelectorAll('.el-drawer'))
      if (d.offsetParent !== null) return d
    return document
  },

  /**
   * 识别表单项的字段类型（date/select/radio/checkbox/input/unknown）。
   * 调用位置：autoFormFill.js → scanFields
   */
  classifyField(item) {
    if (item.querySelector('.el-date-editor, .tsscdatepicker, [class*="date-picker"], [class*="datepicker"]')) return 'date'
    const el = item.querySelector('input:not([type="hidden"])')
    if (el && el.closest('.el-date-editor, .tsscdatepicker')) return 'date'
    if (el && el.getAttribute('type') === 'date') return 'date'
    if (item.querySelector('.el-select')) return 'select'
    if (item.querySelector('.el-radio')) return 'radio'
    if (item.querySelector('.el-checkbox')) return 'checkbox'
    if (el || item.querySelector('textarea')) return 'input'
    return 'unknown'
  },

  /**
   * 判断字段是否处于禁用状态。
   * 调用位置：autoFormFill.js → scanFields
   */
  isDisabled(inputEl, trigger) {
    if (trigger) return !!trigger.disabled
    if (inputEl) return !!inputEl.disabled
    return false
  },

  /**
   * 判断字段是否为必填项（通过 class、星号、aria 属性识别）。
   * 调用位置：autoFormFill.js → scanFields
   */
  isRequired(item, label) {
    const hasRequiredClass = !!(item.matches('.is-required') || item.querySelector('.el-form-item__label .el-form-item__label--required'))
    const hasAsterisk = /\*/.test(label)
    const inputEl = item.querySelector('input:not([type="hidden"]), textarea')
    const hasNativeRequired = (inputEl?.required) || (inputEl?.getAttribute('aria-required') === 'true')
    return hasRequiredClass || hasAsterisk || hasNativeRequired
  },

  /**
   * 从 Vue 组件实例读取下拉框选项列表（兼容 Vue2/Vue3）。
   * 调用位置：autoFormFill.js → scanFields
   */
  readVueOptions(trigger) {
    try {
      const selectEl = trigger.closest('.el-select')
      const vm = selectEl && selectEl.__vue__
      if (vm) {
        const data = vm.$data || vm
        if (data.options && Array.isArray(data.options)) {
          return data.options.map(o => {
            if (typeof o === 'string') return o
            return o.label || o.value || o.text || String(o)
          }).filter(Boolean)
        }
        const props = vm.$props || vm
        if (props.options && Array.isArray(props.options)) {
          return props.options.map(o => {
            if (typeof o === 'string') return o
            return o.label || o.value || o.text || String(o)
          }).filter(Boolean)
        }
      }
      const vnode = selectEl && selectEl.__vnode
      if (vnode && vnode.component) {
        const comp = vnode.component
        const props = comp.props || {}
        if (props.options && Array.isArray(props.options)) {
          return props.options.map(o => {
            if (typeof o === 'string') return o
            return o.label || o.value || o.text || String(o)
          }).filter(Boolean)
        }
        const proxy = comp.proxy
        if (proxy && proxy.options && Array.isArray(proxy.options)) {
          return proxy.options.map(o => {
            if (typeof o === 'string') return o
            return o.label || o.value || o.text || String(o)
          }).filter(Boolean)
        }
      }
    } catch (e) {}
    try {
      if (typeof PageElementScanner !== 'undefined' && typeof PageElementScanner.extractSelectOptions === 'function') {
        return PageElementScanner.extractSelectOptions(trigger, trigger)
      }
    } catch (e) {}
    return []
  },

  /**
   * 使用原生 property descriptor 设置输入框值（绕过 Vue/React 框架拦截）。
   * 触发 input/change/blur 事件以通知框架更新状态。
   * 调用位置：autoFormFill.js → fillFormField / fillDateField
   */
  setNativeValue(t, v) {
    const TagProto = t.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(TagProto.prototype, 'value').set
    setter.call(t, v)
    t.setAttribute('value', v)
    t.dispatchEvent(new Event('input', { bubbles: true }))
    t.dispatchEvent(new Event('change', { bubbles: true }))
    setTimeout(() => { t.dispatchEvent(new Event('blur', { bubbles: true })) }, 50)
  },

  /**
   * 填写日期类型字段。
   * 策略：先尝试直接赋值 + 更新 Vue model，失败则通过 UI 交互打开日期选择器并点击目标日期。
   * 调用位置：autoFormFill.js → fillFormField / executeActions
   */
  async fillDateField(target, val) {
    const log = (msg) => console.log('[AutoFill]', msg)
    log('fillDateField 开始, value: ' + val)

    const dateEditor = target.closest('.el-date-editor, .tsscdatepicker')
    if (!dateEditor) {
      this.setNativeValue(target, val)
      return 'ok-date-dom'
    }

    const TagProto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(TagProto.prototype, 'value').set
    setter.call(target, val)
    target.setAttribute('value', val)
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new Event('change', { bubbles: true }))

    const formItem = target.closest('.el-form-item')
    const prop = formItem?.getAttribute('prop') || ''
    log('el-form-item prop: ' + prop)

    const formEl = target.closest('.el-form')
    let updated = false

    if (formEl && formEl.__vue__) {
      try {
        const formVm = formEl.__vue__
        const model = formVm.model || formVm.$props?.model
        if (model && prop) {
          model[prop] = val
          if (typeof formVm.validateField === 'function') {
            try { formVm.validateField(prop) } catch (e) {}
          }
          updated = true
          log('Vue2 el-form model 已更新')
        }
        if (!updated && formVm.$data) {
          for (const key of Object.keys(formVm.$data)) {
            const v = formVm.$data[key]
            if (v && typeof v === 'object' && !Array.isArray(v) && prop in v) {
              v[prop] = val
              if (typeof formVm.validateField === 'function') {
                try { formVm.validateField(prop) } catch (e) {}
              }
              updated = true
              log('Vue2 formVm.$data.' + key + '.' + prop + ' 已更新')
              break
            }
          }
        }
      } catch (e) {
        log('Vue2 form 更新异常: ' + e.message)
      }
    }

    if (!updated) {
      log('尝试通过 UI 交互设置日期...')

      const findVisiblePanel = () => {
        const panels = document.querySelectorAll('.el-picker-panel, .el-date-picker, .el-popper')
        for (const panel of panels) {
          const style = window.getComputedStyle(panel)
          if (style.display !== 'none' && style.visibility !== 'hidden' && panel.offsetParent !== null) {
            if (panel.querySelector('.el-date-table')) {
              return panel
            }
          }
        }
        return null
      }

      const tryOpenPicker = async () => {
        const clickTargets = [
          target,
          dateEditor.querySelector('.el-icon-date'),
          dateEditor.querySelector('.el-input__inner'),
          dateEditor
        ].filter(Boolean)

        for (let attempt = 0; attempt < 3; attempt++) {
          for (const clickTarget of clickTargets) {
            clickTarget.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
            clickTarget.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
            clickTarget.click()
            clickTarget.focus()
          }

          for (let wait = 0; wait < 5; wait++) {
            await new Promise(resolve => setTimeout(resolve, 300))
            const panel = findVisiblePanel()
            if (panel) {
              log('选择器面板已打开 (attempt=' + attempt + ', wait=' + wait + ')')
              return panel
            }
          }
        }
        return null
      }

      try {
        const pickerPanel = await tryOpenPicker()

        if (pickerPanel) {
          const dateParts = val.split('-')
          if (dateParts.length === 3) {
            const targetYear = parseInt(dateParts[0])
            const targetMonth = parseInt(dateParts[1])
            const targetDay = parseInt(dateParts[2])
            log('目标日期: ' + targetYear + '-' + targetMonth + '-' + targetDay)

            const header = pickerPanel.querySelector('.el-date-picker__header')
            if (header) {
              const prevYearBtn = header.querySelector('.el-icon-d-arrow-left')
              const nextYearBtn = header.querySelector('.el-icon-d-arrow-right')
              const prevMonthBtns = header.querySelectorAll('.el-icon-arrow-left')
              const nextMonthBtns = header.querySelectorAll('.el-icon-arrow-right')
              const prevMonthBtn = prevMonthBtns.length > 0 ? prevMonthBtns[prevMonthBtns.length - 1] : null
              const nextMonthBtn = nextMonthBtns.length > 0 ? nextMonthBtns[nextMonthBtns.length - 1] : null

              const yearLabel = header.querySelectorAll('.el-date-picker__header-label')[0]
              const monthLabel = header.querySelectorAll('.el-date-picker__header-label')[1]

              if (yearLabel && monthLabel) {
                let currentYear = parseInt(yearLabel.textContent)
                let currentMonth = parseInt(monthLabel.textContent)
                log('当前显示: ' + currentYear + '年 ' + currentMonth + '月')

                let safety = 0
                while (currentYear > targetYear && prevYearBtn && safety < 50) {
                  prevYearBtn.click()
                  currentYear--
                  safety++
                  await new Promise(resolve => setTimeout(resolve, 30))
                }
                while (currentYear < targetYear && nextYearBtn && safety < 50) {
                  nextYearBtn.click()
                  currentYear++
                  safety++
                  await new Promise(resolve => setTimeout(resolve, 30))
                }

                safety = 0
                while (currentMonth > targetMonth && prevMonthBtn && safety < 12) {
                  prevMonthBtn.click()
                  currentMonth--
                  safety++
                  await new Promise(resolve => setTimeout(resolve, 30))
                }
                while (currentMonth < targetMonth && nextMonthBtn && safety < 12) {
                  nextMonthBtn.click()
                  currentMonth++
                  safety++
                  await new Promise(resolve => setTimeout(resolve, 30))
                }

                log('导航到: ' + currentYear + '年 ' + currentMonth + '月')
              }
            }

            await new Promise(resolve => setTimeout(resolve, 100))

            const dayCells = pickerPanel.querySelectorAll('.el-date-table td')
            log('找到 ' + dayCells.length + ' 个日期单元格')

            for (const cell of dayCells) {
              const cellDay = parseInt(cell.textContent.trim())
              const isPrevMonth = cell.classList.contains('prev-month')
              const isNextMonth = cell.classList.contains('next-month')
              const isDisabled = cell.classList.contains('disabled')

              if (cellDay === targetDay && !isPrevMonth && !isNextMonth && !isDisabled) {
                log('点击日期: ' + targetDay)
                cell.click()
                updated = true
                await new Promise(resolve => setTimeout(resolve, 200))
                break
              }
            }

            if (!updated) {
              log('未找到匹配的日期单元格')
            }
          }
        } else {
          log('未找到日期选择器面板')
        }
      } catch (e) {
        log('UI 交互异常: ' + e.message)
      }
    }

    if (!updated) {
      log('所有策略失败，使用 DOM 直接赋值兜底')
      setTimeout(() => {
        target.dispatchEvent(new Event('blur', { bubbles: true }))
      }, 50)
      updated = true
    }

    document.querySelectorAll('.el-picker-panel,.el-date-picker,.el-time-panel').forEach(x => {
      x.style.display = 'none'
      x.classList.add('is-hidden')
    })

    log('fillDateField 完成, updated: ' + updated)
    return updated ? 'ok-date' : 'ok-date-dom'
  },

  /**
   * 填写普通表单字段（输入框/文本域）。
   * 匹配策略：精确 label → 模糊 label → placeholder → type 属性。
   * 若字段为日期类型，自动委托给 fillDateField 处理。
   * 调用位置：autoFormFill.js → executeActions
   */
  async fillFormField(label, val) {
    console.log('[AutoFill] fillFormField 开始, label:', label, 'value:', val)
    const c = this.getContainer()
    const items = c.querySelectorAll('.el-form-item')
    console.log('[AutoFill] 找到 el-form-item 数量:', items.length)
    for (const item of items) {
      const lbl = item.querySelector('.el-form-item__label')?.textContent?.trim() || ''
      if (lbl !== label) continue
      const input = item.querySelector('input:not([type="hidden"])')
      const textarea = item.querySelector('textarea')
      const target = input || textarea
      if (!target) return 'no-input-found'
      if (target.closest('.el-date-editor, .tsscdatepicker')) {
        return await this.fillDateField(target, val)
      }
      if (target.disabled || target.readOnly) return 'field-disabled'
      this.setNativeValue(target, val)
      return 'ok'
    }
    for (const item of items) {
      const lbl = item.querySelector('.el-form-item__label')?.textContent?.trim() || ''
      if (lbl === label) continue
      if (!lbl.includes(label)) continue
      const input = item.querySelector('input:not([type="hidden"])')
      const textarea = item.querySelector('textarea')
      const target = input || textarea
      if (!target) return 'no-input-found'
      if (target.closest('.el-date-editor, .tsscdatepicker')) {
        return await this.fillDateField(target, val)
      }
      if (target.disabled || target.readOnly) return 'field-disabled'
      this.setNativeValue(target, val)
      return 'ok'
    }
    for (const inp of c.querySelectorAll('input:not([type="hidden"]), textarea')) {
      if (inp.closest('.el-date-editor, .tsscdatepicker')) continue
      const ph = inp.getAttribute('placeholder') || ''
      if (ph.includes(label) && !inp.disabled && !inp.readOnly && inp.offsetParent !== null) {
        this.setNativeValue(inp, val)
        return 'ok-placeholder'
      }
    }
    for (const inp of c.querySelectorAll('input:not([type="hidden"]), textarea')) {
      if (inp.closest('.el-date-editor, .tsscdatepicker')) continue
      const type = inp.getAttribute('type') || 'text'
      if (type.toLowerCase() === label.toLowerCase() && !inp.disabled && !inp.readOnly && inp.offsetParent !== null) {
        this.setNativeValue(inp, val)
        return 'ok-type'
      }
    }
    return 'label-not-found'
  },

  /**
   * 选择下拉框选项。
   * 匹配策略：精确 label → 模糊 label → placeholder。
   * 点击触发区域打开下拉框，然后调用 _pickOption 选择目标选项。
   * 调用位置：autoFormFill.js → executeActions
   */
  selectOption(label, option) {
    return new Promise(resolve => {
      const c = this.getContainer()
      const items = c.querySelectorAll('.el-form-item')
      const getSelectedLabel = (formItem) => {
        const selItem = formItem.querySelector('.el-select-dropdown__item.is-selected')
        if (selItem) return selItem.textContent.trim()
        const tag = formItem.querySelector('.el-select__tags-text')
        if (tag) return tag.textContent.trim()
        const trigger = formItem.querySelector('.el-select .el-input__inner')
        if (trigger) {
          const v = (trigger.value || '').trim()
          if (v) return v
        }
        return null
      }
      for (let pass = 1; pass <= 2; pass++) {
        const exact = pass === 1
        for (const item of items) {
          const lbl = item.querySelector('.el-form-item__label')?.textContent?.trim() || ''
          if (exact) { if (lbl !== label) continue }
          else { if (lbl === label || !lbl.includes(label)) continue }
          const trigger = item.querySelector('.el-select .el-input__inner')
          if (!trigger) { resolve('no-select-found'); return }
          if (trigger.disabled) { resolve('select-disabled'); return }
          const cur = getSelectedLabel(item)
          if (cur) {
            if (cur === option || option.includes(cur) || cur.includes(option)) {
              resolve('already:' + cur)
              return
            }
          }
          trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          trigger.click()
          setTimeout(() => this._pickOption(option, resolve), 600)
          return
        }
      }
      for (const sel of c.querySelectorAll('.el-select .el-input__inner')) {
        const ph = sel.getAttribute('placeholder') || ''
        if (ph.includes(label) && !sel.disabled && sel.offsetParent !== null) {
          sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          sel.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          sel.click()
          setTimeout(() => this._pickOption(option, resolve), 600)
          return
        }
      }
      resolve('label-not-found')
    })
  },

  /**
   * 从下拉框选项列表中选择目标选项（内部辅助方法）。
   * 支持精确匹配、模糊匹配、"第一个"等特殊指令。
   * 若选项不可见，尝试滚动下拉列表后重新查找。
   * 调用位置：autoFormFill.js → selectOption
   */
  _pickOption(option, resolve) {
    let dropdown = document
    for (const dd of document.querySelectorAll('.el-select-dropdown')) {
      if (dd.offsetParent !== null && !dd.classList.contains('is-hidden')) { dropdown = dd; break }
    }
    let items = dropdown.querySelectorAll('.el-select-dropdown__item')
    if (items.length === 0 || dropdown === document) {
      items = document.querySelectorAll('.el-select-dropdown__item')
    }
    const FIRST_ALIASES = ['first', '1st', '第一个', '第一项']
    const tryClick = (item) => {
      item.scrollIntoView({ block: 'nearest' })
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      item.click()
      resolve('ok:' + item.textContent.trim())
    }
    if (FIRST_ALIASES.includes(option.toLowerCase().trim())) {
      for (const item of items) {
        if (item.offsetParent !== null) { tryClick(item); return }
      }
      if (items.length > 0) { tryClick(items[0]); return }
      resolve('no-items'); return
    }
    for (const item of items) {
      if (item.textContent.trim() === option) { tryClick(item); return }
    }
    for (const item of items) {
      if (item.textContent.trim().includes(option)) { tryClick(item); return }
    }
    const scrollable = dropdown.querySelector('.el-select-dropdown__wrap') || dropdown
    if (scrollable.scrollHeight > scrollable.clientHeight) {
      scrollable.scrollTop = scrollable.scrollHeight
      setTimeout(() => {
        const newItems = dropdown.querySelectorAll('.el-select-dropdown__item')
        for (const item of newItems) {
          if (item.textContent.trim() === option) { tryClick(item); return }
        }
        for (const item of newItems) {
          if (item.textContent.trim().includes(option)) { tryClick(item); return }
        }
        const hasEmpty = document.querySelector('.el-select-dropdown__empty')
        if (hasEmpty) { resolve('no-items'); return }
        resolve('option-not-found:' + [...newItems].map(i => i.textContent.trim()).join(', '))
      }, 300)
      return
    }
    const hasEmpty = document.querySelector('.el-select-dropdown__empty')
    if (hasEmpty) { resolve('no-items'); return }
    resolve('option-not-found:' + [...items].map(i => i.textContent.trim()).join(', '))
  },

  /**
   * 扫描当前容器中的所有表单字段，返回字段信息列表。
   * 包含：label、kind、currentValue、options、placeholder、required、disabled、selected、hasButton。
   * 对 select 类型字段，自动调用 readVueOptions 读取选项列表。
   * 调用位置：content/messageHandler.js → onMessage (scanFields)
   */
  scanFields() {
    const container = this.getContainer()
    const allItems = container.querySelectorAll('.el-form-item')
    const fields = []
    const seen = new Set()
    const selectFields = []

    for (const item of allItems) {
      if (seen.has(item)) continue
      seen.add(item)
      const label = item.querySelector('.el-form-item__label')?.textContent?.trim() || ''
      const input = item.querySelector('input:not([type="hidden"])')
      const textarea = item.querySelector('textarea')
      const trigger = item.querySelector('.el-select .el-input__inner')
      if (!label && !input && !textarea && !trigger) continue

      const kind = this.classifyField(item)
      const inputEl = input || textarea
      let currentValue = inputEl?.value || trigger?.value || ''
      if (!currentValue) {
        const ariaInput = item.querySelector('[aria-valuetext]') || item.querySelector('[aria-valuenow]')
        if (ariaInput) currentValue = ariaInput.getAttribute('aria-valuetext') || ariaInput.getAttribute('aria-valuenow') || ''
      }
      if (!currentValue && trigger) currentValue = trigger.getAttribute('aria-label') || trigger.getAttribute('title') || ''
      const placeholder = (inputEl || trigger)?.getAttribute?.('placeholder') || ''
      const disabled = this.isDisabled(inputEl, trigger)
      const required = this.isRequired(item, label)
      const selected = !!(trigger && item.querySelector('.el-select-dropdown__item.is-selected, .el-select__tags-text'))
      const hasButton = !!item.querySelector('button.el-button--primary, button.el-button--primary.is-plain') ||
        ['选择', '获取地址', '引入', '新增', '添加'].some(t => {
          const btns = item.querySelectorAll('button')
          for (let i = 0; i < btns.length; i++) {
            if (btns[i].textContent.includes(t)) return true
          }
          return false
        })

      const field = { label, kind, currentValue, options: [], placeholder, required, disabled, selected, hasButton }
      fields.push(field)
      if (kind === 'select') {
        selectFields.push({ field, trigger: trigger || item.querySelector('input:not([type="hidden"])') })
      }
    }

    for (const { field, trigger } of selectFields) {
      if (!trigger) continue
      const opts = this.readVueOptions(trigger)
      if (opts.length > 0) {
        field.options = opts
      } else if (field.currentValue) {
        field.options = [field.currentValue]
      }
    }

    return fields
  },

  /**
   * 规范化 LLM 返回的动作类型，统一映射为标准动作名称。
   * 调用位置：autoFormFill.js → executeActions
   */
  normalizeAction(a) {
    const t = (a.action || '').toLowerCase().replace(/[-\s]/g, '_')
    if (t === 'fill_input' || t === 'fill' || t === 'input' || t === 'fillinput' || t === 'fill_form_field') return { ...a, action: 'fill_form_field' }
    if (t === 'fill_date_field' || t === 'fill_date') return { ...a, action: 'fill_date_field' }
    if (t === 'click_element_by_index' || t === 'click') return { ...a, action: 'click_element_by_index' }
    if (t === 'select_option' || t === 'select' || t === 'option' || t === 'selectoption') return { ...a, action: 'select_option' }
    if (t === 'select_tree_option') return { ...a, action: 'select_tree_option' }
    return a
  },

  /**
   * 根据 label 和字段类型查找对应的 DOM 元素。
   * 匹配策略：精确 label → 模糊 label。
   * 调用位置：content/messageHandler.js → onMessage (executeActions) 中生成 XPath
   */
  findElementByLabel(label, kind) {
    const c = this.getContainer()
    const items = c.querySelectorAll('.el-form-item')
    for (const item of items) {
      const lbl = item.querySelector('.el-form-item__label')?.textContent?.trim() || ''
      if (lbl !== label) continue
      if (kind === 'select' || kind === 'select_option') {
        const trigger = item.querySelector('.el-select .el-input__inner')
        if (trigger) return trigger
      }
      const input = item.querySelector('input:not([type="hidden"])')
      const textarea = item.querySelector('textarea')
      return input || textarea
    }
    for (const item of items) {
      const lbl = item.querySelector('.el-form-item__label')?.textContent?.trim() || ''
      if (lbl === label || !lbl.includes(label)) continue
      if (kind === 'select' || kind === 'select_option') {
        const trigger = item.querySelector('.el-select .el-input__inner')
        if (trigger) return trigger
      }
      const input = item.querySelector('input:not([type="hidden"])')
      const textarea = item.querySelector('textarea')
      return input || textarea
    }
    return null
  },

  /**
   * 生成 UUID v4 字符串（内部使用，与 Utils.uuid 功能相同）。
   * 调用位置：content/messageHandler.js → onMessage (executeActions) 中生成动作 ID
   */
  _uuid() {
    const hexDigits = '0123456789abcdef'
    const s = []
    for (let i = 0; i < 36; i++) {
      s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1)
    }
    s[14] = '4'
    s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1)
    s[8] = s[13] = s[18] = s[23] = '-'
    return s.join('')
  },

  /**
   * 批量执行 LLM 返回的填表动作。
   * 支持动作类型：fill_form_field / fill_date_field / select_option / click_element_by_index。
   * 每执行一个动作，通过 chrome.runtime.sendMessage 发送进度通知。
   * 调用位置：content/messageHandler.js → onMessage (executeActions)
   */
  async executeActions(actions) {
    const results = []
    console.log('[AutoFill] 开始执行动作，总数:', actions.length)
    console.log('[AutoFill] 动作列表:', JSON.stringify(actions, null, 2))
    for (let i = 0; i < actions.length; i++) {
      let action = this.normalizeAction(actions[i])
      const { action: type, label, value, option } = action
      let result = 'unknown-action'
      try {
        console.log('[AutoFill] 执行动作 #' + (i + 1) + '/' + actions.length, 'type:', type, 'label:', label, 'value:', value || option)
        if (type === 'fill_form_field' || type === 'fill_date_field') {
          result = await this.fillFormField(label, value)
          console.log('[AutoFill] fillFormField 结果:', result, 'label:', label)
        } else if (type === 'select_option') {
          result = await this.selectOption(label, option || value)
          console.log('[AutoFill] selectOption 结果:', result, 'label:', label)
        } else if (type === 'fill_input') {
          result = await this.fillFormField(label, value)
          console.log('[AutoFill] fill_input 结果:', result, 'label:', label)
        } else if (type === 'click_element_by_index') {
          result = await this.clickButtonForField(label)
          console.log('[AutoFill] clickButtonForField 结果:', result, 'label:', label)
        }
      } catch (e) {
        result = 'error: ' + e.message
        console.error('[AutoFill] 动作执行异常:', e, 'label:', label)
      }
      const val = value || option
      const entry = { index: i + 1, action: type, label, value: val, result }
      results.push(entry)
      chrome.runtime.sendMessage({ type: 'actionProgress', data: entry })
      await new Promise(r => setTimeout(r, 400))
    }
    console.log('[AutoFill] 全部动作执行完成，结果:', JSON.stringify(results, null, 2))
    return results
  },

  /**
   * 点击字段旁边的按钮（如"选择"、"获取地址"等）。
   * 用于用户未提供值、需要通过弹窗/选择器选择的场景。
   * 调用位置：autoFormFill.js → executeActions
   */
  async clickButtonForField(label) {
    const c = this.getContainer()
    const items = c.querySelectorAll('.el-form-item')
    let targetItem = null
    for (const item of items) {
      const lbl = item.querySelector('.el-form-item__label')?.textContent?.trim() || ''
      if (lbl === label) { targetItem = item; break }
    }
    if (!targetItem) {
      for (const item of items) {
        const lbl = item.querySelector('.el-form-item__label')?.textContent?.trim() || ''
        if (lbl.includes(label)) { targetItem = item; break }
      }
    }
    if (!targetItem) return 'label-not-found'
    const btn = targetItem.querySelector('button')
    if (!btn) return 'no-button-found'
    btn.click()
    return 'clicked:' + btn.textContent.trim()
  },
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutoFormFill
} else {
  window.AutoFormFill = AutoFormFill
}
