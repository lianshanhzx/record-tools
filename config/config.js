var baseUrl = "http://101.89.127.196:11101";//和后端接口(自动化)调用相关的ip地址 

// 截图保存到浏览器默认下载目录下的此子目录，不能配置为操作系统绝对路径。
var screenshotDownloadDirectory = 'TY-record-tools/screenshots';

// Canvas 的像素上限，防止超长页面截图导致浏览器内存耗尽。2500万像素 ≈ 12屏(1920*1080的屏幕)
var screenshotMaxPixels = 25000000;
