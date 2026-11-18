import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { client } from "./api";
import type { BackupImportPayload } from "../../worker/routes/admin";

export type BookmarkPayload = {
	title: string;
	url: string;
	description?: string | null;
	icon?: string | null;
	categoryId?: number | null;
	isPinned?: boolean;
	visibility?: "public" | "private";
	tags?: string[];
};

export type CategoryPayload = {
	name: string;
	icon?: string | null;
	parentId?: number | null;
	visibility?: "public" | "private";
};

// 变更成功后统一失效前台列表与后台列表
function useInvalidate() {
	const qc = useQueryClient();
	return () =>
		Promise.all([
			qc.invalidateQueries({ queryKey: ["admin-bookmarks"] }),
			qc.invalidateQueries({ queryKey: ["admin-categories"] }),
			qc.invalidateQueries({ queryKey: ["nav-bookmarks"] }),
		]);
}

export function useAdminBookmarks() {
	return useQuery({
		queryKey: ["admin-bookmarks"],
		queryFn: async () => {
			const res = await client.api.admin.bookmarks.$get();
			if (!res.ok) throw new Error("加载书签失败");
			return res.json();
		},
	});
}

export function useAdminCategories() {
	return useQuery({
		queryKey: ["admin-categories"],
		queryFn: async () => {
			const res = await client.api.admin.categories.$get();
			if (!res.ok) throw new Error("加载分类失败");
			return res.json();
		},
	});
}

export function useSaveBookmark() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async ({ id, data }: { id?: number; data: BookmarkPayload }) => {
			const res = id
				? await client.api.admin.bookmarks[":id"].$put({
						param: { id: String(id) },
						json: data,
					})
				: await client.api.admin.bookmarks.$post({ json: data });
			if (!res.ok) throw new Error("保存失败");
			return res.json();
		},
		onSuccess: async () => {
			await invalidate();
			toast.success("已保存");
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useDeleteBookmark() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async (id: number) => {
			const res = await client.api.admin.bookmarks[":id"].$delete({
				param: { id: String(id) },
			});
			if (!res.ok) throw new Error("删除失败");
		},
		onSuccess: async () => {
			await invalidate();
			toast.success("已删除");
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useReorderBookmarks() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async (ids: number[]) => {
			const res = await client.api.admin.bookmarks.reorder.$put({ json: { ids } });
			if (!res.ok) throw new Error("排序保存失败");
		},
		onSuccess: () => invalidate(),
		onError: (e) => toast.error(e.message),
	});
}

export function useSaveCategory() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async ({ id, data }: { id?: number; data: CategoryPayload }) => {
			const res = id
				? await client.api.admin.categories[":id"].$put({
						param: { id: String(id) },
						json: data,
					})
				: await client.api.admin.categories.$post({ json: data });
			if (!res.ok) {
				// 透出后端具体原因(如层级超限/循环嵌套)
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "保存失败");
			}
			return res.json();
		},
		onSuccess: async () => {
			await invalidate();
			toast.success("已保存");
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useDeleteCategory() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async (id: number) => {
			const res = await client.api.admin.categories[":id"].$delete({
				param: { id: String(id) },
			});
			if (!res.ok) throw new Error("删除失败");
		},
		onSuccess: async () => {
			await invalidate();
			toast.success("已删除");
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useReorderCategories() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async (ids: number[]) => {
			const res = await client.api.admin.categories.reorder.$put({ json: { ids } });
			if (!res.ok) throw new Error("排序保存失败");
		},
		onSuccess: () => invalidate(),
		onError: (e) => toast.error(e.message),
	});
}

export function useFetchMetadata() {
	return useMutation({
		mutationFn: async (url: string) => {
			const res = await client.api.admin.metadata.$post({ json: { url } });
			if (!res.ok) throw new Error("抓取失败,请检查网址是否可访问");
			return res.json() as Promise<{
				title: string | null;
				description: string | null;

			}>;
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useFetchMetadataAI() {
	return useMutation({
		mutationFn: async (url: string) => {
			const res = await client.api.admin["metadata-ai"].$post({ json: { url } });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "AI 分析失败");
			}
			return res.json() as Promise<{
				title: string | null;
				description: string | null;

				tags: string[];
				categoryId: number | null;
			}>;
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useSuggestTags() {
	return useMutation({
		mutationFn: async (input: { title: string; description?: string; url?: string }) => {
			const res = await client.api.admin["suggest-tags"].$post({ json: input });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "AI 标签推荐失败");
			}
			return res.json() as Promise<{ tags: string[] }>;
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useSuggestCategory() {
	return useMutation({
		mutationFn: async (input: { title: string; description?: string; url?: string }) => {
			const res = await client.api.admin["suggest-category"].$post({ json: input });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "AI 分类建议失败");
			}
			return res.json() as Promise<{
				categoryId: number | null;
				categoryName: string | null;
				isNew: boolean;
				reason: string;
			}>;
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useRepairLink() {
	return useMutation({
		mutationFn: async (input: { title: string; url: string }) => {
			const res = await client.api.admin["repair-link"].$post({ json: input });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "AI 死链修复失败");
			}
			return res.json() as Promise<{
				alternative: string | null;
				wayback: string;
				reason: string;
			}>;
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useSummarize() {
	return useMutation({
		mutationFn: async (input: { title: string; description?: string; url?: string }) => {
			const res = await client.api.admin.summarize.$post({ json: input });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "AI 摘要生成失败");
			}
			return res.json() as Promise<{ summary: string }>;
		},
		onError: (e) => toast.error(e.message),
	});
}

// 批量移动书签到指定分类(null = 未分类)
export function useBatchMoveBookmarks() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async ({ ids, categoryId }: { ids: number[]; categoryId: number | null }) => {
			const res = await client.api.admin.bookmarks["batch-category"].$put({
				json: { ids, categoryId },
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "批量移动失败");
			}
			return res.json();
		},
		onSuccess: async (r) => {
			await invalidate();
			toast.success(`已移动 ${r.count} 个书签`);
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useBatchDeleteBookmarks() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async (ids: number[]) => {
			const res = await client.api.admin.bookmarks["batch-delete"].$post({
				json: { ids },
			});
			if (!res.ok) throw new Error("批量删除失败");
			return res.json();
		},
		onSuccess: async (r) => {
			await invalidate();
			toast.success(`已删除 ${r.count} 个书签`);
		},
		onError: (e) => toast.error(e.message),
	});
}

// 批量删除分类(子分类级联删除,直属书签变为未分类)
export function useBatchDeleteCategories() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async (ids: number[]) => {
			const res = await client.api.admin.categories["batch-delete"].$post({
				json: { ids },
			});
			if (!res.ok) throw new Error("批量删除失败");
			return res.json();
		},
		onSuccess: async (r) => {
			await invalidate();
			toast.success(`已删除 ${r.count} 个分类`);
		},
		onError: (e) => toast.error(e.message),
	});
}

// 死链检测:前端分批调用后端(每批 10 个并发),通过 onProgress 回报进度
export function useCheckDeadLinks() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async ({
			ids,
			onProgress,
		}: {
			ids: number[];
			onProgress?: (done: number, total: number) => void;
		}) => {
			let dead = 0;
			let unknown = 0;
			for (let i = 0; i < ids.length; i += 10) {
				const chunk = ids.slice(i, i + 10);
				const res = await client.api.admin["check-links"].$post({
					json: { ids: chunk },
				});
				if (!res.ok) throw new Error("死链检测请求失败");
				const { results } = await res.json();
				dead += results.filter((r) => r.status === "dead").length;
				unknown += results.filter((r) => r.status === "unknown").length;
				onProgress?.(Math.min(i + 10, ids.length), ids.length);
			}
			return { total: ids.length, dead, unknown };
		},
		onSuccess: async ({ total, dead, unknown }) => {
			await invalidate();
			// unknown 的行保持原状态未检测,toast 必须如实说明,否则用户误以为全部检测过
			const parts = [`共 ${total} 个书签`];
			if (dead > 0) parts.push(`死链 ${dead} 个`);
			if (unknown > 0) parts.push(`${unknown} 个无法判定(未改动)`);
			const message = `检测完成:${parts.join(",")}`;
			if (dead > 0) toast.warning(message);
			else toast.success(message);
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useImportBookmarks() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async (html: string) => {
			const res = await client.api.admin.import.$post({ json: { html } });
			if (!res.ok) throw new Error("导入失败,请确认文件是浏览器导出的书签 HTML");
			return res.json();
		},
		onSuccess: async (r) => {
			await invalidate();
			toast.success(
				`导入完成:新增 ${r.bookmarks} 个书签、${r.categories} 个分类` +
					(r.skipped ? `,跳过重复 ${r.skipped} 个` : ""),
			);
		},
		onError: (e) => toast.error(e.message),
	});
}

// 恢复 JSON 备份(buildBackupPayload 产物):合并式,重复跳过,设置仅补缺
export function useImportJson() {
	const invalidate = useInvalidate();
	return useMutation({
		mutationFn: async (payload: BackupImportPayload) => {
			const res = await client.api.admin["import-json"].$post({ json: payload });
			if (!res.ok) throw new Error("恢复失败,请确认文件是本项目导出的 JSON 备份");
			return res.json();
		},
		onSuccess: async (r) => {
			await invalidate();
			toast.success(
				`恢复完成:书签 ${r.bookmarks} 个(跳过 ${r.skipped})、分类 ${r.categories} 个` +
					(r.settingsFilled ? `,补齐设置 ${r.settingsFilled} 项` : ""),
			);
		},
		onError: (e) => toast.error(e.message),
	});
}

// 下载 JSON 备份文件。同样必须走 fetch + Blob:导航式下载会被 SPA 回退拦截
export function useDownloadBackup() {
	return useMutation({
		mutationFn: async () => {
			const res = await client.api.admin.backup.$get();
			if (!res.ok) throw new Error("下载失败,请重试");
			const blob = await res.blob();
			const filename =
				res.headers
					.get("Content-Disposition")
					?.match(/filename="([^"]+)"/)?.[1] ??
				`bookmark-nav-backup-${new Date().toISOString().slice(0, 10)}.json`;
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			return filename;
		},
		onSuccess: (filename) => toast.success(`已下载 ${filename}`),
		onError: (e) => toast.error(e.message),
	});
}

export function useExportBookmarks() {
	return useMutation({
		mutationFn: async () => {
			// 必须走 fetch + Blob:导航式下载会被 SPA 回退拦截,存下来的是 index.html
			const res = await client.api.admin.export.$get();
			if (!res.ok) throw new Error("导出失败,请重试");
			const blob = await res.blob();
			const filename =
				res.headers
					.get("Content-Disposition")
					?.match(/filename="([^"]+)"/)?.[1] ??
				`bookmarks-${new Date().toISOString().slice(0, 10)}.html`;
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
			return filename;
		},
		onSuccess: (filename) => toast.success(`已导出 ${filename}`),
		onError: (e) => toast.error(e.message),
	});
}

export function useBackupNow() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			const res = await client.api.admin.backup.$post();
			if (!res.ok) throw new Error("备份失败");
			return res.json();
		},
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["admin-settings"] });
			toast.success("已备份到 R2 存储");
		},
		onError: (e) => toast.error(e.message),
	});
}

// 立即全量死链检测(与定时任务同一逻辑,不受计划/开关限制)
export function useRunLinkCheck() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async () => {
			const res = await client.api.admin.maintenance["check-links"].$post();
			if (!res.ok) throw new Error("检测失败,请重试");
			return res.json();
		},
		onSuccess: async (r) => {
			await qc.invalidateQueries({ queryKey: ["admin-bookmarks"] });
			toast.success(
				`检测完成:共 ${r.total} 个书签,死链 ${r.dead} 个` +
					(r.revived ? `,恢复 ${r.revived} 个` : "") +
					(r.unknown ? `,${r.unknown} 个无法判定` : ""),
			);
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useAdminSettings() {
	return useQuery({
		queryKey: ["admin-settings"],
		queryFn: async () => {
			const res = await client.api.admin.settings.$get();
			if (!res.ok) throw new Error("加载设置失败");
			return res.json() as Promise<Record<string, string>>;
		},
	});
}

export function useSaveSettings() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (data: Record<string, string>) => {
			const res = await client.api.admin.settings.$put({ json: data });
			if (!res.ok) throw new Error("保存失败");
		},
		onSuccess: async () => {
			await Promise.all([
				qc.invalidateQueries({ queryKey: ["admin-settings"] }),
				qc.invalidateQueries({ queryKey: ["site-settings"] }),
				// 让前台(首页)AI 配置立即失效,返回前台无需手动刷新即可看到 AI 开关
				qc.invalidateQueries({ queryKey: ["ai-config"] }),
			]);
			toast.success("已保存");
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useChangePassword() {
	return useMutation({
		mutationFn: async (data: { oldPassword: string; newPassword: string }) => {
			const res = await client.api.auth["change-password"].$post({ json: data });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "修改失败");
			}
		},
		onSuccess: () => toast.success("密码已修改"),
		onError: (e) => toast.error(e.message),
	});
}

export function useChangeUsername() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (data: { username: string; password: string }) => {
			const res = await client.api.auth["change-username"].$post({ json: data });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "修改失败");
			}
		},
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["auth-status"] });
			toast.success("用户名已修改");
		},
		onError: (e) => toast.error(e.message),
	});
}

export type AIUsageFeatureStat = {
	feature: string;
	total: number;
	success: number;
};
export type AIUsageProviderStat = { provider: string; total: number };
export type AIUsageError = {
	feature: string;
	provider: string;
	error: string | null;
	createdAt: number;
};
export type AIUsage = {
	today: {
		total: number;
		success: number;
		failed: number;
		successRate: number;
		avgDurationMs: number;
	};
	byFeature: AIUsageFeatureStat[];
	byProvider: AIUsageProviderStat[];
	recentErrors: AIUsageError[];
};

export function useAIUsage() {
	return useQuery<AIUsage>({
		queryKey: ["admin-ai-usage"],
		queryFn: async () => {
			const res = await client.api.admin["ai-usage"].$get();
			if (!res.ok) throw new Error("加载 AI 用量失败");
			return res.json();
		},
		refetchInterval: 30_000,
	});
}

export type AITestConfig = {
	provider: "builtin" | "custom";
	apiEndpoint?: string;
	apiKey?: string;
	model: string;
};

// 浏览器插件访问令牌(一用户多个)
export type ApiTokenInfo = {
	id: number;
	name: string;
	hint: string;
	status: "active" | "disabled";
	expiresAt: number | null;
	lastUsedAt: number | null;
	createdAt: number;
};
export type ApiTokenCreated = {
	id: number;
	token: string;
	hint: string;
};

const TOKEN_KEY = ["admin-api-tokens"];

export function useApiTokens() {
	return useQuery({
		queryKey: TOKEN_KEY,
		queryFn: async () => {
			const res = await client.api.admin.tokens.$get();
			if (!res.ok) throw new Error("加载令牌列表失败");
			return res.json();
		},
	});
}

export function useCreateApiToken() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (input: { name: string; expiresAt?: number | null }) => {
			const res = await client.api.admin.tokens.$post({ json: input });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "生成令牌失败");
			}
			return res.json() as Promise<ApiTokenCreated>;
		},
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: TOKEN_KEY });
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useUpdateApiToken() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async ({
			id,
			data,
		}: {
			id: number;
			data: { name?: string; status?: "active" | "disabled" };
		}) => {
			const res = await client.api.admin.tokens[":id"].$patch({
				param: { id: String(id) },
				json: data,
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				throw new Error(body?.error ?? "更新失败");
			}
		},
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: TOKEN_KEY });
			toast.success("已更新");
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useDeleteApiToken() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: async (id: number) => {
			const res = await client.api.admin.tokens[":id"].$delete({
				param: { id: String(id) },
			});
			if (!res.ok) throw new Error("吊销失败");
		},
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: TOKEN_KEY });
			toast.success("令牌已吊销,其他令牌不受影响");
		},
		onError: (e) => toast.error(e.message),
	});
}

export function useTestAI() {
	return useMutation({
		mutationFn: async (cfg: AITestConfig) => {
			const res = await client.api.admin["ai-test"].$post({ json: cfg });
			const body = (await res.json().catch(() => null)) as
				| { ok: true }
				| { ok: false; error?: string }
				| null;
			if (!res.ok || !body?.ok) {
				throw new Error(body && "error" in body && body.error ? body.error : "检测失败");
			}
			return body;
		},
	});
}
