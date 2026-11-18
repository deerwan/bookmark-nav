// 插件页面(chrome-extension:// 源)与主站 localStorage 隔离,读不到主站保存的 theme 偏好;
// 因此跟随系统主题,与主站 ThemeProvider 的 defaultTheme="system" 行为保持一致。
// 若以后需要插件内手动切换主题,可把偏好存进 chrome.storage.local 再在这里读取。
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function syncDarkClass() {
	document.documentElement.classList.toggle("dark", darkQuery.matches);
}

// 在 React 挂载前调用,避免首帧闪白
export function initTheme() {
	syncDarkClass();
	// 系统主题在运行中切换时实时跟随(popup 短命,主要对 options 长驻页有意义)
	darkQuery.addEventListener("change", syncDarkClass);
}
