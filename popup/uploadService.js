/**
 * uploadService.js — 上传/下载服务模块
 * 负责录制数据的下载导出和上传到自动化平台。
 *
 * 依赖：
 *   - Utils (libs/utils.js)
 *   - RecordManager (popup/recordManager.js)
 *   - getCurrentTab / sendToContent (popup/index.js 全局函数)
 *   - jQuery (libs/jquery.js)
 */

const UploadService = {

  /**
   * 下载当前录制的动作列表为 JSON 文件。
   * 调用位置：popup/index.js → downloadBtn 点击
   */
  downloadActions() {
    Utils.saveAsBlobFile(Utils.txt2Blob(Utils.action2Json(RecordManager.recordInfoLit, RecordManager.recordDataUrl)), 'result.json')
  },

  /**
   * 下载页面扫描的元素，按显示区域（弹窗/页签/折叠面板）组织为树形结构 JSON 文件。
   * 调用位置：popup/index.js → downloadAllElementsBtn 点击
   */
  async downloadAllElements() {
    // 调用 popup/index.js → getCurrentTab
    const tab = await getCurrentTab()
    if (!tab || !tab.id) { alert('无法获取当前标签页'); return }

    // 调用 popup/index.js → sendToContent
    const resp = await sendToContent(tab.id, { type: 'getScannedElements' })
    if (!resp || !resp.elements || resp.elements.length === 0) {
      alert('暂无扫描元素，请先点击"开始录制"进行扫描')
      return
    }

    // 按显示区域（弹窗/页签/折叠面板）构建树形结构
    const tree = (typeof ElementGrouper !== 'undefined')
      ? ElementGrouper.buildTree(resp.elements)
      : []

    const payload = JSON.stringify({
      id: Utils.uuid(),
      name: 'scanned-elements-tree',
      url: RecordManager.recordDataUrl || tab.url || '',
      scannedAt: Date.now(),
      elementCount: resp.elements.length,
      tree: tree
    }, null, 2)

    const blob = new Blob([payload], { type: 'application/json' })
    const filename = 'scanned-elements-tree-' + new Date().getTime() + '.json'
    Utils.saveAsBlobFile(blob, filename)
  },

  /**
   * 上传录制结果文件到自动化平台。
   * 调用位置：uploadService.js → submitRecordUpload
   */
  uploadTexResult(zdhData) {
    return new Promise((resolve, reject) => {
      const file = new File([Utils.txt2Blob(Utils.action2Json(RecordManager.recordInfoLit, RecordManager.recordDataUrl))], 'result', { type: 'text/plain' })
      const fd = new FormData()
      fd.append('file', file)
      fd.append('mothed', 'By.XPATH')
      fd.append('transcationType', 'web')
      fd.append('transcationId', zdhData.transcationId)
      $.ajax({
        url: zdhData.hostOrigin + '/api/transaction/transcationproperties/importDataByBS',
        type: 'post',
        contentType: false,
        async: true,
        data: fd,
        processData: false,
        beforeSend: function (xhr) { xhr.setRequestHeader('access_token', zdhData.zdh_token) },
        success: function (res) { resolve(res) },
        error: function (err) { reject(err) }
      })
    })
  },

  /**
   * 提交录制结果：从 storage 读取配置后上传。
   * 调用位置：popup/index.js → submitBtn 点击
   */
  submitRecordUpload() {
    const self = this
    const empty = RecordManager.recordInfoLit.filter(item => !item.propertiesName)
    if (empty.length > 0) { alert('请补充业务对象名称！'); return }
    chrome.storage.sync.get('tyAtpData', async (res) => {
      const zdhData = JSON.parse(res.tyAtpData)
      const result = await self.uploadTexResult(zdhData)
      if (result.code === '200') alert(result.msg)
      else alert(result.msg)
    })
  }
}
