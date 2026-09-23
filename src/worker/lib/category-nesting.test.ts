import { describe, expect, it } from "vitest";
import { MAX_CATEGORY_DEPTH, validateCategoryNesting } from "./category-nesting";

describe("validateCategoryNesting", () => {
	it("根级新建(parentId=null)合法", () => {
		expect(validateCategoryNesting([], null)).toBeNull();
	});

	it("正常嵌套(未超限)合法", () => {
		const all = [
			{ id: 1, parentId: null },
			{ id: 2, parentId: 1 },
		];
		// 1→2 下挂新分类:深度 3,恰好到上限
		expect(validateCategoryNesting(all, 2)).toBeNull();
	});

	it("超过最大层级被拒绝", () => {
		const all = [
			{ id: 1, parentId: null },
			{ id: 2, parentId: 1 },
			{ id: 3, parentId: 2 },
		];
		// 1→2→3 下再挂:深度 4 > 3
		expect(validateCategoryNesting(all, 3)).toContain("最多支持 3 级分类");
	});

	it("不能以自己为父级", () => {
		expect(validateCategoryNesting([{ id: 1, parentId: null }], 1, 1)).toBe("不能以自己为父级");
	});

	it("不能把分类挂到自己的子孙下(循环嵌套)", () => {
		const all = [
			{ id: 1, parentId: null },
			{ id: 2, parentId: 1 },
			{ id: 3, parentId: 2 },
		];
		// 移动 1 到 3 下:1 的祖先链将包含自己
		expect(validateCategoryNesting(all, 3, 1)).toBe("不能形成循环嵌套");
	});

	it("移动时连同子树一起计算深度", () => {
		// 树:1→2→3;把 1(高度 2:1→2)移到 3 下,总深度 3,恰好到上限
		const all = [
			{ id: 1, parentId: null },
			{ id: 2, parentId: 1 },
			{ id: 3, parentId: 2 },
		];
		expect(validateCategoryNesting(all, 3, 1)).toBe("不能形成循环嵌套");

		// 树:1→2;把 2(高度 1)移到 1 下 → 深度 2,合法;把 1(高度 2)移到 2 下 → 循环,拒绝
		const small = [
			{ id: 1, parentId: null },
			{ id: 2, parentId: 1 },
		];
		expect(validateCategoryNesting(small, 1, 2)).toBeNull();
		expect(validateCategoryNesting(small, 2, 1)).toBe("不能形成循环嵌套");
	});

	it("子树高度影响深度限制:移动带深层子树的节点会被拒", () => {
		// 树:1→2→3(移动 1,子树高度 3);挂在根 4 下 → 总深度 4,超限
		const all = [
			{ id: 1, parentId: null },
			{ id: 2, parentId: 1 },
			{ id: 3, parentId: 2 },
			{ id: 4, parentId: null },
		];
		expect(validateCategoryNesting(all, 4, 1)).toContain("最多支持 3 级分类");

		// 子树更浅(1→2,高度 2)时挂根 4 下 → 总深度 3,恰好到上限,放行
		const shallower = [
			{ id: 1, parentId: null },
			{ id: 2, parentId: 1 },
			{ id: 4, parentId: null },
		];
		expect(validateCategoryNesting(shallower, 4, 1)).toBeNull();

		// 给 4 加一层(4→5):同样的子树挂 5 下 → 总深度 4,超限
		const deeper = [
			{ id: 1, parentId: null },
			{ id: 2, parentId: 1 },
			{ id: 4, parentId: null },
			{ id: 5, parentId: 4 },
		];
		expect(validateCategoryNesting(deeper, 5, 1)).toContain("最多支持 3 级分类");
	});

	it("不存在的 parentId 视为根级(parentDepth=0)", () => {
		expect(validateCategoryNesting([], 999)).toBeNull();
	});

	it("深度上限常量为 3", () => {
		expect(MAX_CATEGORY_DEPTH).toBe(3);
	});
});
