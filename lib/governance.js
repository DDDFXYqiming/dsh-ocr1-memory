// dsh-layered-memory — DSH 跨会话长期记忆插件（v0.3）。
//
// 分层记忆（L0 元规则 / L1 索引 / L2 事实 / L3 SOP）+ 行动验证公理。
// v0.3 增强：
//   - 命名空间隔离：<memoryDir>/<namespace>/...，default 兼容旧根目录
//   - 溯源/审计：memory-meta.json 记录 sourceSession / sourceSeqs / createdAt / updatedAt
//   - 自动蒸馏：turn/end 把本回合成功工具调用写入 pending/ 候选区，memory_accept 确认后入正式记忆
//   - 冲突/过期：memory_update(supersede) / memory_archive / memory_rollback，旧版本保留在 .history/ 或 archive/
//
// 存储布局（namespace=default 时为旧根目录，其余为 <memoryDir>/<namespace>/）：
//   memory_management_sop.md   L0 元规则
//   index.txt                  L1 索引（≤30 行，存在性编码 + RULES）
//   facts.md                   L2 环境事实库（## SECTION）
//   sops/*.md                  L3 任务 SOP
//   pending/*.md               自动蒸馏候选区（未确认不进入正式记忆）
//   archive/                   归档/历史保留
//   .history/                  supersede/rollback 的历史快照
//   memory-meta.json           溯源/审计元数据
//   file_access_stats.json     读取热度统计（轻量）
//
// 注入（存在性编码：L1 索引每轮可见）：
//   ctx.systemPrompt.context({ name: 'memory:index', order: 10,
//     text: () => readIndex() }) —— 每次组装请求实时读 L1。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const L0_TEMPLATE = `# Memory Management SOP (L0)
## 核心公理
1. 行动验证原则：任何写入 L1/L2/L3 的信息必须源自【成功的工具调用结果】（实测/验证/确认）。严禁模型固有知识、推理猜测、未验证假设。口号：无行动，不记忆。
2. 神圣不可删改性：已验证的事实可以压缩文字、迁移层级，但严禁丢弃。supersede/archive 必须保留历史。
3. 禁止易变状态：时间戳、PID、临时 Session ID、一次性路径等高频变化数据不存。
4. 最小充分指针：上层只留能定位下层的短标识，多一词即冗余。

## 分层
- L1 index.txt：≤30 行。两层「场景关键词→记忆定位」映射 + RULES（红线规则/高频犯错点）。只写存在性，禁写 How-to 细节。
- L2 facts.md：环境特异性事实（路径/凭证引用/配置/实测参数）。按 ## SECTION 组织。
- L3 sops/*.md：特定任务经验（关键前置 + 典型坑 + 稳定步骤），尽可能短。
- pending/*.md：自动蒸馏候选区，未确认不进入正式记忆。
- 通用常识 / 易变状态 / 日志记录：严禁存储。

## 写入决策树
"这条信息该放哪层？"
- 环境特异性事实（路径/配置/凭证引用/实测参数）→ L2 facts.md
- 复杂任务经验（坑点/前置条件/稳定步骤，多次重试才成功且未来可用）→ L3 sop
- 通用操作规律（跨任务红线）→ L1 [RULES]（一句压缩）
- 其余（常识/易变/未验证）→ 不存
`;

const INDEX_TEMPLATE = `# [Memory Index - L1]
分层记忆: L0规则(memory_management_sop.md) | L1索引(this) | L2事实(facts.md) | L3技能(sops/) | 候选(pending/)
需要细节时用 memory_read / memory_list 取 L2/L3；新增经验用 memory_write（须带证据）
任务完成且【行动验证成功】时主动 memory_write 沉淀（无需等用户提醒；无验证信息则不写）
<!-- AUTO-BEGIN -->
[L2] （facts.md 的条目将在此列出）
[L3] （sops/ 的文件将在此列出）
<!-- AUTO-END -->
[RULES]
（红线规则：不提醒就会犯的错。词级维护，禁 overwrite）
`;

const FACTS_TEMPLATE = `# [Facts - L2]
按 ## SECTION 组织环境特异性事实。只写行动验证过的内容。
`;

const META_FILE = "memory-meta.json";
const PENDING_DIR = "pending";
const ARCHIVE_DIR = "archive";
const HISTORY_DIR = ".history";

function defaultMemDir() {
	return join(homedir(), ".dsh", "memory");
}

/** 命名空间安全化：只允许小写字母、数字、下划线、连字符。 */
function safeNs(value) {
	const s = String(value ?? "default").trim().toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return s || "default";
}

/** namespace=default 时兼容旧根目录，其余使用 <memoryDir>/<namespace>/。 */
function nsRoot(memDir, ns) {
	const s = safeNs(ns);
	return s === "default" ? memDir : join(memDir, s);
}

/** 自动命名空间：workspace 目录名 + git 分支名（若可用）。 */
function detectNamespace() {
	try {
		const cwd = process.cwd();
		const base = basename(cwd) || "default";
		let branch = "";
		try {
			branch = execFileSync("git", ["branch", "--show-current"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2000,
			}).trim();
		} catch { /* 非 git 目录 */ }
		return safeNs(branch ? `${base}__${branch}` : base);
	} catch {
		return "default";
	}
}

function resolveNamespace(cfg, explicit) {
	if (explicit) return safeNs(explicit);
	if (cfg.defaultNamespace) return safeNs(cfg.defaultNamespace);
	if (cfg.autoNamespace) return detectNamespace();
	return "default";
}

/** 初始化命名空间目录结构（幂等，不覆盖已有内容）。 */
function ensureNamespaceLayout(root) {
	mkdirSync(root, { recursive: true });
	mkdirSync(join(root, "sops"), { recursive: true });
	mkdirSync(join(root, PENDING_DIR), { recursive: true });
	mkdirSync(join(root, ARCHIVE_DIR), { recursive: true });
	mkdirSync(join(root, HISTORY_DIR), { recursive: true });
	const seeds = [
		["memory_management_sop.md", L0_TEMPLATE],
		["index.txt", INDEX_TEMPLATE],
		["facts.md", FACTS_TEMPLATE],
	];
	for (const [file, content] of seeds) {
		const p = join(root, file);
		if (!existsSync(p)) writeFileSync(p, content, "utf8");
	}
}

/** 初始化记忆根目录（幂等）。 */
function ensureMemoryLayout(memDir) {
	ensureNamespaceLayout(memDir);
}

function readIndex(root) {
	try {
		return readFileSync(join(root, "index.txt"), "utf8");
	} catch {
		return "";
	}
}

function slugify(topic) {
	const s = String(topic).trim().toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return s.slice(0, 48) || "entry";
}

/** facts.md 的 section 名列表。 */
function factSections(root) {
	try {
		const text = readFileSync(join(root, "facts.md"), "utf8");
		const out = [];
		for (const line of text.split("\n")) {
			const m = line.match(/^##\s+(.+)$/);
			if (m) out.push(m[1].trim());
		}
		return out;
	} catch {
		return [];
	}
}

/** sops/ 的文件名列表（去 .md）。 */
function sopNames(root) {
	try {
		return readdirSync(join(root, "sops"))
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.replace(/\.md$/, ""))
			.sort();
	} catch {
		return [];
	}
}

function pendingNames(root) {
	try {
		return readdirSync(join(root, PENDING_DIR))
			.filter((f) => f.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
}

function readMeta(root) {
	try {
		return JSON.parse(readFileSync(join(root, META_FILE), "utf8"));
	} catch {
		return { facts: {}, sops: {} };
	}
}

function writeMeta(root, meta) {
	writeFileSync(join(root, META_FILE), JSON.stringify(meta, null, 2), "utf8");
}

function getEntryMeta(root, kind, key) {
	const m = readMeta(root);
	return (kind === "fact" ? m.facts : m.sops)[key] || null;
}

function setEntryMeta(root, kind, key, patch) {
	const m = readMeta(root);
	const store = kind === "fact" ? m.facts : m.sops;
	const prev = store[key] || {};
	store[key] = {
		...prev,
		...patch,
		updatedAt: new Date().toISOString(),
	};
	writeMeta(root, m);
	return store[key];
}

function isArchived(root, kind, key) {
	return Boolean(getEntryMeta(root, kind, key)?.archived);
}

/** 确保 L1 固定段含常驻规则行、表述与最新模板一致（对已存在的旧索引也生效）。 */
function ensureIndexRule(root) {
	const p = join(root, "index.txt");
	if (!existsSync(p)) return;
	let cur = readFileSync(p, "utf8");
	cur = cur.replace("4层记忆: L0规则", "分层记忆: L0规则");
	cur = cur.replace("4层记忆", "分层记忆");
	if (cur.includes("任务完成且【行动验证成功】")) {
		if (cur !== readFileSync(p, "utf8")) writeFileSync(p, cur, "utf8");
		return;
	}
	const anchor = "新增经验用 memory_write（须带证据）";
	if (cur.includes(anchor)) {
		cur = cur.replace(anchor, anchor + "\n任务完成且【行动验证成功】时主动 memory_write 沉淀（无需等用户提醒；无验证信息则不写）");
	} else {
		cur = cur.replace("# [Memory Index - L1]", "# [Memory Index - L1]\n任务完成且【行动验证成功】时主动 memory_write 沉淀（无需等用户提醒；无验证信息则不写）");
	}
	writeFileSync(p, cur, "utf8");
}

const AUTO_BEGIN = "<!-- AUTO-BEGIN -->";
const AUTO_END = "<!-- AUTO-END -->";

/** 规范化索引布局空白：保留手动内容，只消除会挤占预算的多余空行。 */
function normalizeIndexWhitespace(text) {
	return String(text ?? "")
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "");
}

function countIndexLines(text) {
	const normalized = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	return normalized ? normalized.split("\n").length : 0;
}

/** 读取 AUTO 标记之外的头部与手动尾部，并规范化空白。 */
function readIndexSections(root) {
	const templateBegin = INDEX_TEMPLATE.indexOf(AUTO_BEGIN);
	const templateEnd = INDEX_TEMPLATE.indexOf(AUTO_END);
	let head = INDEX_TEMPLATE.slice(0, templateBegin);
	let tail = INDEX_TEMPLATE.slice(templateEnd + AUTO_END.length);
	try {
		const cur = readFileSync(join(root, "index.txt"), "utf8");
		const b = cur.indexOf(AUTO_BEGIN);
		const e = cur.indexOf(AUTO_END);
		if (b >= 0 && e > b) {
			head = cur.slice(0, b);
			tail = cur.slice(e + AUTO_END.length);
		} else if (cur.trim()) {
			head = cur;
			tail = "";
		}
	} catch { /* 用模板 */ }
	return {
		head: normalizeIndexWhitespace(head),
		tail: normalizeIndexWhitespace(tail),
	};
}

function buildAutoLines(facts, sops, hiddenFacts = 0, hiddenSops = 0) {
	const l2 = facts.length ? facts.map((f) => `[L2] ${f}`) : ["[L2] （空）"];
	const l3 = sops.length ? sops.map((s) => `[L3] sops/${s}.md`) : ["[L3] （空）"];
	if (hiddenFacts > 0) l2[l2.length - 1] += ` | 另有 ${hiddenFacts} 条，调用 memory_list 查看`;
	if (hiddenSops > 0) l3[l3.length - 1] += ` | 另有 ${hiddenSops} 条，调用 memory_list 查看`;
	return [...l2, ...l3];
}

function composeIndex(head, autoLines, tail) {
	const parts = [head, AUTO_BEGIN, autoLines.join("\n"), AUTO_END];
	if (tail) parts.push(tail);
	return parts.join("\n") + "\n";
}

function activeEntries(root) {
	return {
		facts: factSections(root).filter((f) => !isArchived(root, "fact", f)),
		sops: sopNames(root).filter((s) => !isArchived(root, "sop", s)),
	};
}

/** 重建 index.txt 的自动段（活跃 L2 + L3），过滤 archived；保留并清理 RULES 手动段。 */
function syncIndex(root, maxIndexLines = 30) {
	const p = join(root, "index.txt");
	const { head, tail } = readIndexSections(root);
	const { facts, sops } = activeEntries(root);
	const rebuilt = composeIndex(head, buildAutoLines(facts, sops), tail);
	writeFileSync(p, rebuilt, "utf8");
	const lines = countIndexLines(rebuilt);
	return { index_lines: lines, max_index_lines: maxIndexLines, over_limit: lines > maxIndexLines };
}

/** upsert facts.md 的 ## SECTION（基于行解析，避免正则边界坑）。 */
function upsertFact(root, topic, content) {
	const p = join(root, "facts.md");
	const text = existsSync(p) ? readFileSync(p, "utf8") : FACTS_TEMPLATE;
	const lines = text.split("\n");
	let start = -1;
	let end = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			if (start >= 0) { end = i; break; }
			if (lines[i].slice(3).trim() === topic) start = i;
		}
	}
	if (start >= 0) {
		const updated = [...lines.slice(0, start), `## ${topic}`, content, "", ...lines.slice(end)];
		writeFileSync(p, updated.join("\n"), "utf8");
		return "updated";
	}
	writeFileSync(p, text.replace(/\s*$/, "\n") + `## ${topic}\n${content}\n\n`, "utf8");
	return "created";
}

/** 记忆名称安全校验：拒绝绝对路径与任何 ".." 路径段（防记忆目录穿越，spec-audit 2026-08-14）。 */
function isSafeMemName(value) {
	if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
	if (value.split(/[\\/]/).includes("..")) return false;
	return true;
}

/** 读取 facts.md 的指定 section。 */
function readFact(root, topic) {
	const text = existsSync(join(root, "facts.md")) ? readFileSync(join(root, "facts.md"), "utf8") : "";
	const lines = text.split("\n");
	let inSection = false;
	const out = [];
	for (const line of lines) {
		if (line.startsWith("## ")) {
			if (inSection) break;
			if (line.slice(3).trim() === topic) { inSection = true; continue; }
		}
		if (inSection) out.push(line);
	}
	return inSection ? out.join("\n").trim() : null;
}

/** 读取 sop 文件全文。 */
function readSop(root, slug) {
	const p = join(root, "sops", `${slug}.md`);
	return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** 记录读取热度（GA file_access_stats 简化版）。 */
function bumpAccess(root, key) {
	try {
		const p = join(root, "file_access_stats.json");
		const stats = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
		stats[key] = (stats[key] ?? 0) + 1;
		writeFileSync(p, JSON.stringify(stats, null, 2), "utf8");
	} catch { /* 热度统计失败不影响主流程 */ }
}

/** 写入正式记忆（fact/sop），带溯源 meta。 */
function writeMemory(root, { topic, entryType, content, evidence, sourceSession, sourceSeqs, namespace }) {
	const safeTopic = String(topic).trim();
	const body = `${String(content).trim()}\n\n> 证据: ${evidence}\n`;
	let path;
	let action;
	if (entryType === "fact") {
		path = join(root, "facts.md");
		action = upsertFact(root, safeTopic, body.trim());
		setEntryMeta(root, "fact", safeTopic, {
			sourceSession: sourceSession || null,
			sourceSeqs: Array.isArray(sourceSeqs) ? sourceSeqs.map(Number).filter(Number.isFinite) : [],
			evidence: evidence || "",
			namespace: namespace || null,
			archived: getEntryMeta(root, "fact", safeTopic)?.archived || false,
		});
	} else {
		const slug = slugify(safeTopic);
		path = join(root, "sops", `${slug}.md`);
		const header = `# ${safeTopic}\n\n`;
		if (existsSync(path)) {
			writeFileSync(path, header + body, "utf8");
			action = "updated";
		} else {
			writeFileSync(path, header + body, "utf8");
			action = "created";
		}
		setEntryMeta(root, "sop", slug, {
			sourceSession: sourceSession || null,
			sourceSeqs: Array.isArray(sourceSeqs) ? sourceSeqs.map(Number).filter(Number.isFinite) : [],
			evidence: evidence || "",
			namespace: namespace || null,
			archived: getEntryMeta(root, "sop", slug)?.archived || false,
		});
	}
	const index = syncIndex(root);
	return { entry_type: entryType, topic: safeTopic, path, action, index };
}

/** 生成 pending 候选文件内容。 */
function pendingContent({ sourceSession, sourceSeqs, tools, reason, topic, entryType, evidence, content }) {
	const lines = [
		"# Pending Memory Candidate",
		"",
		`- sourceSession: ${sourceSession || ""}`,
		`- sourceSeqs: ${Array.isArray(sourceSeqs) && sourceSeqs.length ? JSON.stringify(sourceSeqs) : ""}`,
		`- capturedAt: ${new Date().toISOString()}`,
		`- tools: ${(tools || []).join(", ")}`,
		`- topic: ${topic || ""}`,
		`- entryType: ${entryType || ""}`,
		`- evidence: ${evidence || ""}`,
		"",
		content || reason || "本回合有成功工具调用，可能值得沉淀。请用 memory_accept 确认或丢弃。",
		"",
	];
	return lines.join("\n");
}

/** 写入 pending 候选。 */
function writePending(root, { sourceSession, sourceSeqs, tools, reason, topic, entryType, evidence, content }) {
	const fileName = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`;
	const p = join(root, PENDING_DIR, fileName);
	writeFileSync(p, pendingContent({ sourceSession, sourceSeqs, tools, reason, topic, entryType, evidence, content }), "utf8");
	return fileName;
}

/** 读取 pending 候选。 */
function readPending(root, name) {
	const p = join(root, PENDING_DIR, name);
	if (!existsSync(p)) return null;
	const text = readFileSync(p, "utf8");
	const m = text.match(/^# Pending Memory Candidate[\s\S]*$/);
	return m ? text : null;
}

/** 从 pending 文件解析简单字段。 */
function parsePending(text) {
	const out = {};
	const session = text.match(/^- sourceSession: (.+)$/m);
	const seqs = text.match(/^- sourceSeqs: (.+)$/m);
	const tools = text.match(/^- tools: (.+)$/m);
	const topic = text.match(/^- topic: (.*)$/m);
	const entryType = text.match(/^- entryType: (.*)$/m);
	const evidence = text.match(/^- evidence: (.*)$/m);
	if (session) out.sourceSession = session[1].trim();
	if (seqs && seqs[1].trim()) {
		try { out.sourceSeqs = JSON.parse(seqs[1].trim()); } catch { out.sourceSeqs = []; }
	}
	if (tools) out.tools = tools[1].split(",").map((s) => s.trim()).filter(Boolean);
	if (topic) out.topic = topic[1].trim();
	if (entryType) out.entryType = entryType[1].trim();
	if (evidence) out.evidence = evidence[1].trim();
	const bodyMatch = text.match(/^- evidence:.*\r?\n\r?\n([\s\S]*)$/m);
	if (bodyMatch && bodyMatch[1].trim()) out.content = bodyMatch[1].trim();
	return out;
}

function hashText(text) {
	return createHash("sha256").update(String(text || "")).digest("hex").slice(0, 16);
}

function loadAccess(root) {
	try {
		return JSON.parse(readFileSync(join(root, "file_access_stats.json"), "utf8"));
	} catch {
		return {};
	}
}

function readStatsFile(root) {
	try {
		return JSON.parse(readFileSync(join(root, "memory_stats.json"), "utf8"));
	} catch {
		return {};
	}
}

function writeStatsFile(root, stats) {
	writeFileSync(join(root, "memory_stats.json"), JSON.stringify(stats, null, 2), "utf8");
}

function computeNamespaceStats(root) {
	const facts = factSections(root).filter((f) => !isArchived(root, "fact", f));
	const sops = sopNames(root).filter((s) => !isArchived(root, "sop", s));
	const archivedFacts = factSections(root).filter((f) => isArchived(root, "fact", f));
	const archivedSops = sopNames(root).filter((s) => isArchived(root, "sop", s));
	const pending = pendingNames(root);
	let sizeBytes = 0;
	for (const f of ["index.txt", "facts.md", "memory_management_sop.md"]) {
		try { sizeBytes += statSync(join(root, f)).size; } catch { /* 忽略 */ }
	}
	try {
		for (const f of readdirSync(join(root, "sops"))) sizeBytes += statSync(join(root, "sops", f)).size;
	} catch { /* 忽略 */ }
	try {
		for (const f of readdirSync(join(root, PENDING_DIR))) sizeBytes += statSync(join(root, PENDING_DIR, f)).size;
	} catch { /* 忽略 */ }
	return {
		facts: facts.length,
		sops: sops.length,
		pending: pending.length,
		archived: archivedFacts.length + archivedSops.length,
		size_bytes: sizeBytes,
		updatedAt: new Date().toISOString(),
	};
}

/** 去重：按内容 hash 检测重复 fact/sop，重复项归档并保留 citation（不物理删除）。 */
function dedupeEntries(root) {
	const report = { removed: [], merged: [] };
	const seenSops = new Map();
	for (const slug of sopNames(root)) {
		if (isArchived(root, "sop", slug)) continue;
		const content = readSop(root, slug);
		if (content === null) continue;
		const h = hashText(content.replace(/\s+/g, " ").trim());
		if (seenSops.has(h)) {
			const prev = seenSops.get(h);
			const ts = Date.now();
			try {
				copyFileSync(join(root, "sops", `${slug}.md`), join(root, ARCHIVE_DIR, `sop-${slug}-${ts}.md`));
			} catch { /* 忽略 */ }
			setEntryMeta(root, "sop", slug, { archived: true, duplicateOf: prev, archivedAt: new Date().toISOString() });
			report.removed.push(`sop:${slug} -> duplicate of ${prev}`);
		} else {
			seenSops.set(h, slug);
		}
	}
	const seenFacts = new Map();
	for (const topic of factSections(root)) {
		if (isArchived(root, "fact", topic)) continue;
		const content = readFact(root, topic);
		if (content === null) continue;
		const h = hashText(content.replace(/\s+/g, " ").trim());
		if (seenFacts.has(h)) {
			const prev = seenFacts.get(h);
			const ts = Date.now();
			try {
				writeFileSync(join(root, ARCHIVE_DIR, `fact-${slugify(topic)}-${ts}.md`), `# ${topic}\n\n${content}\n`, "utf8");
			} catch { /* 忽略 */ }
			setEntryMeta(root, "fact", topic, { archived: true, duplicateOf: prev, archivedAt: new Date().toISOString() });
			report.removed.push(`fact:${topic} -> duplicate of ${prev}`);
		} else {
			seenFacts.set(h, topic);
		}
	}
	return report;
}

/**
 * 压缩 L1 索引：只有完整索引超过 maxIndexLines 时才按访问热度裁剪。
 * 实际记忆文件不删除；被裁剪的层仍保留隐藏数量提示，避免完全不可发现。
 */
function compressIndexEntries(root, maxLines) {
	const { facts: allFacts, sops: allSops } = activeEntries(root);
	const access = loadAccess(root);
	const rank = (kind) => (a, b) => {
		const heat = (access[`${kind}:${b}`] || 0) - (access[`${kind}:${a}`] || 0);
		return heat || String(a).localeCompare(String(b));
	};
	const facts = [...allFacts].sort(rank("fact"));
	const sops = [...allSops].sort(rank("sop"));
	const { head, tail } = readIndexSections(root);
	const fixedLines = countIndexLines(head) + countIndexLines(tail) + 2;
	const fullLines = buildAutoLines(facts, sops);
	const fullIndex = composeIndex(head, fullLines, tail);
	const totalLines = countIndexLines(fullIndex);

	// 未超限时也写回规范化后的完整索引，但绝不裁剪条目。
	if (totalLines <= maxLines) {
		writeFileSync(join(root, "index.txt"), fullIndex, "utf8");
		return {
			facts_kept: facts.length,
			sops_kept: sops.length,
			total_facts: facts.length,
			total_sops: sops.length,
			facts_hidden: 0,
			sops_hidden: 0,
			compressed: false,
		};
	}

	const nonEmptyLayers = (facts.length ? 1 : 0) + (sops.length ? 1 : 0);
	// 预算不足时优先保留每个非空层至少一个指针；手动 RULES 过长时允许报告 over_limit，
	// 也不能用丢失整个 L3 指针来伪造“符合上限”。
	const available = Math.max(nonEmptyLayers, maxLines - fixedLines);
	let factCount = facts.length ? 1 : 0;
	let sopCount = sops.length ? 1 : 0;
	let remaining = Math.max(0, available - factCount - sopCount);
	const candidates = [
		...facts.slice(factCount).map((topic) => ({ kind: "fact", topic, score: access[`fact:${topic}`] || 0 })),
		...sops.slice(sopCount).map((slug) => ({ kind: "sop", topic: slug, score: access[`sop:${slug}`] || 0 })),
	].sort((a, b) => (b.score - a.score) || a.kind.localeCompare(b.kind) || a.topic.localeCompare(b.topic));
	for (const candidate of candidates) {
		if (remaining <= 0) break;
		if (candidate.kind === "fact") factCount++;
		else sopCount++;
		remaining--;
	}
	const keptFacts = facts.slice(0, factCount);
	const keptSops = sops.slice(0, sopCount);
	const hiddenFacts = facts.length - keptFacts.length;
	const hiddenSops = sops.length - keptSops.length;
	const autoLines = buildAutoLines(keptFacts, keptSops, hiddenFacts, hiddenSops);
	writeFileSync(join(root, "index.txt"), composeIndex(head, autoLines, tail), "utf8");
	return {
		facts_kept: keptFacts.length,
		sops_kept: keptSops.length,
		total_facts: facts.length,
		total_sops: sops.length,
		facts_hidden: hiddenFacts,
		sops_hidden: hiddenSops,
		compressed: true,
	};
}

/** 寻找可合并的 SOP 候选（仅报告，需模型/用户确认后真正合并）。 */
function findMergeCandidates(root) {
	const names = sopNames(root).filter((s) => !isArchived(root, "sop", s));
	const candidates = [];
	for (let i = 0; i < names.length; i++) {
		for (let j = i + 1; j < names.length; j++) {
			const a = names[i];
			const b = names[j];
			const wordsA = a.replace(/[-_]/g, " ").toLowerCase().split(" ").filter(Boolean);
			const wordsB = b.replace(/[-_]/g, " ").toLowerCase().split(" ").filter(Boolean);
			const common = wordsA.filter((w) => wordsB.includes(w)).length;
			if (common < 1) continue;
			const contentA = (readSop(root, a) || "").replace(/\s+/g, " ").trim();
			const contentB = (readSop(root, b) || "").replace(/\s+/g, " ").trim();
			const similarity = contentA === contentB ? 1 : 0;
			if (similarity > 0 || common >= 2) {
				candidates.push({ a, b, common_words: common, similarity });
			}
		}
	}
	return candidates.slice(0, 20);
}

/** 执行一次完整维护：去重 + 压缩索引 + 统计 + 合并候选。 */
function runMaintain(root, maxLines) {
	const dedupe = dedupeEntries(root);
	const compress = compressIndexEntries(root, maxLines);
	const stats = computeNamespaceStats(root);
	const mergeCandidates = findMergeCandidates(root);
	const report = {
		runAt: new Date().toISOString(),
		dedupe,
		compress,
		stats,
		mergeCandidates,
	};
	writeFileSync(join(root, "maintenance-report.json"), JSON.stringify(report, null, 2), "utf8");
	writeStatsFile(root, stats);
	// compressIndexEntries 已写入压缩后的索引；这里不调用 syncIndex，避免把压缩结果覆盖回全量。
	return report;
}


// Shared governance primitives adapted for the optical backend.
export {
  defaultMemDir, safeNs, nsRoot, resolveNamespace, ensureMemoryLayout, ensureNamespaceLayout,
  readIndex, syncIndex, upsertFact, isSafeMemName, readFact, readSop, bumpAccess,
  writeMemory, writePending, readPending, parsePending, pendingNames,
  factSections, sopNames, getEntryMeta, setEntryMeta, isArchived,
  computeNamespaceStats, runMaintain, slugify, activeEntries,
};

