const express = require("express");
const multer = require("multer");
const yauzl = require("yauzl");
const yazl = require("yazl");
const { Pool } = require("pg");
const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const APP_DIR = path.join(ROOT, "app");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PACKAGE_DIR = process.env.PACKAGE_DIR || path.join(DATA_DIR, "packages");
const UPLOAD_DIR = path.join(PACKAGE_DIR, "uploads");
const SNAPSHOT_DIR = path.join(PACKAGE_DIR, "snapshots");
const RELEASE_DIR = path.join(PACKAGE_DIR, "releases");
const PORT = Number(process.env.PORT || 4777);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 25);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const MAX_FILE_COUNT = Number(process.env.MAX_FILE_COUNT || 300);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 2 * 1024 * 1024);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://${HOST}:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || "dev-only-change-me";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const PUBLISH_REPO = process.env.PUBLISH_REPO || "";
const PUBLISH_BRANCH = process.env.PUBLISH_BRANCH || "main";
const DEFAULT_SKILL_TAGS = ["Agent 基础提升"];
const TAG_KEYWORDS = [
  { tag: "小红书", pattern: /小红书|xhs|rednote/i },
  { tag: "京东", pattern: /京东|jd\.com|jingdong/i },
  { tag: "抖音", pattern: /抖音|douyin|tiktok/i },
  { tag: "ISV", pattern: /\bisv\b|服务商|集成商/i },
  { tag: "Agent 基础提升", pattern: /agent|skill|workflow|prompt|mcp|自动化|基础提升/i },
];

if (process.env.NODE_ENV === "production" && SESSION_SECRET === "dev-only-change-me") {
  throw new Error("SESSION_SECRET must be configured in production");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://skillhub:skillhub@127.0.0.1:5432/skillhub",
});

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
});

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(APP_DIR));

function nowIso() {
  return new Date().toISOString();
}

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function hashText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function hashFile(filePath) {
  return fs.readFile(filePath).then((data) => crypto.createHash("sha256").update(data).digest("hex"));
}

function slugify(input) {
  const slug = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `skill-${crypto.randomBytes(3).toString("hex")}`;
}

function safeFilePart(input) {
  const cleaned = String(input || "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "skill";
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || ""));
}

function absoluteUrl(route) {
  return `${String(PUBLIC_BASE_URL).replace(/\/+$/, "")}${route}`;
}

function publicSkillPath(slug, version, action) {
  return `/api/public/skills/${encodePathSegment(slug)}/${encodePathSegment(version)}/${action}`;
}

function isGithubAppConfigured() {
  const config = githubConfig();
  return Boolean(config.appId && config.installationId && (config.privateKey || config.privateKeyPath));
}

function isGithubSyncConfigured() {
  return Boolean(PUBLISH_REPO && isGithubAppConfigured());
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function assertString(value, field, min = 1, max = 300) {
  const text = String(value || "").trim();
  if (text.length < min || text.length > max) {
    const error = new AppError("validation_error", `${field} is required`, 422, [{ field }]);
    throw error;
  }
  return text;
}

function normalizeTags(...values) {
  const raw = values.flatMap((value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === "object") return [];
    return String(value).split(/[,，;；\n]/);
  });
  const seen = new Set();
  return raw
    .map((item) => String(item || "").trim())
    .filter((item) => item && item.length <= 40)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function inferTagsFromText(text) {
  return TAG_KEYWORDS.filter(({ pattern }) => pattern.test(text)).map(({ tag }) => tag);
}

function parseCookies(header) {
  return String(header || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const index = item.indexOf("=");
      if (index === -1) return cookies;
      return { ...cookies, [item.slice(0, index)]: decodeURIComponent(item.slice(index + 1)) };
    }, {});
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function signSession(payload) {
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifySession(token) {
  const [body, signature] = String(token || "").split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function setSessionCookie(res, userId) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const token = signSession({ sub: userId, exp, nonce: crypto.randomBytes(8).toString("hex") });
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  res.setHeader("set-cookie", `skillhub_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("set-cookie", "skillhub_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  if (Buffer.byteLength(hash, "hex") !== Buffer.byteLength(expectedHash, "hex")) return false;
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(expectedHash, "hex"));
}

class AppError extends Error {
  constructor(code, message, status = 400, details = []) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function sendData(res, data, status = 200, meta = undefined) {
  res.status(status).json(meta ? { data, meta } : { data });
}

function sendError(res, error) {
  const isPgConflict = error.code === "23505";
  const status = error.status || (isPgConflict ? 409 : 500);
  const code = isPgConflict ? "conflict" : error.code || "internal_error";
  const message = status >= 500 ? "Unexpected server error" : error.message;
  res.status(status).json({
    error: {
      code,
      message,
      details: error.details || [],
    },
  });
}

async function ensureDirs() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
  await fs.mkdir(RELEASE_DIR, { recursive: true });
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      email text UNIQUE NOT NULL,
      name text NOT NULL,
      role text NOT NULL CHECK (role IN ('admin', 'member')),
      team text NOT NULL DEFAULT 'default',
      password_hash text NOT NULL,
      password_salt text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS skills (
      id text PRIMARY KEY,
      slug text UNIQUE NOT NULL,
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      owner_team text NOT NULL DEFAULT 'default',
      tags text[] NOT NULL DEFAULT ARRAY[]::text[],
      created_by text REFERENCES users(id),
      current_version_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS skill_versions (
      id text PRIMARY KEY,
      skill_id text NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      version text NOT NULL,
      source_type text NOT NULL CHECK (source_type IN ('upload', 'github')),
      source_repo text,
      source_path text,
      source_ref text,
      source_commit_sha text,
      content_hash text NOT NULL,
      package_zip_path text,
      snapshot_dir text NOT NULL,
      manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
      frontmatter jsonb NOT NULL DEFAULT '{}'::jsonb,
      permissions text[] NOT NULL DEFAULT ARRAY[]::text[],
      risk text NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
      status text NOT NULL CHECK (status IN ('draft', 'review', 'approved', 'published', 'rejected', 'archived')),
      scan_report jsonb NOT NULL DEFAULT '{}'::jsonb,
      file_manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
      rejection_reason text,
      reviewer_id text REFERENCES users(id),
      reviewed_at timestamptz,
      publisher_id text REFERENCES users(id),
      published_at timestamptz,
      publish_repo text,
      publish_branch text,
      publish_commit_sha text,
      sync_status text NOT NULL DEFAULT 'not_synced',
      sync_error text,
      created_by text REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (skill_id, version)
    );

    CREATE TABLE IF NOT EXISTS review_events (
      id text PRIMARY KEY,
      skill_version_id text NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
      actor_id text REFERENCES users(id),
      action text NOT NULL,
      reason text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id text PRIMARY KEY,
      actor_id text REFERENCES users(id),
      action text NOT NULL,
      target_type text NOT NULL,
      target_id text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query("ALTER TABLE skills ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT ARRAY[]::text[]");
  await pool.query("UPDATE skills SET tags = $1 WHERE array_length(tags, 1) IS NULL", [DEFAULT_SKILL_TAGS]);

  const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123456";
  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [adminEmail]);
  if (existing.rowCount === 0) {
    const id = uid("usr");
    const { salt, hash } = hashPassword(adminPassword);
    await pool.query(
      "INSERT INTO users (id, email, name, role, team, password_hash, password_salt) VALUES ($1, $2, $3, 'admin', 'platform', $4, $5)",
      [id, adminEmail, "Platform Admin", hash, salt],
    );
  }
}

async function audit(actorId, action, targetType, targetId, metadata = {}) {
  await pool.query(
    "INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)",
    [uid("audit"), actorId || null, action, targetType, targetId, JSON.stringify(metadata)],
  );
}

function toUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    team: row.team,
    createdAt: row.created_at,
  };
}

function toSkill(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerTeam: row.owner_team,
    tags: row.tags || [],
    currentVersionId: row.current_version_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVersion(row) {
  const downloadPath = `/api/skill-versions/${row.id}/download`;
  const publicDownloadPath = row.slug ? publicSkillPath(row.slug, row.version, "download") : `/api/public/skill-versions/${row.id}/download`;
  const installScriptPath = row.slug ? publicSkillPath(row.slug, row.version, "install.sh") : `/api/public/skill-versions/${row.id}/install.sh`;
  return {
    id: row.id,
    skillId: row.skill_id,
    version: row.version,
    sourceType: row.source_type,
    sourceRepo: row.source_repo,
    sourcePath: row.source_path,
    sourceRef: row.source_ref,
    sourceCommitSha: row.source_commit_sha,
    contentHash: row.content_hash,
    permissions: row.permissions || [],
    risk: row.risk,
    status: row.status,
    scanReport: row.scan_report || {},
    fileManifest: row.file_manifest || [],
    manifest: row.manifest || {},
    frontmatter: row.frontmatter || {},
    rejectionReason: row.rejection_reason,
    reviewerId: row.reviewer_id,
    reviewedAt: row.reviewed_at,
    publisherId: row.publisher_id,
    publishedAt: row.published_at,
    publishRepo: row.publish_repo,
    publishBranch: row.publish_branch,
    publishCommitSha: row.publish_commit_sha,
    syncStatus: row.sync_status,
    syncError: row.sync_error,
    installCommand: `curl -fsSL ${absoluteUrl(installScriptPath)} | sh`,
    downloadUrl: downloadPath,
    authenticatedDownloadUrl: downloadPath,
    publicDownloadPath,
    publicDownloadUrl: absoluteUrl(publicDownloadPath),
    agentPullPath: publicDownloadPath,
    agentPullUrl: absoluteUrl(publicDownloadPath),
    installScriptPath,
    installScriptUrl: absoluteUrl(installScriptPath),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie).skillhub_session;
    const payload = verifySession(token);
    if (!payload) throw new AppError("unauthorized", "Authentication required", 401);
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [payload.sub]);
    if (result.rowCount === 0) throw new AppError("unauthorized", "Authentication required", 401);
    req.user = result.rows[0];
    next();
  } catch (error) {
    sendError(res, error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    sendError(res, new AppError("forbidden", "Admin role required", 403));
    return;
  }
  next();
}

function parseScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => item.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return trimmed;
}

function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { frontmatter: {}, body: content };
  const frontmatter = {};
  let key = null;
  let end = -1;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "---") {
      end = index;
      break;
    }
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && key) {
      frontmatter[key] = [...(Array.isArray(frontmatter[key]) ? frontmatter[key] : []), parseScalar(listItem[1])];
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      key = match[1];
      frontmatter[key] = match[2] === "" ? [] : parseScalar(match[2]);
    }
  }

  return { frontmatter, body: end >= 0 ? lines.slice(end + 1).join("\n") : content };
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function inferPermissions(frontmatter, body, manifest) {
  const manifestPermissions = Array.isArray(manifest?.permissions) ? manifest.permissions.map((item) => item.type || item) : [];
  const raw = [
    ...asArray(frontmatter["allowed-tools"]),
    ...asArray(frontmatter.allowed_tools),
    ...asArray(frontmatter.tools),
    ...manifestPermissions,
  ].join(" ").toLowerCase();
  const haystack = `${raw}\n${body}`.toLowerCase();
  const permissions = new Set();
  if (/bash|shell|terminal|exec|command/.test(haystack)) permissions.add("shell");
  if (/http|https|fetch|curl|network|api|webhook/.test(haystack)) permissions.add("network");
  if (/file|filesystem|readfile|writefile|path|directory/.test(haystack)) permissions.add("filesystem");
  if (/browser|playwright|chrome/.test(haystack)) permissions.add("browser");
  if (/database|sql|postgres|mysql|sqlite|supabase/.test(haystack)) permissions.add("database");
  if (/slack|feishu|lark|wechat|message|messaging|email/.test(haystack)) permissions.add("messaging");
  if (/secret|token|password|api[_-]?key|credential|\.env|ssh/.test(haystack)) permissions.add("secrets");
  return [...permissions];
}

function inferRisk(permissions, body, fileManifest) {
  const content = body.toLowerCase();
  const sensitiveFile = fileManifest.some((file) => /\.(env|pem|key|p12)$/i.test(file.path) || /(^|\/)(id_rsa|id_ed25519|\.ssh|\.aws|\.npmrc)/.test(file.path));
  if (permissions.includes("secrets") || sensitiveFile || /keychain|private[_-]?key|password/.test(content)) return "critical";
  if (permissions.some((permission) => ["shell", "database", "browser"].includes(permission))) return "high";
  if (permissions.some((permission) => ["network", "filesystem", "messaging"].includes(permission))) return "medium";
  return "low";
}

function validateRelativePath(filePath) {
  const normalized = filePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0") || normalized.split("/").some((part) => part === "..")) {
    throw new AppError("invalid_package_path", "Package contains unsafe file path", 422, [{ path: filePath }]);
  }
  return normalized;
}

function isSymlinkEntry(entry) {
  const mode = (entry.externalFileAttributes >> 16) & 0o170000;
  return mode === 0o120000;
}

async function readZipEntries(zipPath) {
  return new Promise((resolve, reject) => {
    const entries = [];
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (openError, zipfile) => {
      if (openError) {
        reject(new AppError("invalid_zip", "Upload must be a valid zip file", 422));
        return;
      }
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (entries.length >= MAX_FILE_COUNT) {
          reject(new AppError("too_many_files", `Zip exceeds ${MAX_FILE_COUNT} files`, 422));
          zipfile.close();
          return;
        }
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        if (isSymlinkEntry(entry)) {
          reject(new AppError("symlink_not_allowed", "Zip must not contain symlinks", 422, [{ path: entry.fileName }]));
          zipfile.close();
          return;
        }
        const safePath = validateRelativePath(entry.fileName);
        if (entry.uncompressedSize > MAX_FILE_BYTES) {
          reject(new AppError("file_too_large", `File exceeds ${MAX_FILE_BYTES} bytes`, 422, [{ path: safePath }]));
          zipfile.close();
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => {
            entries.push({
              path: safePath,
              content: Buffer.concat(chunks),
            });
            zipfile.readEntry();
          });
          stream.on("error", reject);
        });
      });
      zipfile.on("end", () => resolve(entries));
      zipfile.on("error", reject);
    });
  });
}

function stripRoot(entries, skillPath) {
  const root = skillPath.split("/").slice(0, -1).join("/");
  return entries
    .filter((entry) => !root || entry.path === root || entry.path.startsWith(`${root}/`))
    .map((entry) => ({
      path: root ? entry.path.slice(root.length + 1) : entry.path,
      content: entry.content,
    }))
    .filter((entry) => entry.path);
}

async function writeSnapshot(entries, versionId) {
  const targetDir = path.join(SNAPSHOT_DIR, versionId);
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    const target = path.join(targetDir, validateRelativePath(entry.path));
    if (!target.startsWith(`${targetDir}${path.sep}`)) {
      throw new AppError("invalid_package_path", "Package contains unsafe file path", 422, [{ path: entry.path }]);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.content);
  }
  return targetDir;
}

function buildFileManifest(entries) {
  return entries.map((entry) => ({
    path: entry.path,
    size: entry.content.length,
    sha256: hashText(entry.content),
  })).sort((a, b) => a.path.localeCompare(b.path));
}

function parseSkillPackage(entries, source) {
  const skillFiles = entries.filter((entry) => entry.path.split("/").pop() === "SKILL.md");
  if (skillFiles.length === 0) throw new AppError("skill_not_found", "Package must contain SKILL.md", 422);
  if (skillFiles.length > 1) throw new AppError("multiple_skills_not_supported", "Package must contain exactly one SKILL.md", 422);

  const normalizedEntries = stripRoot(entries, skillFiles[0].path);
  const skillEntry = normalizedEntries.find((entry) => entry.path === "SKILL.md");
  const manifestEntry = normalizedEntries.find((entry) => entry.path === "skill.manifest.json");
  const skillContent = skillEntry.content.toString("utf8");
  let manifest = {};
  if (manifestEntry) {
    try {
      manifest = JSON.parse(manifestEntry.content.toString("utf8"));
    } catch {
      throw new AppError("invalid_manifest", "skill.manifest.json must be valid JSON", 422);
    }
  }
  const { frontmatter, body } = parseFrontmatter(skillContent);
  const fileManifest = buildFileManifest(normalizedEntries);
  const permissions = inferPermissions(frontmatter, body, manifest);
  const risk = inferRisk(permissions, body, fileManifest);
  const name = manifest.name || frontmatter.name || path.basename(source.sourcePath || "skill");
  const slug = slugify(manifest.name || frontmatter.name || name);
  const version = source.version || manifest.version || frontmatter.version || source.sourceRef || nowIso().replace(/[-:.TZ]/g, "").slice(0, 14);
  const tags = normalizeTags(
    source.tags,
    manifest.tags,
    manifest.platforms,
    manifest.categories,
    frontmatter.tags,
    frontmatter.platforms,
    frontmatter.categories,
    inferTagsFromText(`${name}\n${body}\n${JSON.stringify(manifest)}`),
  );
  const scanReport = {
    scannedAt: nowIso(),
    fileCount: fileManifest.length,
    totalBytes: fileManifest.reduce((sum, file) => sum + file.size, 0),
    warnings: [
      ...(permissions.includes("shell") ? ["Requests shell-like capability"] : []),
      ...(permissions.includes("secrets") ? ["Mentions secrets or credentials"] : []),
      ...(risk === "critical" ? ["Critical risk requires careful manual review"] : []),
    ],
  };
  const contentHash = hashText(JSON.stringify(fileManifest.map((file) => [file.path, file.sha256])));

  return {
    entries: normalizedEntries,
    skill: {
      name,
      slug,
      description: manifest.description || frontmatter.description || body.split(/\r?\n/).find((line) => line.trim()) || "",
      ownerTeam: source.ownerTeam || "default",
      tags: tags.length ? tags : DEFAULT_SKILL_TAGS,
    },
    version: {
      version,
      sourceType: source.sourceType,
      sourceRepo: source.sourceRepo || null,
      sourcePath: source.sourcePath || null,
      sourceRef: source.sourceRef || null,
      sourceCommitSha: source.sourceCommitSha || null,
      contentHash,
      manifest,
      frontmatter,
      permissions,
      risk,
      status: "draft",
      scanReport,
      fileManifest,
    },
  };
}

async function createReleaseZip(sourceDir, targetZip, metadata) {
  await fs.mkdir(path.dirname(targetZip), { recursive: true });
  await fs.writeFile(path.join(sourceDir, "skillhub.metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  const zipfile = new yazl.ZipFile();
  const output = fssync.createWriteStream(targetZip);
  const done = new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    zipfile.outputStream.on("error", reject);
  });
  async function addDir(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await addDir(full, relative);
      } else if (entry.isFile()) {
        zipfile.addFile(full, relative);
      }
    }
  }
  await addDir(sourceDir);
  zipfile.outputStream.pipe(output);
  zipfile.end();
  await done;
}

function buildReleaseMetadata(version, actorId = null) {
  return {
    skill: {
      id: version.skill_id,
      slug: version.slug,
      name: version.name,
      ownerTeam: version.owner_team,
      tags: version.tags || [],
    },
    version: {
      id: version.id,
      version: version.version,
      contentHash: version.content_hash,
      sourceType: version.source_type,
      sourceRepo: version.source_repo,
      sourcePath: version.source_path,
      sourceRef: version.source_ref,
      sourceCommitSha: version.source_commit_sha,
    },
    generatedAt: nowIso(),
    publishedBy: actorId,
  };
}

async function packageSkillVersion(version, actorId = null) {
  const zipName = `${safeFilePart(version.slug)}-${safeFilePart(version.version)}.zip`;
  const zipPath = version.package_zip_path || path.join(RELEASE_DIR, zipName);
  if (version.package_zip_path && fssync.existsSync(version.package_zip_path)) {
    return version.package_zip_path;
  }
  await createReleaseZip(version.snapshot_dir, zipPath, buildReleaseMetadata(version, actorId));
  await pool.query("UPDATE skill_versions SET package_zip_path = $1 WHERE id = $2", [zipPath, version.id]);
  return zipPath;
}

async function upsertSkillPackage(parsed, userId) {
  const skillId = uid("skl");
  const versionId = uid("ver");
  const snapshotDir = await writeSnapshot(parsed.entries, versionId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM skills WHERE slug = $1", [parsed.skill.slug]);
    const finalSkillId = existing.rowCount ? existing.rows[0].id : skillId;
    if (existing.rowCount === 0) {
      await client.query(
        "INSERT INTO skills (id, slug, name, description, owner_team, tags, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [finalSkillId, parsed.skill.slug, parsed.skill.name, parsed.skill.description, parsed.skill.ownerTeam, parsed.skill.tags, userId],
      );
    } else {
      await client.query(
        "UPDATE skills SET name = $1, description = $2, owner_team = $3, tags = $4, updated_at = now() WHERE id = $5",
        [parsed.skill.name, parsed.skill.description, parsed.skill.ownerTeam, parsed.skill.tags, finalSkillId],
      );
    }
    const duplicate = await client.query("SELECT id FROM skill_versions WHERE skill_id = $1 AND version = $2", [finalSkillId, parsed.version.version]);
    if (duplicate.rowCount) {
      throw new AppError("duplicate_version", "This skill version already exists", 409);
    }
    await client.query(
      `INSERT INTO skill_versions (
        id, skill_id, version, source_type, source_repo, source_path, source_ref, source_commit_sha,
        content_hash, snapshot_dir, manifest, frontmatter, permissions, risk, status, scan_report,
        file_manifest, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16,
        $17, $18
      )`,
      [
        versionId,
        finalSkillId,
        parsed.version.version,
        parsed.version.sourceType,
        parsed.version.sourceRepo,
        parsed.version.sourcePath,
        parsed.version.sourceRef,
        parsed.version.sourceCommitSha,
        parsed.version.contentHash,
        snapshotDir,
        JSON.stringify(parsed.version.manifest),
        JSON.stringify(parsed.version.frontmatter),
        parsed.version.permissions,
        parsed.version.risk,
        parsed.version.status,
        JSON.stringify(parsed.version.scanReport),
        JSON.stringify(parsed.version.fileManifest),
        userId,
      ],
    );
    await client.query("COMMIT");
    await audit(userId, "skill_version_created", "skill_version", versionId, { slug: parsed.skill.slug, version: parsed.version.version });
    return { skillId: finalSkillId, versionId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function githubConfig() {
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY || "";
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH || "";
  return {
    appId: process.env.GITHUB_APP_ID || "",
    privateKey: privateKey.replace(/\\n/g, "\n"),
    privateKeyPath,
    installationId: process.env.GITHUB_INSTALLATION_ID || "",
  };
}

async function getGithubPrivateKey() {
  const config = githubConfig();
  if (config.privateKey) return config.privateKey;
  if (config.privateKeyPath) return fs.readFile(config.privateKeyPath, "utf8");
  return "";
}

async function githubJwt() {
  const config = githubConfig();
  const privateKey = await getGithubPrivateKey();
  if (!config.appId || !privateKey || !config.installationId) {
    throw new AppError("github_not_configured", "GitHub App is not configured", 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: config.appId }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");
  return `${header}.${payload}.${signature}`;
}

async function githubInstallationToken() {
  const jwt = await githubJwt();
  const config = githubConfig();
  const response = await fetch(`https://api.github.com/app/installations/${config.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "user-agent": "skillhub",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new AppError("github_auth_failed", `GitHub App token request failed with ${response.status}`, 502);
  }
  const payload = await response.json();
  return payload.token;
}

async function githubRequest(route, options = {}) {
  const { auth = "auto", ...fetchOptions } = options;
  const token = auth === "app" || (auth === "auto" && isGithubAppConfigured())
    ? await githubInstallationToken()
    : "";
  const response = await fetch(`https://api.github.com${route}`, {
    ...fetchOptions,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "skillhub",
      "x-github-api-version": "2022-11-28",
      ...(fetchOptions.headers || {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const notFoundMessage = "GitHub repo/path not found or private. Public repo can import directly; private repo requires GitHub App config.";
    const message = response.status === 404 && !token ? notFoundMessage : payload.message || `GitHub API failed with ${response.status}`;
    throw new AppError("github_api_error", message, response.status === 404 ? 404 : 502);
  }
  return payload;
}

function validateRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new AppError("invalid_repo", "Repo must be owner/name", 422);
  }
}

function normalizeRepoPath(inputPath) {
  const clean = String(inputPath || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean || clean === ".") return ".";
  if (clean.includes("..")) throw new AppError("invalid_source_path", "Path is invalid", 422);
  return clean.endsWith("/SKILL.md") || clean === "SKILL.md" ? path.posix.dirname(clean) : clean;
}

function parseGithubUrl(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppError("invalid_github_url", "GitHub link is invalid", 422);
  }
  if (parsed.hostname !== "github.com") {
    throw new AppError("invalid_github_url", "GitHub link must use github.com", 422);
  }
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) {
    throw new AppError("invalid_github_url", "GitHub link must include owner and repo", 422);
  }
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
  const markerIndex = parts.findIndex((part) => part === "tree" || part === "blob");
  if (markerIndex === -1) {
    return { repo, path: ".", ref: null };
  }
  const marker = parts[markerIndex];
  const rest = parts.slice(markerIndex + 1);
  if (!rest.length) {
    throw new AppError("invalid_github_url", "GitHub link must include a branch or tag", 422);
  }
  const ref = rest[0];
  const sourcePath = rest.slice(1).join("/") || ".";
  return {
    repo,
    path: marker === "blob" ? normalizeRepoPath(sourcePath) : sourcePath,
    ref,
  };
}

function normalizeGithubImportPayload(payload) {
  const parsed = parseGithubUrl(payload.url || payload.githubUrl);
  return {
    repo: payload.repo || parsed?.repo,
    path: payload.path || parsed?.path || ".",
    ref: payload.ref || parsed?.ref || null,
  };
}

async function importGithubPackage(payload) {
  const normalized = normalizeGithubImportPayload(payload);
  const repo = assertString(normalized.repo, "repo");
  validateRepo(repo);
  const sourcePath = normalizeRepoPath(normalized.path);
  const [owner, name] = repo.split("/");
  let sourceRef = normalized.ref ? assertString(normalized.ref, "ref", 1, 120) : "";
  if (!sourceRef) {
    const repoInfo = await githubRequest(`/repos/${owner}/${name}`);
    sourceRef = assertString(repoInfo.default_branch || "main", "ref", 1, 120);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(sourceRef) || sourceRef.includes("..")) {
    throw new AppError("invalid_ref", "Ref is invalid", 422);
  }
  const commit = await githubRequest(`/repos/${owner}/${name}/commits/${encodeURIComponent(sourceRef)}`);
  const tree = await githubRequest(`/repos/${owner}/${name}/git/trees/${commit.sha}?recursive=1`);
  let skillRoot = sourcePath;
  if (sourcePath === ".") {
    const matches = tree.tree.filter((item) => item.type === "blob" && (item.path === "SKILL.md" || item.path.endsWith("/SKILL.md")));
    if (matches.length > 1) {
      throw new AppError("multiple_github_skills", "Repo contains multiple SKILL.md files. Paste a tree/blob link for one skill folder.", 422);
    }
    skillRoot = matches[0] ? path.posix.dirname(matches[0].path) : ".";
  }
  const prefix = skillRoot === "." ? "" : `${skillRoot}/`;
  const files = tree.tree.filter((item) => item.type === "blob" && item.path.startsWith(prefix));
  if (!files.some((file) => file.path === `${prefix}SKILL.md` || file.path === "SKILL.md")) {
    throw new AppError("skill_not_found", "GitHub path must contain SKILL.md", 404);
  }
  if (files.length > MAX_FILE_COUNT) throw new AppError("too_many_files", `GitHub skill exceeds ${MAX_FILE_COUNT} files`, 422);
  const entries = [];
  for (const file of files) {
    const blob = await githubRequest(`/repos/${owner}/${name}/git/blobs/${file.sha}`);
    const content = Buffer.from(blob.content || "", blob.encoding || "base64");
    if (content.length > MAX_FILE_BYTES) throw new AppError("file_too_large", `File exceeds ${MAX_FILE_BYTES} bytes`, 422, [{ path: file.path }]);
    entries.push({
      path: validateRelativePath(file.path.slice(prefix.length)),
      content,
    });
  }
  return parseSkillPackage(entries, {
    sourceType: "github",
    sourceRepo: repo,
    sourcePath: skillRoot,
    sourceRef,
    sourceCommitSha: commit.sha,
    version: payload.version || sourceRef,
    ownerTeam: payload.ownerTeam || "default",
  });
}

async function loadVersion(versionId) {
  const result = await pool.query(
    `SELECT sv.*, s.slug, s.name, s.description, s.owner_team, s.tags
     FROM skill_versions sv
     JOIN skills s ON s.id = sv.skill_id
     WHERE sv.id = $1`,
    [versionId],
  );
  if (result.rowCount === 0) throw new AppError("not_found", "Skill version not found", 404);
  return result.rows[0];
}

async function githubSyncVersion(version, actorId) {
  if (!PUBLISH_REPO) throw new AppError("github_not_configured", "PUBLISH_REPO is not configured", 400);
  validateRepo(PUBLISH_REPO);
  const [owner, repo] = PUBLISH_REPO.split("/");
  const syncRequest = (route, options = {}) => githubRequest(route, { ...options, auth: "app" });
  const releaseZipPath = await packageSkillVersion(version, actorId);
  const entries = [];
  async function walk(directory, prefix = "") {
    const children = await fs.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const full = path.join(directory, child.name);
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.isDirectory()) {
        await walk(full, relative);
      } else if (child.isFile()) {
        entries.push({ path: relative, content: await fs.readFile(full) });
      }
    }
  }
  await walk(version.snapshot_dir);
  const branch = await syncRequest(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(PUBLISH_BRANCH)}`);
  const baseCommitSha = branch.object.sha;
  const baseCommit = await syncRequest(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
  const tree = [];
  for (const entry of entries) {
    const blob = await syncRequest(`/repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({
        content: entry.content.toString("base64"),
        encoding: "base64",
      }),
    });
    tree.push({
      path: `skills/${version.slug}/${entry.path}`,
      mode: "100644",
      type: "blob",
      sha: blob.sha,
    });
  }
  const newTree = await syncRequest(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  const newCommit = await syncRequest(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message: `publish: ${version.slug}@${version.version}`,
      tree: newTree.sha,
      parents: [baseCommitSha],
    }),
  });
  await syncRequest(`/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(PUBLISH_BRANCH)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: newCommit.sha }),
  });
  return {
    commitSha: newCommit.sha,
    releaseZipPath,
  };
}

async function listSkillsForUser(user) {
  const params = [];
  const where = user.role === "admin" ? "" : "WHERE s.created_by = $1 OR v.status = 'published'";
  if (user.role !== "admin") params.push(user.id);
  const result = await pool.query(
    `SELECT s.*, v.id AS latest_version_id, v.version AS latest_version, v.status AS latest_status, v.risk AS latest_risk,
            v.source_type AS latest_source_type, v.sync_status AS latest_sync_status, v.publish_commit_sha AS latest_publish_commit_sha
     FROM skills s
     LEFT JOIN LATERAL (
       SELECT * FROM skill_versions sv WHERE sv.skill_id = s.id ORDER BY sv.created_at DESC LIMIT 1
     ) v ON true
     ${where}
     ORDER BY s.updated_at DESC`,
    params,
  );
  return result.rows.map((row) => ({
    ...toSkill(row),
    latestVersionId: row.latest_version_id,
    latestVersion: row.latest_version,
    latestStatus: row.latest_status,
    latestRisk: row.latest_risk,
    latestSourceType: row.latest_source_type,
    latestSyncStatus: row.latest_sync_status,
    latestPublishCommitSha: row.latest_publish_commit_sha,
  }));
}

app.get("/api/health", async (req, res) => {
  sendData(res, {
    ok: true,
    githubConfigured: isGithubAppConfigured(),
    githubSyncConfigured: isGithubSyncConfigured(),
    publishRepo: PUBLISH_REPO || null,
    publishBranch: PUBLISH_BRANCH,
  });
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = assertString(req.body.email, "email").toLowerCase();
    const password = assertString(req.body.password, "password", 1, 200);
    const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
    if (result.rowCount === 0 || !verifyPassword(password, result.rows[0].password_salt, result.rows[0].password_hash)) {
      throw new AppError("invalid_credentials", "Invalid email or password", 401);
    }
    setSessionCookie(res, result.rows[0].id);
    await audit(result.rows[0].id, "login", "user", result.rows[0].id);
    sendData(res, toUser(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", requireAuth, async (req, res) => {
  clearSessionCookie(res);
  sendData(res, { ok: true });
});

app.get("/api/me", requireAuth, async (req, res) => {
  sendData(res, toUser(req.user));
});

app.get("/api/users", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM users ORDER BY created_at DESC");
    sendData(res, result.rows.map(toUser));
  } catch (error) {
    next(error);
  }
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const email = assertString(req.body.email, "email").toLowerCase();
    const name = assertString(req.body.name, "name");
    const password = assertString(req.body.password, "password", 8, 200);
    const role = req.body.role === "admin" ? "admin" : "member";
    const team = assertString(req.body.team || "default", "team");
    const id = uid("usr");
    const { salt, hash } = hashPassword(password);
    const result = await pool.query(
      "INSERT INTO users (id, email, name, role, team, password_hash, password_salt) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *",
      [id, email, name, role, team, hash, salt],
    );
    await audit(req.user.id, "user_created", "user", id, { email, role, team });
    sendData(res, toUser(result.rows[0]), 201);
  } catch (error) {
    next(error);
  }
});

function ownerTeamForRequest(user, requestedTeam) {
  if (user.role === "admin" && requestedTeam) {
    return assertString(requestedTeam, "ownerTeam", 1, 80);
  }
  return user.team;
}

app.post("/api/skills/uploads", requireAuth, upload.single("package"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError("missing_upload", "A zip package is required", 422);
    const entries = await readZipEntries(req.file.path);
    const parsed = parseSkillPackage(entries, {
      sourceType: "upload",
      sourceRepo: null,
      sourcePath: req.file.originalname,
      sourceRef: null,
      version: req.body.version || undefined,
      ownerTeam: ownerTeamForRequest(req.user, req.body.ownerTeam),
      tags: req.body.tags,
    });
    const result = await upsertSkillPackage(parsed, req.user.id);
    await fs.copyFile(req.file.path, path.join(UPLOAD_DIR, `${result.versionId}.zip`));
    sendData(res, result, 201);
  } catch (error) {
    next(error);
  } finally {
    if (req.file?.path) await fs.rm(req.file.path, { force: true });
  }
});

app.post("/api/skills/imports/github", requireAuth, async (req, res, next) => {
  try {
    const parsed = await importGithubPackage({
      ...req.body,
      ownerTeam: ownerTeamForRequest(req.user, req.body.ownerTeam),
      tags: req.body.tags,
    });
    const result = await upsertSkillPackage(parsed, req.user.id);
    sendData(res, result, 201);
  } catch (error) {
    next(error);
  }
});

app.get("/api/skills", requireAuth, async (req, res, next) => {
  try {
    sendData(res, await listSkillsForUser(req.user));
  } catch (error) {
    next(error);
  }
});

app.get("/api/skills/:id", requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM skills WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) throw new AppError("not_found", "Skill not found", 404);
    const skill = result.rows[0];
    if (req.user.role !== "admin" && skill.created_by !== req.user.id) {
      const published = await pool.query("SELECT id FROM skill_versions WHERE skill_id = $1 AND status = 'published' LIMIT 1", [skill.id]);
      if (published.rowCount === 0) throw new AppError("forbidden", "Not allowed", 403);
    }
    sendData(res, toSkill(skill));
  } catch (error) {
    next(error);
  }
});

app.get("/api/skills/:id/versions", requireAuth, async (req, res, next) => {
  try {
    const skillResult = await pool.query("SELECT * FROM skills WHERE id = $1", [req.params.id]);
    if (skillResult.rowCount === 0) throw new AppError("not_found", "Skill not found", 404);
    const skill = skillResult.rows[0];
    if (req.user.role !== "admin" && skill.created_by !== req.user.id) {
      const published = await pool.query("SELECT id FROM skill_versions WHERE skill_id = $1 AND status = 'published' LIMIT 1", [skill.id]);
      if (published.rowCount === 0) throw new AppError("forbidden", "Not allowed", 403);
    }
    const result = await pool.query(
      `SELECT sv.*, s.slug FROM skill_versions sv JOIN skills s ON s.id = sv.skill_id
       WHERE sv.skill_id = $1
         AND ($2::boolean OR sv.created_by = $3 OR sv.status = 'published')
       ORDER BY sv.created_at DESC`,
      [req.params.id, req.user.role === "admin", req.user.id],
    );
    sendData(res, result.rows.map(toVersion));
  } catch (error) {
    next(error);
  }
});

async function transitionVersion(req, status, fields = {}) {
  const version = await loadVersion(req.params.id);
  if (req.user.role !== "admin" && version.created_by !== req.user.id) {
    throw new AppError("forbidden", "Not allowed", 403);
  }
  const allowedForMember = status === "review";
  if (!allowedForMember && req.user.role !== "admin") {
    throw new AppError("forbidden", "Admin role required", 403);
  }
  const nextFields = {
    reviewer_id: fields.reviewerId || null,
    reviewed_at: fields.reviewedAt || null,
    rejection_reason: fields.rejectionReason || null,
    sync_status: fields.syncStatus || version.sync_status,
    sync_error: fields.syncError || null,
  };
  await pool.query(
    `UPDATE skill_versions
     SET status = $1, reviewer_id = COALESCE($2, reviewer_id), reviewed_at = COALESCE($3, reviewed_at),
         rejection_reason = $4, sync_status = $5, sync_error = $6
     WHERE id = $7`,
    [status, nextFields.reviewer_id, nextFields.reviewed_at, nextFields.rejection_reason, nextFields.sync_status, nextFields.sync_error, req.params.id],
  );
  await pool.query("INSERT INTO review_events (id, skill_version_id, actor_id, action, reason) VALUES ($1, $2, $3, $4, $5)", [
    uid("rev"),
    req.params.id,
    req.user.id,
    status,
    fields.reason || null,
  ]);
  await audit(req.user.id, `version_${status}`, "skill_version", req.params.id, fields);
  return loadVersion(req.params.id);
}

app.post("/api/skill-versions/:id/submit-review", requireAuth, async (req, res, next) => {
  try {
    const version = await transitionVersion(req, "review", { reason: "submitted" });
    sendData(res, toVersion(version));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skill-versions/:id/approve", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const version = await transitionVersion(req, "approved", {
      reviewerId: req.user.id,
      reviewedAt: nowIso(),
      syncStatus: "not_synced",
      reason: req.body.reason || "approved",
    });
    sendData(res, toVersion(version));
  } catch (error) {
    next(error);
  }
});

app.post("/api/skill-versions/:id/reject", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const reason = assertString(req.body.reason, "reason", 1, 1000);
    const version = await transitionVersion(req, "rejected", {
      reviewerId: req.user.id,
      reviewedAt: nowIso(),
      rejectionReason: reason,
      syncStatus: "not_synced",
      reason,
    });
    sendData(res, toVersion(version));
  } catch (error) {
    next(error);
  }
});

async function publishVersion(req, res) {
  const version = await loadVersion(req.params.id);
  if (version.status !== "approved" && version.status !== "published") {
    throw new AppError("invalid_state", "Version must be approved before publishing", 409);
  }
  if (version.status === "published") {
    sendData(res, toVersion(version));
    return;
  }
  const releaseZipPath = await packageSkillVersion(version, req.user.id);
  const initialSyncStatus = isGithubSyncConfigured() ? "not_synced" : "local_only";
  await pool.query(
    `UPDATE skill_versions
     SET status = 'published', sync_status = $1, sync_error = NULL, publisher_id = $2,
         published_at = now(), package_zip_path = $3
     WHERE id = $4`,
    [initialSyncStatus, req.user.id, releaseZipPath, version.id],
  );
  await pool.query("UPDATE skills SET current_version_id = $1, updated_at = now() WHERE id = $2", [version.id, version.skill_id]);
  await audit(req.user.id, "version_published", "skill_version", version.id, { mode: initialSyncStatus });

  if (isGithubSyncConfigured()) {
    await pool.query("UPDATE skill_versions SET sync_status = 'syncing', sync_error = NULL WHERE id = $1", [version.id]);
    try {
      const sync = await githubSyncVersion(await loadVersion(version.id), req.user.id);
      await pool.query(
        `UPDATE skill_versions
         SET sync_status = 'synced', sync_error = NULL, publish_repo = $1, publish_branch = $2,
             publish_commit_sha = $3, package_zip_path = $4
         WHERE id = $5`,
        [PUBLISH_REPO, PUBLISH_BRANCH, sync.commitSha, sync.releaseZipPath, version.id],
      );
      await audit(req.user.id, "version_synced_github", "skill_version", version.id, { commitSha: sync.commitSha, repo: PUBLISH_REPO });
    } catch (error) {
      await pool.query("UPDATE skill_versions SET sync_status = 'failed', sync_error = $1 WHERE id = $2", [error.message, version.id]);
      await audit(req.user.id, "version_sync_failed", "skill_version", version.id, { error: error.message, repo: PUBLISH_REPO });
    }
  }
  sendData(res, toVersion(await loadVersion(version.id)));
}

app.post("/api/skill-versions/:id/publish", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await publishVersion(req, res);
  } catch (error) {
    next(error);
  }
});

app.post("/api/skill-versions/:id/sync-github", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!isGithubSyncConfigured()) throw new AppError("github_not_configured", "GitHub App and PUBLISH_REPO must be configured", 400);
    const version = await loadVersion(req.params.id);
    if (version.status !== "approved" && version.status !== "published") {
      throw new AppError("invalid_state", "Version must be approved before GitHub sync", 409);
    }
    await pool.query("UPDATE skill_versions SET sync_status = 'syncing', sync_error = NULL WHERE id = $1", [version.id]);
    try {
      const sync = await githubSyncVersion(version, req.user.id);
      await pool.query(
        `UPDATE skill_versions
         SET status = 'published', sync_status = 'synced', sync_error = NULL, publisher_id = $1,
             published_at = COALESCE(published_at, now()), publish_repo = $2, publish_branch = $3,
             publish_commit_sha = $4, package_zip_path = $5
         WHERE id = $6`,
        [req.user.id, PUBLISH_REPO, PUBLISH_BRANCH, sync.commitSha, sync.releaseZipPath, version.id],
      );
      await pool.query("UPDATE skills SET current_version_id = $1, updated_at = now() WHERE id = $2", [version.id, version.skill_id]);
      await audit(req.user.id, "version_synced_github", "skill_version", version.id, { commitSha: sync.commitSha, repo: PUBLISH_REPO });
      sendData(res, toVersion(await loadVersion(version.id)));
    } catch (error) {
      await pool.query("UPDATE skill_versions SET sync_status = 'failed', sync_error = $1 WHERE id = $2", [error.message, version.id]);
      throw error;
    }
  } catch (error) {
    next(error);
  }
});

app.post("/api/skill-versions/:id/archive", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await pool.query("UPDATE skill_versions SET status = 'archived' WHERE id = $1", [req.params.id]);
    await audit(req.user.id, "version_archived", "skill_version", req.params.id);
    sendData(res, toVersion(await loadVersion(req.params.id)));
  } catch (error) {
    next(error);
  }
});

function requestBaseUrl(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const protocol = forwardedProto || req.protocol || "http";
  const host = forwardedHost || req.headers.host;
  return host ? `${protocol}://${host}` : String(PUBLIC_BASE_URL).replace(/\/+$/, "");
}

async function loadPublishedVersionBySlug(slug, version) {
  const result = await pool.query(
    `SELECT sv.*, s.slug, s.name, s.description, s.owner_team, s.tags
     FROM skill_versions sv
     JOIN skills s ON s.id = sv.skill_id
     WHERE s.slug = $1 AND sv.version = $2 AND sv.status = 'published'`,
    [slug, version],
  );
  if (result.rowCount === 0) throw new AppError("not_found", "Published skill version not found", 404);
  return result.rows[0];
}

async function sendVersionZip(res, version) {
  const zipPath = await packageSkillVersion(version);
  res.download(zipPath, `${safeFilePart(version.slug)}-${safeFilePart(version.version)}.zip`);
}

function renderInstallScript(req, version) {
  const downloadUrl = `${requestBaseUrl(req)}${publicSkillPath(version.slug, version.version, "download")}`;
  return `#!/bin/sh
set -eu

SKILL_SLUG=${shellQuote(version.slug)}
SKILL_VERSION=${shellQuote(version.version)}
SKILL_DIR="\${SKILL_DIR:-$HOME/.agents/skills}"
TARGET_DIR="$SKILL_DIR/$SKILL_SLUG"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TARGET_DIR"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL ${shellQuote(downloadUrl)} -o "$TMP_DIR/skill.zip"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP_DIR/skill.zip" ${shellQuote(downloadUrl)}
else
  echo "curl or wget is required" >&2
  exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "unzip is required" >&2
  exit 1
fi

unzip -oq "$TMP_DIR/skill.zip" -d "$TARGET_DIR"
echo "Installed $SKILL_SLUG@$SKILL_VERSION to $TARGET_DIR"
`;
}

app.get("/api/public/skill-versions/:id/download", async (req, res, next) => {
  try {
    const version = await loadVersion(req.params.id);
    if (version.status !== "published") throw new AppError("not_found", "Published skill version not found", 404);
    await sendVersionZip(res, version);
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/skill-versions/:id/install.sh", async (req, res, next) => {
  try {
    const version = await loadVersion(req.params.id);
    if (version.status !== "published") throw new AppError("not_found", "Published skill version not found", 404);
    res.type("text/x-shellscript").send(renderInstallScript(req, version));
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/skills/:slug/:version/download", async (req, res, next) => {
  try {
    const version = await loadPublishedVersionBySlug(req.params.slug, req.params.version);
    await sendVersionZip(res, version);
  } catch (error) {
    next(error);
  }
});

app.get("/api/public/skills/:slug/:version/install.sh", async (req, res, next) => {
  try {
    const version = await loadPublishedVersionBySlug(req.params.slug, req.params.version);
    res.type("text/x-shellscript").send(renderInstallScript(req, version));
  } catch (error) {
    next(error);
  }
});

app.get("/api/skill-versions/:id/download", requireAuth, async (req, res, next) => {
  try {
    const version = await loadVersion(req.params.id);
    if (version.status !== "published" && req.user.role !== "admin" && version.created_by !== req.user.id) {
      throw new AppError("forbidden", "Not allowed", 403);
    }
    await sendVersionZip(res, version);
  } catch (error) {
    next(error);
  }
});

app.use("/api", (req, res) => {
  sendError(res, new AppError("not_found", "API route not found", 404));
});

app.use((req, res) => {
  res.sendFile(path.join(APP_DIR, "index.html"));
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    sendError(res, new AppError("upload_error", error.message, 422));
    return;
  }
  sendError(res, error);
});

async function start() {
  await ensureDirs();
  await migrate();
  app.listen(PORT, HOST, () => {
    console.log(`Skill Hub running at http://${HOST}:${PORT}`);
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
