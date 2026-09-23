// 新部署未写入任何设置时的开箱默认值。
// 合并规则:显式保存过的值始终优先(包括空字符串,如清空图标服务即表示关闭),
// 只对缺失的 key 补默认,管理员随时可以在后台覆盖。
export const DEFAULT_SETTINGS: Record<string, string> = {
	// 紧凑模式默认开启:导航站以快速定位为主,小卡片信息密度更高
	"appearance.compact": "1",
	// 分类锚点导航默认关闭:分类少时是视觉噪音,书签多了由管理员在后台打开
	"appearance.anchorNav": "0",
	// 前台右上角默认显示项目仓库入口,便于访客找到源码;不想要可在后台关闭
	"showGithubLink": "1",
	// 前台界面风格:classic 传统卡片,glass 液态玻璃(半透明表面 + 渐变背景)
	"appearance.style": "classic",
	// 图标服务默认走 favicon.im,部署后无需配置即可显示网站图标
	"icon.service": "https://favicon.im/{domain}",
	// 定时任务子开关:初始均关闭,用户可在后台「自动任务」页按需开启
	"maintenance.checkLinks": "0",
	"maintenance.backup": "0",
	// 各任务的运行计划(北京时间):freq=daily|weekly|monthly,每周/每月另有 weekday/monthday
	"deadLink.schedule": '{"freq":"daily","hour":4,"weekday":1,"monthday":1}',
	"backup.schedule": '{"freq":"daily","hour":5,"weekday":1,"monthday":1}',
};

export function mergeDefaultSettings(rows: { key: string; value: string }[]) {
	const map = new Map(rows.map((r) => [r.key, r.value]));
	for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
		if (!map.has(key)) map.set(key, value);
	}
	return Object.fromEntries(map);
}

// 后台「保存设置」接口可写入的键白名单。settings 表还存着系统内部状态
// (deadLink.lastRun / deadLink.dead / backup.lastRun),这些只能由检测/备份任务写入;
// 没有白名单的话,PUT /settings 会接受任意键,脏键将永久留在表里且无法从后台清除。
// 注意:PUBLIC_SETTING_KEYS(公开下发白名单)是这里的子集,公开面比管理面更紧。
export const ADMIN_SETTING_KEYS = new Set([
	// 站点设置
	"siteName",
	"footer",
	"icon.service",
	"showGithubLink",
	// 外观设置
	"appearance.compact",
	"appearance.anchorNav",
	"appearance.style",
	// 自动任务
	"maintenance.checkLinks",
	"maintenance.backup",
	"deadLink.schedule",
	"backup.schedule",
	// AI 设置
	"ai.enabled",
	"ai.provider",
	"ai.apiEndpoint",
	"ai.apiKey",
	"ai.model",
	"ai.features.autoFill",
	"ai.features.tagSuggest",
	"ai.features.semanticSearch",
	"ai.features.summary",
	"ai.features.autoCategorize",
	"ai.features.deadLinkRepair",
]);

// 按白名单切分保存请求:kept 为应写入的键值,ignored 为被拒绝的未知键(返回给前端提示)
export function filterAdminSettings(input: Record<string, string>) {
	const kept: Record<string, string> = {};
	const ignored: string[] = [];
	for (const [key, value] of Object.entries(input)) {
		if (ADMIN_SETTING_KEYS.has(key)) kept[key] = value;
		else ignored.push(key);
	}
	return { kept, ignored };
}

