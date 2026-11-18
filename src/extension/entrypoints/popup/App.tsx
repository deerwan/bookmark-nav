import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Settings2, Sparkles } from "lucide-react";
import { Button } from "@app/components/ui/button";
import { Input } from "@app/components/ui/input";
import { Label } from "@app/components/ui/label";
import { Switch } from "@app/components/ui/switch";
import {
	ApiError,
	aiAutoFill,
	bookmarkExists,
	createBookmark,
	flattenCategoryTree,
	fetchAIConfig,
	fetchCategories,
	type Category,
} from "../../lib/api";
import { loadConfig, loadLastSave, saveLastSave } from "../../lib/config";

type Status = "loading" | "unconfigured" | "ready" | "saved";

// 与前台 BookmarkFavicon 一致的首字母回退:同一域名取同一底色
const FAVICON_HUES = [260, 300, 330, 10, 40, 90, 140, 175, 205, 235];
function hashHost(host: string): number {
	let h = 0;
	for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
	return h;
}
function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return "";
	}
}

// 页面预览头图标:优先浏览器给的当前页 favicon,加载失败回退首字母色块
function FaviconTile({ url, favIconUrl }: { url: string; favIconUrl?: string }) {
	const [failed, setFailed] = useState(false);
	const host = hostOf(url);
	const letter = (Array.from(host)[0] ?? "?").toUpperCase();
	const hue = FAVICON_HUES[hashHost(host) % FAVICON_HUES.length];
	if (favIconUrl && !failed)
		return (
			<img
				src={favIconUrl}
				alt=""
				className="size-9 shrink-0 rounded-lg object-contain"
				onError={() => setFailed(true)}
			/>
		);
	return (
		<span
			aria-hidden
			className="flex size-9 shrink-0 items-center justify-center rounded-lg text-sm font-medium text-white"
			style={{ backgroundColor: `oklch(0.62 0.14 ${hue})` }}
		>
			{letter}
		</span>
	);
}

// 按站点给主按钮更具体的文案,比统一的"收藏"更有点击欲
function saveLabel(url: string, duplicate: boolean): string {
	if (duplicate) return "仍然收藏";
	const host = hostOf(url);
	if (/(^|\.)github\.com$/.test(host)) return "收藏这个仓库";
	if (/(^|\.)(x|twitter)\.com$/.test(host)) return "收藏这条推文";
	if (/(^|\.)youtube\.com$/.test(host)) return "收藏这个视频";
	if (/(^|\.)bilibili\.com$/.test(host)) return "收藏这个视频";
	return "收藏这一页";
}

function LoadingSkeleton() {
	return (
		<div className="space-y-3 py-1">
			<div className="flex items-center gap-3">
				<div className="size-9 animate-pulse rounded-lg bg-muted" />
				<div className="flex-1 space-y-2">
					<div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
					<div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
				</div>
			</div>
			<div className="h-8 animate-pulse rounded-lg bg-muted" />
			<div className="h-8 animate-pulse rounded-lg bg-muted" />
			<div className="h-8 animate-pulse rounded-lg bg-muted" />
		</div>
	);
}

export default function App() {
	const [status, setStatus] = useState<Status>("loading");
	const [errorMsg, setErrorMsg] = useState<string | null>(null);
	const [siteUrl, setSiteUrl] = useState("");
	const [tab, setTab] = useState<{ url: string; title: string; favIconUrl?: string } | null>(null);
	const [flatCategories, setFlatCategories] = useState<ReturnType<typeof flattenCategoryTree>>([]);
	// 当前页是否已在书签库中(单条接口异步查询,见 useEffect 内注释)
	const [duplicate, setDuplicate] = useState(false);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [tags, setTags] = useState("");
	const [categoryId, setCategoryId] = useState<string>("none");
	const [isPrivate, setIsPrivate] = useState(false);
	const [saving, setSaving] = useState(false);
	// 保存失败内联展示:不能复用全页 errorMsg 分支,否则表单被整体替换、已填内容不可恢复
	const [saveError, setSaveError] = useState<string | null>(null);
	// 次要字段(标签/描述/私密)默认收起,降低首屏信息量
	const [showMore, setShowMore] = useState(false);
	// AI 智能填充:站点配置了 AI(aiEnabled)才显示入口
	const [aiEnabled, setAiEnabled] = useState(false);
	const [aiLoading, setAiLoading] = useState(false);
	const [aiError, setAiError] = useState<string | null>(null);

	useEffect(() => {
		(async () => {
			const cfg = await loadConfig();
			if (!cfg) {
				setStatus("unconfigured");
				return;
			}
			setSiteUrl(cfg.siteUrl);
			try {
				const [tabs, categories, aiCfg, lastSave] = await Promise.all([
					chrome.tabs.query({ active: true, currentWindow: true }),
					fetchCategories(),
					// AI 可用性单独兜底:失败只影响入口显示,不影响收藏表单
					fetchAIConfig().catch(() => ({ aiEnabled: false })),
					loadLastSave().catch(() => null),
				]);
				const url = tabs[0]?.url;
				if (!url || !/^https?:/.test(url)) {
					setErrorMsg("当前页面不是普通网页,无法收藏");
					return;
				}
				const tabInfo = {
					url,
					title: tabs[0]?.title ?? url,
					favIconUrl: tabs[0]?.favIconUrl,
				};
				setTab(tabInfo);
				const flat = flattenCategoryTree(categories as Category[]);
				setFlatCategories(flat);
				// 预选上次的分类/可见性,但要校验分类仍存在(可能已被删),否则落到「未分类」
				if (lastSave) {
					const stillExists =
						lastSave.categoryId === "none" ||
						flat.some((c) => String(c.category.id) === lastSave.categoryId);
					if (stillExists) {
						setCategoryId(lastSave.categoryId);
						setIsPrivate(lastSave.visibility === "private");
					}
				}
				setAiEnabled(!!aiCfg.aiEnabled);
				// 单条接口查重(全量拉取在千级书签时 popup 明显变慢);失败不阻塞收藏
				bookmarkExists(url)
					.then((r) => setDuplicate(r.exists))
					.catch(() => setDuplicate(false));
				// 预填标题:去掉浏览器标题里常见的「 - 站点名」后缀
				setTitle(tabInfo.title.replace(/ [-–—|] [^|]*$/, "").trim());
				setStatus("ready");
			} catch (err) {
				setErrorMsg(err instanceof Error ? err.message : "加载失败");
			}
		})();
	}, []);

	async function handleSave() {
		if (!tab) return;
		setSaving(true);
		setSaveError(null);
		try {
			await createBookmark({
				title: title.trim() || tab.url,
				url: tab.url,
				description: description.trim() || null,
				categoryId: categoryId === "none" ? null : Number(categoryId),
				visibility: isPrivate ? "private" : "public",
				tags: tags
					.split(/[,，]/)
					.map((t) => t.trim())
					.filter(Boolean),
			});
			// 记住本次分类/可见性,供下次收藏(含右键)预选;不阻塞成功态
			void saveLastSave({ categoryId, visibility: isPrivate ? "private" : "public" });
			setStatus("saved");
		} catch (err) {
			setSaveError(err instanceof ApiError ? err.message : "收藏失败,请重试");
		} finally {
			setSaving(false);
		}
	}

	// AI 智能填充:一次调用同时拿到标题/描述/标签/分类
	async function handleAIFill() {
		if (!tab) return;
		setAiLoading(true);
		setAiError(null);
		try {
			const res = await aiAutoFill(tab.url);
			// 程序赋值不受 Input maxLength 约束,须按服务端 zod 限制裁剪
			// (title 200 / description 500 / 单标签 30 且最多 20),否则保存必 400
			if (res.title) setTitle(res.title.slice(0, 200));
			if (res.description) setDescription(res.description.slice(0, 500));
			if (Array.isArray(res.tags) && res.tags.length)
				setTags(
					res.tags
						.map((t) => t.trim().slice(0, 30))
						.filter(Boolean)
						.slice(0, 20)
						.join(", "),
				);
			// AI 给的 categoryId 须存在于已拉取的分类中,否则 select 显示空白却仍按原值提交
			if (
				res.categoryId != null &&
				flatCategories.some((c) => c.category.id === res.categoryId)
			) {
				setCategoryId(String(res.categoryId));
			}
			// AI 可能填了折叠区里的字段,自动展开让用户看到结果
			if (res.description || (Array.isArray(res.tags) && res.tags.length)) setShowMore(true);
		} catch (err) {
			setAiError(err instanceof ApiError ? err.message : "AI 分析失败,请稍后重试");
		} finally {
			setAiLoading(false);
		}
	}

	function openAdmin() {
		chrome.tabs.create({ url: `${siteUrl}/admin` });
	}

	// 键盘操作:Enter 在输入框/下拉里提交表单,Esc 关闭 popup。
	// handleSave 每次渲染都会重建,用 ref 固定引用,避免 effect 反复解绑/重绑。
	const saveRef = useRef(handleSave);
	saveRef.current = handleSave;
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key === "Escape") window.close();
			if (e.key === "Enter" && !e.isComposing && !e.shiftKey) {
				const el = e.target as HTMLElement | null;
				// 只在表单控件上拦截;按钮上的 Enter 交给浏览器原生点击,避免重复提交
				if (el && /^(INPUT|SELECT)$/.test(el.tagName)) {
					e.preventDefault();
					void saveRef.current();
				}
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, []);

	if (status === "loading") return <Shell><LoadingSkeleton /></Shell>;

	if (errorMsg) {
		return (
			<Shell>
				<p className="flex items-start gap-2 text-sm text-destructive">
					<AlertTriangle className="mt-0.5 size-4 shrink-0" />
					<span>{errorMsg}</span>
				</p>
				<Button variant="outline" className="mt-3 w-full" onClick={() => openAdmin()}>
					打开后台检查
				</Button>
			</Shell>
		);
	}

	if (status === "unconfigured") {
		return (
			<Shell>
				<p className="text-sm text-muted-foreground">首次使用请先配置站点地址与访问令牌。</p>
				<Button className="mt-3 w-full" onClick={() => chrome.runtime.openOptionsPage()}>
					前往配置
				</Button>
			</Shell>
		);
	}

	if (status === "saved") {
		return (
			<Shell>
				<div className="flex flex-col items-center gap-2 py-6">
					<span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
						<Check className="size-5" />
					</span>
					<p className="text-sm font-medium">已收藏到 Bookmark Nav</p>
					{duplicate && <p className="text-sm text-muted-foreground">(该网址之前已收藏过)</p>}
				</div>
				<div className="flex gap-2">
					<Button className="flex-1" onClick={() => window.close()}>
						完成
					</Button>
					<Button variant="outline" className="flex-1" onClick={openAdmin}>
						查看后台
					</Button>
				</div>
			</Shell>
		);
	}

	const hasExtra = !!(tags.trim() || description.trim() || isPrivate);

	return (
		<Shell>
			{/* 页面预览头:让用户一眼确认要收藏的是哪个页面 */}
			{tab && (
				<div className="mb-3 flex items-center gap-3">
					<FaviconTile url={tab.url} favIconUrl={tab.favIconUrl} />
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm font-medium leading-tight">{tab.title}</p>
						<p className="mt-1 truncate text-xs text-muted-foreground">
							{hostOf(tab.url)} · 已预填标题
						</p>
					</div>
				</div>
			)}
			<div className="mb-3 h-px bg-border" />
			{aiEnabled && (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="-ml-2 mb-1 h-7 text-muted-foreground"
					disabled={aiLoading}
					onClick={() => void handleAIFill()}
				>
					<Sparkles className="size-4" />
					{aiLoading ? "AI 分析中…" : "AI 智能填充"}
				</Button>
			)}
			{aiError && <p className="mb-2 text-sm text-destructive">{aiError}</p>}
			{duplicate && (
				<div className="mb-3 flex items-start gap-2 rounded-md bg-amber-100 px-2.5 py-1.5 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300">
					<AlertTriangle className="mt-0.5 size-4 shrink-0" />
					<span>该网址已在书签库中,重复保存会创建两条记录</span>
				</div>
			)}
			<div className="space-y-3">
				<div className="space-y-1.5">
					<Label htmlFor="ext-title">标题</Label>
					<Input
						id="ext-title"
						value={title}
						onChange={(e) => setTitle(e.target.value)}
						maxLength={200}
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="ext-category">分类</Label>
					{/* 原生 select:Radix Select 在扩展 popup 受限环境下定位不稳定 */}
					<select
						id="ext-category"
						value={categoryId}
						onChange={(e) => setCategoryId(e.target.value)}
						className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
					>
						<option value="none">未分类</option>
						{flatCategories.map(({ category, path, depth }) => (
							<option key={category.id} value={String(category.id)}>
								{"　".repeat(depth)}
								{path}
								{category.visibility === "private" ? " (私密)" : ""}
							</option>
						))}
					</select>
				</div>
				<div className="rounded-lg border">
					<button
						type="button"
						aria-expanded={showMore}
						onClick={() => setShowMore((v) => !v)}
						className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-muted-foreground"
					>
						<span>
							更多：标签 · 描述 · 私密
							{hasExtra && !showMore ? "（已填写）" : ""}
						</span>
						<ChevronDown
							className={`size-4 transition-transform ${showMore ? "rotate-180" : ""}`}
						/>
					</button>
					{showMore && (
						<div className="space-y-3 border-t px-3 py-3">
							<div className="space-y-1.5">
								<Label htmlFor="ext-tags">标签(逗号分隔,可选)</Label>
								<Input
									id="ext-tags"
									value={tags}
									onChange={(e) => setTags(e.target.value)}
									placeholder="工具, 文档"
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="ext-desc">描述(可选)</Label>
								<Input
									id="ext-desc"
									value={description}
									onChange={(e) => setDescription(e.target.value)}
									maxLength={500}
								/>
							</div>
							<div className="flex items-center justify-between">
								<div>
									<Label>私密书签</Label>
									<p className="text-sm text-muted-foreground">仅登录后可见</p>
								</div>
								<Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
							</div>
						</div>
					)}
				</div>
				{saveError && <p className="text-sm text-destructive">{saveError}</p>}
				<Button className="w-full" disabled={saving || !title.trim()} onClick={handleSave}>
					{saving ? "保存中…" : saveLabel(tab?.url ?? "", duplicate)}
				</Button>
			</div>
		</Shell>
	);
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<div className="w-[400px] max-h-[600px] overflow-y-auto p-4">
			<div className="mb-3 flex items-center justify-between">
				<h1 className="text-[15px] font-medium tracking-tight">Bookmark Nav 收藏</h1>
				<Button
					variant="ghost"
					size="sm"
					className="h-7 px-2 text-sm text-muted-foreground"
					onClick={() => chrome.runtime.openOptionsPage()}
				>
					<Settings2 className="size-3.5" />
					设置
				</Button>
			</div>
			{children}
		</div>
	);
}
