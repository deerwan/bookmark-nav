import { useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { Button } from "@app/components/ui/button";
import { Input } from "@app/components/ui/input";
import { Label } from "@app/components/ui/label";
import { normalizeSiteUrl, saveConfig, ensureHostPermission, loadConfig } from "../../lib/config";
import { verifyConfig } from "../../lib/api";

export default function App() {
	const [siteInput, setSiteInput] = useState("");
	const [token, setToken] = useState("");
	const [checking, setChecking] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// 回显已保存的配置(令牌字段一并回填,便于修改;整页仅本地渲染)
	useEffect(() => {
		loadConfig().then((cfg) => {
			if (cfg?.siteUrl) setSiteInput(cfg.siteUrl);
			if (cfg?.token) setToken(cfg.token);
		});
	}, []);

	async function handleSave(e: FormEvent) {
		e.preventDefault();
		setError(null);
		const siteUrl = normalizeSiteUrl(siteInput);
		if (!siteUrl) {
			setError("站点地址不合法,需以 http(s):// 开头");
			return;
		}
		if (!/^bnav_[a-f0-9]{64}$/.test(token.trim())) {
			setError("令牌格式不正确,应为后台「安全」页生成的 bnav_ 开头长字符串");
			return;
		}
		setChecking(true);
		try {
			// 顺序很重要:必须先申请站点访问权限(MV3 下未授权时跨域 fetch 直接失败),
			// 再做连通性/令牌验证,否则验证请求会因无权限被浏览器拦截
			const granted = await ensureHostPermission(siteUrl);
			if (!granted) {
				setError("未授予站点访问权限,插件无法工作");
				return;
			}
			const problem = await verifyConfig(siteUrl, token.trim());
			if (problem) {
				setError(problem);
				return;
			}
			await saveConfig({ siteUrl, token: token.trim() });
			setSaved(true);
			setTimeout(() => setSaved(false), 3000);
		} catch {
			setError("保存失败,请重试");
		} finally {
			setChecking(false);
		}
	}

	return (
		<div className="mx-auto w-full max-w-[400px] p-5">
			<h1 className="mb-1 text-[15px] font-medium tracking-tight">Bookmark Nav 插件设置</h1>
			<p className="mb-4 text-sm text-muted-foreground">
				令牌在导航站后台「安全」页生成,等同管理员权限,请妥善保管。
			</p>
			<form onSubmit={handleSave} className="space-y-4">
				<div className="space-y-1.5">
					<Label htmlFor="site-url">站点地址</Label>
					<Input
						id="site-url"
						value={siteInput}
						onChange={(e) => setSiteInput(e.target.value)}
						placeholder="https://你的导航站域名"
						required
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="ext-token">访问令牌</Label>
					<Input
						id="ext-token"
						type="password"
						value={token}
						onChange={(e) => setToken(e.target.value)}
						placeholder="bnav_…"
						className="font-mono text-xs"
						required
					/>
				</div>
				{error && (
					<p className="flex items-start gap-2 text-sm text-destructive">
						<AlertTriangle className="mt-0.5 size-4 shrink-0" />
						<span>{error}</span>
					</p>
				)}
				<Button className="w-full" disabled={checking}>
					{saved ? <Check className="size-4" /> : null}
					{checking ? "验证中…" : saved ? "已保存" : "保存并验证"}
				</Button>
			</form>
		</div>
	);
}
