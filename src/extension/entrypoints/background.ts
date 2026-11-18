// 后台脚本:右键菜单一键收藏 + 角标反馈。
// 无常驻状态:令牌与站点配置每次从 storage 读取(SW 会被随时回收)
export default defineBackground(() => {
	chrome.runtime.onInstalled.addListener(() => {
		chrome.contextMenus.create({
			id: "save-link",
			title: "收藏到 Bookmark Nav",
			contexts: ["link"],
		});
	});

	chrome.contextMenus.onClicked.addListener(async (info) => {
		if (info.menuItemId !== "save-link" || !info.linkUrl) return;
		// linkText 在部分 @types/chrome 版本中缺失,这里做类型拓宽
		const linkText = (info as chrome.contextMenus.OnClickData & { linkText?: string }).linkText;
		await saveLink(info.linkUrl, linkText ?? info.linkUrl);
	});

	async function saveLink(url: string, title: string) {
		const { loadConfig, loadLastSave } = await import("../lib/config");
		const { bookmarkExists, createBookmark } = await import("../lib/api");
		const cfg = await loadConfig();
		const fail = () => setBadge("!", "#dc2626");
		if (!cfg) return fail();
		try {
			if (await bookmarkExists(url)) {
				// 已存在:不再创建,琥珀色 D(Duplicate)角标区别于成功/失败
				setBadge("D", "#d97706");
				return;
			}
			// 沿用 popup 上次选的分类/可见性,让右键收藏和弹窗行为一致
			const last = await loadLastSave();
			const categoryId =
				last && last.categoryId !== "none" ? Number(last.categoryId) : null;
			await createBookmark({
				title: title.slice(0, 200),
				url,
				categoryId,
				visibility: last?.visibility ?? "public",
			});
			setBadge("✓", "#16a34a");
		} catch (err) {
			console.error("[Bookmark Nav] 收藏失败:", err);
			fail();
		}
	}

	function setBadge(text: string, color: string) {
		chrome.action.setBadgeText({ text });
		chrome.action.setBadgeBackgroundColor({ color });
		setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2500);
	}
});
