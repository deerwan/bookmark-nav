-- 存量数据清理:URL 协议白名单(httpUrlSchema)只约束新写入,
-- 历史导入的书签里可能残留 javascript: / data: / file: 等 URL,
-- 前台会渲染成 <a href>,构成存储型 XSS。此迁移一次性清掉。
DELETE FROM `bookmarks`
WHERE `url` NOT LIKE 'http://%' AND `url` NOT LIKE 'https://%';
--> statement-breakpoint
-- 被删书签的标签关联随外键级联清理,这里再清掉因此失去引用的孤儿标签
-- (与 routes/admin.ts syncTags 的孤儿清理逻辑一致)
DELETE FROM `tags`
WHERE NOT EXISTS (
	SELECT 1 FROM `bookmark_tags` WHERE `bookmark_tags`.`tag_id` = `tags`.`id`
);
