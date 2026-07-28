function uuid() {
  const hexDigits = "0123456789abcdef";
  const s = [];
  for (let i = 0; i < 36; i++) {
    s[i] = hexDigits.substr(Math.floor(Math.random() * 0x10), 1);
  }
  s[14] = "4";
  s[19] = hexDigits.substr((s[19] & 0x3) | 0x8, 1);
  s[8] = s[13] = s[18] = s[23] = "-";
  return s.join("");
}

function action2Json(actions, url) {
  const json = {
    id: uuid(),
    name: 'test',
    url: url,
    tests: [{
      id: uuid(),
      name: 'test',
      commands: []
    }]
  };
  if (actions && Array.isArray(actions)) {
    actions.filter(action => action.propertiesName).forEach(action => {
      json.tests[0].commands.push(action);
    });
  }
  return JSON.stringify(json);
}

function txt2Blob(content) {
  if (content) {
    return new Blob([content]);
  }
  return null;
}

function saveAsBlobFile(blob, fileName) {
  if (!blob || !fileName) return;
  const objectURL = window.URL.createObjectURL(blob);
  if (chrome && chrome.downloads) {
    chrome.downloads.download({
      url: objectURL,
      saveAs: true,
      filename: fileName
    }, () => {
      window.URL.revokeObjectURL(objectURL);
    });
  }
}

function filterRecordData(data) {
  if (!Array.isArray(data)) return [];
  const excludedTargets = [
    '//*[@id="record_stop_btn"]',
    '//*[@id="record_pause_btn"]',
    '//*[@id="record_continue_btn"]',
    'xpath=#record_stop_btn',
    'xpath=#record_pause_btn',
    'xpath=#record_continue_btn'
  ];
  return data.filter(record => !excludedTargets.includes(record.target));
}

function countDuplicatePropertiesName(recordList, currentName) {
  if (!recordList || !currentName) return 0;
  return recordList.reduce((count, item) => {
    if (item.propertiesName) {
      const nameParts = item.propertiesName.split('-');
      if (nameParts[0] === currentName) count++;
    }
    return count;
  }, 0);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { uuid, action2Json, txt2Blob, saveAsBlobFile, filterRecordData, countDuplicatePropertiesName };
} else {
  window.SharedUtils = { uuid, action2Json, txt2Blob, saveAsBlobFile, filterRecordData, countDuplicatePropertiesName };
}
