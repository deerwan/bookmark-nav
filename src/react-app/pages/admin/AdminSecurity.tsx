import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuthStatus } from "@/lib/queries";
import {
	useChangePassword,
	useChangeUsername,
	useCreateApiToken,
	useApiTokens,
	useUpdateApiToken,
	useDeleteApiToken,
	type ApiTokenCreated,
} from "@/lib/admin-queries";
import { ConfirmDialog, type ConfirmState } from "@/components/confirm-dialog";

function formatTime(ts: number | null, label: string) {
	return ts ? `${label} ${new Date(ts).toLocaleString()}` : null;
}

// 浏览器插件令牌:一用户多个,每台设备/用途一个,可单独启停/吊销
function ApiTokenCard() {
	const { data, isPending, isError, refetch } = useApiTokens();
	const createToken = useCreateApiToken();
	const updateToken = useUpdateApiToken();
	const deleteToken = useDeleteApiToken();
	const [confirm, setConfirm] = useState<ConfirmState | null>(null);
	// 新建弹窗
	const [createOpen, setCreateOpen] = useState(false);
	const [newName, setNewName] = useState("");
	// 刚生成的明文令牌,只在本次展示一次;关闭后不再可查看
	const [fresh, setFresh] = useState<ApiTokenCreated | null>(null);

	function handleCreate(e: FormEvent) {
		e.preventDefault();
		const name = newName.trim();
		if (!name) return;
		createToken.mutate(
			{ name },
			{
				onSuccess: (created) => {
					setFresh(created);
					setNewName("");
					setCreateOpen(false);
				},
			},
		);
	}

	function askToggle(id: number, current: "active" | "disabled", name: string) {
		const next = current === "active" ? "disabled" : "active";
		setConfirm({
			title: next === "disabled" ? `停用「${name}」?` : `启用「${name}」?`,
			description:
				next === "disabled"
					? "使用该令牌的插件将立即失去访问权限,可随时重新启用。"
					: "启用后使用该令牌的插件恢复访问。",
			confirmText: next === "disabled" ? "停用" : "启用",
			onConfirm: () => updateToken.mutate({ id, data: { status: next } }),
		});
	}

	function askDelete(id: number, name: string) {
		setConfirm({
			title: `吊销「${name}」?`,
			description: "使用该令牌的插件将立即失效,其他令牌不受影响。此操作不可撤销。",
			confirmText: "吊销",
			onConfirm: () => {
				if (fresh?.id === id) setFresh(null);
				deleteToken.mutate(id);
			},
		});
	}

	function handleCopy() {
		if (!fresh) return;
		navigator.clipboard
			.writeText(fresh.token)
			.then(() => toast.success("已复制到剪贴板"))
			.catch(() => toast.error("复制失败,请手动选择复制"));
	}

	const tokens = data?.tokens ?? [];

	return (
		<Card>
			<CardHeader className="flex flex-row items-start justify-between gap-4">
				<div>
					<CardTitle>浏览器插件令牌</CardTitle>
					<CardDescription>
						建议每台设备/每个浏览器创建一个令牌,便于单独吊销。改密码会撤销全部令牌。
					</CardDescription>
				</div>
				<Button
					type="button"
					size="sm"
					disabled={tokens.length >= 20}
					onClick={() => setCreateOpen(true)}
				>
					新建令牌
				</Button>
			</CardHeader>
			<CardContent className="space-y-4">
				{fresh && (
					<div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
						<Label htmlFor="api-token">
							令牌「{tokens.find((t) => t.id === fresh.id)?.name ?? "新令牌"}」— 仅此一次,关闭后不可再查看
						</Label>
						<div className="flex gap-2">
							<Input id="api-token" readOnly value={fresh.token} className="font-mono text-xs" />
							<Button type="button" variant="outline" onClick={handleCopy}>
								复制
							</Button>
							<Button type="button" variant="ghost" onClick={() => setFresh(null)}>
								我已保存
							</Button>
						</div>
					</div>
				)}

				{isError ? (
					<button type="button" className="text-sm text-muted-foreground underline underline-offset-2" onClick={() => refetch()}>
						令牌列表加载失败,点击重试
					</button>
				) : isPending ? (
					<p className="text-sm text-muted-foreground">加载中…</p>
				) : tokens.length === 0 ? (
					<p className="text-sm text-muted-foreground">还没有令牌,点右上角「新建令牌」开始。</p>
				) : (
					<div className="divide-y rounded-lg border">
						{tokens.map((t) => (
							<div key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
								<div className="min-w-0 space-y-0.5">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium">{t.name}</span>
										<Badge variant={t.status === "active" ? "secondary" : "outline"}>
											{t.status === "active" ? "启用" : "已停用"}
										</Badge>
									</div>
									<p className="font-mono text-xs text-muted-foreground">bnav_…{t.hint}</p>
									<p className="text-xs text-muted-foreground">
										{[
											formatTime(t.createdAt, "创建于"),
											formatTime(t.lastUsedAt, "最后使用"),
											formatTime(t.expiresAt, "过期于"),
										]
											.filter(Boolean)
											.join(" · ")}
									</p>
								</div>
								<div className="flex shrink-0 gap-1">
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => askToggle(t.id, t.status, t.name)}
									>
										{t.status === "active" ? "停用" : "启用"}
									</Button>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="text-destructive"
										onClick={() => askDelete(t.id, t.name)}
									>
										吊销
									</Button>
								</div>
							</div>
						))}
					</div>
				)}

				<Dialog open={createOpen} onOpenChange={setCreateOpen}>
					<DialogContent>
						<form onSubmit={handleCreate} className="space-y-4">
							<DialogHeader>
								<DialogTitle>新建插件令牌</DialogTitle>
								<DialogDescription>令牌等同管理员权限,生成后只显示一次,请立即复制保存。</DialogDescription>
							</DialogHeader>
							<div className="space-y-2">
								<Label htmlFor="token-name">名称</Label>
								<Input
									id="token-name"
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									placeholder="如 Macbook Chrome / 家里电脑"
									maxLength={50}
									required
								/>
							</div>
							<DialogFooter>
								<Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
									取消
								</Button>
								<Button type="submit" disabled={createToken.isPending}>
									{createToken.isPending ? "生成中…" : "生成令牌"}
								</Button>
							</DialogFooter>
						</form>
					</DialogContent>
				</Dialog>

				<ConfirmDialog state={confirm} onClose={() => setConfirm(null)} />
			</CardContent>
		</Card>
	);
}

export default function AdminSecurity() {
	const changePassword = useChangePassword();
	const [oldPassword, setOldPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");

	function handleChangePassword(e: FormEvent) {
		e.preventDefault();
		if (newPassword !== confirmPassword) {
			toast.error("两次输入的新密码不一致");
			return;
		}
		changePassword.mutate(
			{ oldPassword, newPassword },
			{
				onSuccess: () => {
					setOldPassword("");
					setNewPassword("");
					setConfirmPassword("");
				},
			},
		);
	}

	const { data: auth } = useAuthStatus();
	const changeUsername = useChangeUsername();
	// 以服务端用户名为基准,draft 保存未提交的编辑,避免用 effect 回填 state
	const [usernameDraft, setUsernameDraft] = useState<string | null>(null);
	const [usernamePassword, setUsernamePassword] = useState("");
	const username = usernameDraft ?? auth?.user?.username ?? "";

	function handleChangeUsername(e: FormEvent) {
		e.preventDefault();
		changeUsername.mutate(
			{ username, password: usernamePassword },
			{ onSuccess: () => setUsernamePassword("") },
		);
	}

	return (
		<div className="mx-auto max-w-2xl space-y-6">
			<ApiTokenCard />
			<Card>
				<CardHeader>
					<CardTitle>修改用户名</CardTitle>
					<CardDescription>修改当前管理员账号的登录用户名</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleChangeUsername} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="username">用户名</Label>
							<Input
								id="username"
								value={username}
								onChange={(e) => setUsernameDraft(e.target.value)}
								maxLength={50}
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="username-password">当前密码</Label>
							<Input
								id="username-password"
								type="password"
								value={usernamePassword}
								onChange={(e) => setUsernamePassword(e.target.value)}
								autoComplete="current-password"
								placeholder="验证身份后生效"
								required
							/>
						</div>
						<Button type="submit" disabled={changeUsername.isPending}>
							{changeUsername.isPending ? "修改中…" : "修改用户名"}
						</Button>
					</form>
				</CardContent>
			</Card>
			<Card>
				<CardHeader>
					<CardTitle>修改密码</CardTitle>
					<CardDescription>修改当前管理员账号的登录密码</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={handleChangePassword} className="space-y-4">
						<div className="space-y-2">
							<Label htmlFor="old-password">当前密码</Label>
							<Input
								id="old-password"
								type="password"
								value={oldPassword}
								onChange={(e) => setOldPassword(e.target.value)}
								autoComplete="current-password"
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="new-password">新密码</Label>
							<Input
								id="new-password"
								type="password"
								value={newPassword}
								onChange={(e) => setNewPassword(e.target.value)}
								autoComplete="new-password"
								minLength={6}
								placeholder="至少 6 位"
								required
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="confirm-password">确认新密码</Label>
							<Input
								id="confirm-password"
								type="password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								autoComplete="new-password"
								minLength={6}
								required
							/>
						</div>
						<Button type="submit" disabled={changePassword.isPending}>
							{changePassword.isPending ? "修改中…" : "修改密码"}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
