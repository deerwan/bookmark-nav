import { z } from "zod";

// 书签 URL 协议白名单。z.string().url() 接受 javascript: / data: / file: 等协议,
// 而书签 URL 会在前台渲染成 <a href>,javascript: 会构成存储型 XSS;
// 导入的书签文件是外部输入,不能只依赖"管理员自己不会输坏协议"这一假设
export function isHttpUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

// zod schema 用:非法协议时给出明确错误信息(校验失败返回 422)
export const httpUrlSchema = z
	.string()
	.max(2000)
	.refine(isHttpUrl, "仅支持 http(s) 网址");

