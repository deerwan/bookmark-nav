// 分类嵌套合法性校验:防循环嵌套 + 限制最大层级(移动时连同子树一起算)。
// 纯函数,与路由解耦以便单测(admin 路由的创建/移动分类都走这里)

// 手动创建/移动分类限制最多三级(导入不受限,保留浏览器书签原始层级)
export const MAX_CATEGORY_DEPTH = 3;

export function validateCategoryNesting(
	all: { id: number; parentId: number | null }[],
	parentId: number | null,
	movingId?: number,
): string | null {
	const parentOf = new Map(all.map((r) => [r.id, r.parentId]));
	if (movingId !== undefined) {
		if (parentId === movingId) return "不能以自己为父级";
		let cur: number | null = parentId;
		while (cur != null) {
			if (cur === movingId) return "不能形成循环嵌套";
			cur = parentOf.get(cur) ?? null;
		}
	}
	// 父级所在层级(1-based)
	let parentDepth = 0;
	for (let cur: number | null = parentId; cur != null; cur = parentOf.get(cur) ?? null) {
		parentDepth++;
	}
	// 被移动子树的高度(新建时为 1)
	const childrenOf = new Map<number, number[]>();
	for (const r of all) {
		if (r.parentId != null) {
			const list = childrenOf.get(r.parentId) ?? [];
			list.push(r.id);
			childrenOf.set(r.parentId, list);
		}
	}
	const height = (id: number): number =>
		1 + Math.max(0, ...(childrenOf.get(id) ?? []).map(height));
	const subtreeHeight = movingId !== undefined ? height(movingId) : 1;
	if (parentDepth + subtreeHeight > MAX_CATEGORY_DEPTH) {
		return `最多支持 ${MAX_CATEGORY_DEPTH} 级分类`;
	}
	return null;
}
