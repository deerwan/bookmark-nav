import { describe, expect, it } from "vitest";
import { buildNetscapeHtml, parseNetscapeHtml, type ExportFolder } from "./netscape";

// Chrome 导出样例(结构含:嵌套文件夹 / 属性大小写混合 / 实体转义 / 非法书签)
const chromeExport = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000">开发</H3>
    <DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000001">GitHub</A>
        <DT><A HREF="https://developer.mozilla.org/" ADD_DATE="1700000002">MDN &amp; 文档</A>
        <DT><H3 ADD_DATE="1700000003">前端</H3>
        <DL><p>
            <DT><A HREF="https://react.dev/" ADD_DATE="1700000004">React</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://example.com/" ADD_DATE="1700000005">Example</A>
    <DT><A HREF="javascript:void(0)">bad</A>
    <DT><A HREF="place:folder">place</A>
</DL><p>`;

describe("parseNetscapeHtml", () => {
	it("解析嵌套文件夹与书签,保留层级结构", () => {
		const root = parseNetscapeHtml(chromeExport);

		expect(root.bookmarks.map((b) => b.title)).toEqual(["Example"]);
		expect(root.children).toHaveLength(1);

		const dev = root.children[0];
		expect(dev.name).toBe("开发");
		expect(dev.bookmarks.map((b) => b.title)).toEqual(["GitHub", "MDN & 文档"]);
		expect(dev.children).toHaveLength(1);

		const fe = dev.children[0];
		expect(fe.name).toBe("前端");
		expect(fe.bookmarks.map((b) => b.url)).toEqual(["https://react.dev/"]);
	});

	it("解析 ADD_DATE 为数字,非法值记为 null", () => {
		const root = parseNetscapeHtml(chromeExport);
		const github = root.children[0].bookmarks[0];
		expect(github.addDate).toBe(1700000001);

		const html = `<DL><p><DT><A HREF="https://a.com" ADD_DATE="not-a-number">A</A></DL><p>`;
		const [bm] = parseNetscapeHtml(html).bookmarks;
		expect(bm.addDate).toBeNull();
	});

	it("HTML 实体被解码(&amp; 与 &#39;)", () => {
		const html = `<DL><p><DT><A HREF="https://a.com?q=1&amp;x=2">it&#39;s</A></DL><p>`;
		const [bm] = parseNetscapeHtml(html).bookmarks;
		expect(bm.url).toBe("https://a.com?q=1&x=2");
		expect(bm.title).toBe("it's");
	});

	it("跳过 javascript:/place: 等非 http(s) 协议", () => {
		const root = parseNetscapeHtml(chromeExport);
		const all = [...root.bookmarks, ...root.children[0].bookmarks];
		expect(all.map((b) => b.url)).not.toContain("javascript:void(0)");
		expect(all.map((b) => b.url)).not.toContain("place:folder");
	});

	it("空标题回退为 URL;空文件夹名记为「未命名」;容错多余闭合标签", () => {
		const html = `<DL><p>
			<DT><H3></H3><DL><p></DL><p>
			<DT><A HREF="https://a.com"></A>
		</DL><p></DL><p></DL><p>`;
		const root = parseNetscapeHtml(html);
		expect(root.children[0].name).toBe("未命名");
		expect(root.bookmarks[0].title).toBe("https://a.com");
	});
});

describe("buildNetscapeHtml 与 parseNetscapeHtml 往返一致性", () => {
	it("导出再导入,文件夹树与书签属性保持不变", () => {
		const folders: ExportFolder[] = [
			{
				name: "开发",
				addDate: 1700000000,
				children: [
					{
						name: "前端",
						addDate: 1700000003,
						children: [],
						bookmarks: [
							{ title: "React <指南>", url: "https://react.dev/?a=1&b=2", icon: null, addDate: 1700000004 },
						],
					},
				],
				bookmarks: [
					{
						// 解析器会 trim 标题首尾空白,故用例不含首尾空格;内部空格/引号/&必须完整保留
						title: `quote " amp & mid`,
						url: "https://github.com/",
						icon: "data:image/png;base64,AAA=\"x\"",
						addDate: 1700000001,
					},
				],
			},
		];
		const rootBookmarks = [
			{ title: "Example", url: "https://example.com/", icon: null, addDate: null },
		];

		const html = buildNetscapeHtml(rootBookmarks, folders);
		const parsed = parseNetscapeHtml(html);

		expect(parsed.bookmarks).toEqual(rootBookmarks);
		expect(parsed.children).toHaveLength(1);

		const dev = parsed.children[0];
		expect(dev.name).toBe("开发");
		expect(dev.bookmarks[0].title).toBe(`quote " amp & mid`);
		expect(dev.bookmarks[0].icon).toBe(`data:image/png;base64,AAA="x"`);
		expect(dev.children[0].name).toBe("前端");
		expect(dev.children[0].bookmarks[0].url).toBe("https://react.dev/?a=1&b=2");
		expect(dev.children[0].bookmarks[0].title).toBe("React <指南>");
	});
});
