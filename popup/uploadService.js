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
   * 上传截图文件，接口业务状态 code=200 且 downloadUrl 非空时才视为成功。
   */
  uploadScreenshot(blob, filename) {
    return new Promise((resolve, reject) => {
      const baseUrl = String(typeof BASEURL === 'undefined' ? '' : BASEURL).trim().replace(/\/+$/, '')
      if (!baseUrl) {
        reject(new Error('未配置截图上传服务地址 BASEURL'))
        return
      }

      const fileName = String(filename || 'screenshot.png').split('/').pop()
      const fd = new FormData()
      fd.append('file', new File([blob], fileName, { type: blob.type || 'image/png' }))

      $.ajax({
        url: baseUrl + '/api/common/paasfile/uploadTranscationFile',
        type: 'post',
        contentType: false,
        async: true,
        data: fd,
        processData: false,
        success: function (res) {
          let result = res
          if (typeof result === 'string') {
            try {
              result = JSON.parse(result)
            } catch (e) {
              reject(new Error('截图上传接口返回格式错误'))
              return
            }
          }
          if (!result || Number(result.code) !== 200) {
            reject(new Error((result && (result.msg || result.message)) || '截图上传失败，接口返回 code=' + (result && result.code)))
            return
          }
          const downloadUrl = String(result.downloadUrl || '').trim()
          if (!downloadUrl) {
            reject(new Error('截图上传成功，但接口未返回 downloadUrl'))
            return
          }
          resolve(downloadUrl)
        },
        error: function (xhr) {
          let message = '截图上传请求失败'
          const response = xhr && xhr.responseJSON
          if (response && (response.msg || response.message)) message += '：' + (response.msg || response.message)
          else if (xhr && xhr.status) message += '（HTTP ' + xhr.status + '）'
          reject(new Error(message))
        }
      })
    })
  },

  /** 生成当前录制动作的 JSON 文本。 */
  buildActionExportContent() {
    return Utils.actionTree2Json(RecordManager.buildExportGroups(), RecordManager.recordDataUrl, RecordManager.pageId)
  },

  /** 下载当前录制的动作列表为 JSON 文件。 */
  downloadActionsJson() {
    const content = this.buildActionExportContent()
    Utils.saveAsBlobFile(new Blob([content], { type: 'application/json;charset=utf-8' }), 'result.json')
  },

  /** 下载当前录制的动作列表为 TXT 文件，内容仍采用 JSON 数据结构。 */
  downloadActionsTxt() {
    const content = this.buildActionExportContent()
    Utils.saveAsBlobFile(new Blob([content], { type: 'text/plain;charset=utf-8' }), 'result.txt')
  },

  /**
   * 下载页面扫描的元素，按显示区域（弹窗/页签/折叠面板）组织为树形结构 JSON 文件。
   * 调用位置：popup/index.js → downloadAllElementsBtn 点击
   */
  async downloadAllElements() {
    const tab = await getCurrentTab()
    if (!tab || !tab.id) { alert('无法获取当前标签页'); return }

    const elements = RecordManager.scannedElementList || []
    if (elements.length === 0) {
      alert('暂无扫描元素，请先点击"开始录制"进行扫描')
      return
    }

    // 按显示区域（弹窗/页签/折叠面板）构建树形结构
    const tree = (typeof ElementGrouper !== 'undefined')
      ? ElementGrouper.buildTree(elements)
      : []

    const payload = JSON.stringify({
      id: Utils.uuid(),
      name: 'scanned-elements-tree',
      url: RecordManager.recordDataUrl || tab.url || '',
      scannedAt: Date.now(),
      elementCount: elements.length,
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
      const file = new File([Utils.txt2Blob(this.buildActionExportContent())], 'result', { type: 'text/plain' })
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
      try {
        if (!res.tyAtpData) throw new Error('未找到自动化平台连接配置')
        const zdhData = JSON.parse(res.tyAtpData)
        if (!zdhData.hostOrigin || !zdhData.transcationId || !zdhData.zdh_token) {
          throw new Error('自动化平台连接配置不完整')
        }
        const result = await self.uploadTexResult(zdhData)
        alert(result?.msg || '提交完成')
      } catch (error) {
        alert('提交失败：' + (error?.message || String(error)))
      }
    })
  }
}
