// Netscape Bookmark File 格式解析与生成
// Chrome / Edge / Firefox / Safari 的书签导入导出均使用此格式,文件夹可任意嵌套

export type ParsedBookmark = {
	title: string;
	url: string;
	icon: string | null;
	addDate: number | null;
};

export type ParsedFolder = {
	name: string;
	children: ParsedFolder[];
	bookmarks: ParsedBookmark[];
};

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&amp;/g, "&");
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function attr(attrs: string, name: string): string | null {
	const m = attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"));
	return m ? m[1] : null;
}

// 栈式解析:H3 开新文件夹入栈,</DL> 出栈,A 记为当前文件夹书签
export function parseNetscapeHtml(html: string): ParsedFolder {
	const root: ParsedFolder = { name: "", children: [], bookmarks: [] };
	const stack: ParsedFolder[] = [root];
	const re =
		/<DT[^>]*>\s*<H3([^>]*)>([\s\S]*?)<\/H3>|<DT[^>]*>\s*<A([^>]*)>([\s\S]*?)<\/A>|<\/DL>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		const top = stack[stack.length - 1];
		if (m[2] !== undefined) {
			// 文件夹
			const folder: ParsedFolder = {
				name: decodeEntities(m[2].trim()) || "未命名",
				children: [],
				bookmarks: [],
			};
			top.children.push(folder);
			stack.push(folder);
		} else if (m[4] !== undefined) {
			// 书签
			const attrs = m[3] ?? "";
			const href = attr(attrs, "HREF");
			if (!href || !/^https?:\/\//i.test(href)) continue; // 跳过 javascript:/place: 等
			const addDate = attr(attrs, "ADD_DATE");
			const iconAttr = attr(attrs, "ICON");
			top.bookmarks.push({
				title: decodeEntities(m[4].trim()) || href,
				url: decodeEntities(href),
				// icon 与 title/href 一样做实体反转义,保证 build → parse 往返无损
				icon: iconAttr ? decodeEntities(iconAttr) : null,
				addDate: addDate ? Number(addDate) || null : null,
			});
		} else {
			// </DL>:根不出栈,容错多余的闭合
			if (stack.length > 1) stack.pop();
		}
	}
	return root;
}

export type ExportFolder = {
	name: string;
	addDate: number | null;
	children: ExportFolder[];
	bookmarks: ParsedBookmark[];
};

export function buildNetscapeHtml(rootBookmarks: ParsedBookmark[], folders: ExportFolder[]): string {
	const lines: string[] = [
		"<!DOCTYPE NETSCAPE-Bookmark-file-1>",
		"<!-- This is an automatically generated file. It will be read and overwritten. DO NOT EDIT! -->",
		'<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
		"<TITLE>Bookmarks</TITLE>",
		"<H1>Bookmarks</H1>",
		"<DL><p>",
	];
	const pad = (depth: number) => "    ".repeat(depth + 1);

	function emitBookmark(b: ParsedBookmark, depth: number) {
		const add = b.addDate ? ` ADD_DATE="${b.addDate}"` : "";
		const icon = b.icon ? ` ICON="${escapeHtml(b.icon)}"` : "";
		lines.push(
			`${pad(depth)}<DT><A HREF="${escapeHtml(b.url)}"${add}${icon}>${escapeHtml(b.title)}</A>`,
		);
	}

	function emitFolder(f: ExportFolder, depth: number) {
		const add = f.addDate ? ` ADD_DATE="${f.addDate}"` : "";
		lines.push(`${pad(depth)}<DT><H3${add}>${escapeHtml(f.name)}</H3>`);
		lines.push(`${pad(depth)}<DL><p>`);
		for (const b of f.bookmarks) emitBookmark(b, depth + 1);
		for (const child of f.children) emitFolder(child, depth + 1);
		lines.push(`${pad(depth)}</DL><p>`);
	}

	for (const b of rootBookmarks) emitBookmark(b, 0);
	for (const f of folders) emitFolder(f, 0);
	lines.push("</DL><p>");
	return lines.join("\n");
}
