// 浏览器插件访问令牌(PAT)的生成与哈希在 lib/token.ts(唯一实现),这里只管密码。
// PBKDF2 密码哈希(Workers 无法用 bcrypt,使用 Web Crypto)
const ITERATIONS = 100_000;

function toHex(buf: Uint8Array): string {
	return Array.from(buf)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function fromHex(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: ITERATIONS },
		key,
		256,
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const hash = await derive(password, salt);
	return `${toHex(salt)}:${toHex(hash)}`;
}

export async function verifyPassword(
	password: string,
	stored: string,
): Promise<boolean> {
	const [saltHex, hashHex] = stored.split(":");
	if (!saltHex || !hashHex) return false;
	const hash = await derive(password, fromHex(saltHex));
	const expected = fromHex(hashHex);
	if (hash.length !== expected.length) return false;
	// 常量时间比较,避免时序侧信道
	let diff = 0;
	for (let i = 0; i < hash.length; i++) diff |= hash[i] ^ expected[i];
	return diff === 0;
}
