const AutoFormFill = {
  getContainer() {
    for (const d of document.querySelectorAll('.el-dialog'))
      if (d.offsetParent !== null) return d
    for (const d of document.querySelectorAll('.el-drawer'))
      if (d.offsetParent !== null) return d
    return document
  },

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

  isDisabled(inputEl, trigger) {
    if (trigger) return !!trigger.disabled
    if (inputEl) return !!inputEl.disabled
    return false
  },

  isRequired(item, label) {
    const hasRequiredClass = !!(item.matches('.is-required') || item.querySelector('.el-form-item__label .el-form-item__label--required'))
    const hasAsterisk = /\*/.test(label)
    const inputEl = item.querySelector('input:not([type="hidden"]), textarea')
    const hasNativeRequired = (inputEl?.required) || (inputEl?.getAttribute('aria-required') === 'true')
    return hasRequiredClass || hasAsterisk || hasNativeRequired
  },

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
    } catch (e) {}
    return []
  },

  setNativeValue(t, v) {
    const TagProto = t.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(TagProto.prototype, 'value').set
    setter.call(t, v)
    t.setAttribute('value', v)
    t.dispatchEvent(new Event('input', { bubbles: true }))
    t.dispatchEvent(new Event('change', { bubbles: true }))
    t.dispatchEvent(new Event('blur', { bubbles: true }))
  },

  fillFormField(label, val) {
    const c = this.getContainer()
    const items = c.querySelectorAll('.el-form-item')
    for (const item of items) {
      const lbl = item.querySelector('.el-form-item__label')?.textContent?.trim() || ''
      if (lbl !== label) continue
      const input = item.querySelector('input:not([type="hidden"])')
      const textarea = item.querySelector('textarea')
      const target = input || textarea
      if (!target) return 'no-input-found'
      if (target.disabled || target.readOnly) return 'field-disabled'
      if (target.closest('.el-date-editor, .tsscdatepicker')) {
        target.focus()
        this.setNativeValue(target, val)
        target.blur()
        try { let vm = target.__vue__; if (vm) { let p = vm.$parent; if (p && p.$options && p.$options.name === 'ElDatePicker') { p.value = val; p.$emit('input', val); p.$emit('change', val) } } } catch (e) {}
        document.querySelectorAll('.el-picker-panel,.el-date-picker').forEach(x => { x.style.display = 'none'; x.classList.add('is-hidden') })
        return 'ok-date'
      }
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
      if (target.disabled || target.readOnly) return 'field-disabled'
      if (target.closest('.el-date-editor, .tsscdatepicker')) {
        target.focus()
        this.setNativeValue(target, val)
        target.blur()
        try { let vm = target.__vue__; if (vm) { let p = vm.$parent; if (p && p.$options && p.$options.name === 'ElDatePicker') { p.value = val; p.$emit('input', val); p.$emit('change', val) } } } catch (e) {}
        document.querySelectorAll('.el-picker-panel,.el-date-picker').forEach(x => { x.style.display = 'none'; x.classList.add('is-hidden') })
        return 'ok-date'
      }
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
    const hasEmpty = document.querySelector('.el-select-dropdown__empty')
    if (hasEmpty) { resolve('no-items'); return }
    resolve('option-not-found:' + [...items].map(i => i.textContent.trim()).join(', '))
  },

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

  normalizeAction(a) {
    const t = (a.action || '').toLowerCase().replace(/[-\s]/g, '_')
    if (t === 'fill_input' || t === 'fill' || t === 'input' || t === 'fillinput') return { ...a, action: 'fill_input' }
    if (t === 'select_option' || t === 'select' || t === 'option' || t === 'selectoption') return { ...a, action: 'select_option' }
    return a
  },

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

  async executeActions(actions) {
    const results = []
    for (let i = 0; i < actions.length; i++) {
      let action = this.normalizeAction(actions[i])
      const { action: type, label, value, option } = action
      let result = 'unknown-action'
      try {
        if (type === 'fill_input') {
          result = this.fillFormField(label, value)
        } else if (type === 'select_option') {
          result = await this.selectOption(label, option || value)
        }
      } catch (e) {
        result = `error: ${e.message}`
      }
      const val = value || option
      const entry = { index: i + 1, action: type, label, value: val, result }
      results.push(entry)
      chrome.runtime.sendMessage({ type: 'actionProgress', data: entry })
      await new Promise(r => setTimeout(r, 400))
    }
    return results
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutoFormFill
} else {
  window.AutoFormFill = AutoFormFill
}
