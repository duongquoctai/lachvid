import { Database } from "@sqlitecloud/drivers";
import fs from "node:fs";
import path from "node:path";
import { hashPassword } from "@/lib/password";
import {
  CategoryPools,
  CategoryVideoItem,
  DEFAULT_SHARE_PERMISSIONS,
  MultiVoiceItem,
  ProjectAccessInfo,
  ProjectSharePermissions,
  RenderedVideoRecord,
  ResourceShare,
  ShotCategory,
  User,
  UserSafeProfile,
} from "@/types/lachvid";

export const DEFAULT_USER_ID = "usr_skin1004";
export const DEFAULT_USER_EMAIL = "skin1004@omnigen.com";
export const DEFAULT_USER_NAME = "Skin1004 Team";
export const DEFAULT_USER_PASSWORD = "skin1004";

export interface ParentProjectMeta {
  id: string;
  name: string;
  description?: string;
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
  foldersCount?: number;
  poolCount?: number;
  renderedCount?: number;
  voiceCount?: number;
  // Sharing & ownership context
  isOwner?: boolean;
  sharePermissions?: ProjectSharePermissions;
  ownerName?: string;
  ownerEmail?: string;
}

export interface ProjectMeta {
  id: string;
  parentProjectId?: string;
  parentProjectName?: string;
  name: string;
  description?: string;
  settings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  renderedCount?: number;
  poolCount?: number;
  voiceCount?: number;
}

const LOCAL_FALLBACK_FILE = path.join(process.cwd(), "data", "sqlitecloud_local.json");

function ensureLocalDataDir() {
  const dir = path.dirname(LOCAL_FALLBACK_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

interface LocalStorageSchema {
  users: Record<string, User>;
  shares: Record<string, ResourceShare>;
  parentProjects: Record<string, ParentProjectMeta>;
  projects: Record<string, ProjectMeta>;
  pools: Record<string, CategoryPools>;
  voices: Record<string, MultiVoiceItem[]>; // projectId -> voices
  rendered: Record<string, RenderedVideoRecord[]>; // projectId -> records
}

function readLocalStorage(): LocalStorageSchema {
  ensureLocalDataDir();
  const now = new Date().toISOString();
  if (!fs.existsSync(LOCAL_FALLBACK_FILE)) {
    const init: LocalStorageSchema = {
      users: {
        [DEFAULT_USER_ID]: {
          id: DEFAULT_USER_ID,
          email: DEFAULT_USER_EMAIL,
          name: DEFAULT_USER_NAME,
          passwordHash: hashPassword(DEFAULT_USER_PASSWORD),
          createdAt: now,
          updatedAt: now,
        },
      },
      shares: {},
      parentProjects: {},
      projects: {},
      pools: {},
      voices: {},
      rendered: {},
    };
    fs.writeFileSync(LOCAL_FALLBACK_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
  try {
    const data = JSON.parse(fs.readFileSync(LOCAL_FALLBACK_FILE, "utf8"));
    if (!data.users) data.users = {};
    if (!data.shares) data.shares = {};
    if (!data.parentProjects) data.parentProjects = {};
    if (!data.voices) data.voices = {};
    if (!data.rendered) data.rendered = {};
    if (!data.pools) data.pools = {};
    if (!data.projects) data.projects = {};

    let changed = false;

    // Đảm bảo có user mặc định
    if (!data.users[DEFAULT_USER_ID]) {
      data.users[DEFAULT_USER_ID] = {
        id: DEFAULT_USER_ID,
        email: DEFAULT_USER_EMAIL,
        name: DEFAULT_USER_NAME,
        passwordHash: hashPassword(DEFAULT_USER_PASSWORD),
        createdAt: now,
        updatedAt: now,
      };
      changed = true;
    }

    // Auto-migrate legacy projects to each have a matching parent project and default owner
    for (const p of Object.values(data.projects as Record<string, ProjectMeta>)) {
      if (!p.parentProjectId) {
        const parentId = `parent_${p.id}`;
        if (!data.parentProjects[parentId]) {
          data.parentProjects[parentId] = {
            id: parentId,
            name: p.name,
            description: p.description || "",
            ownerId: DEFAULT_USER_ID,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          };
        }
        p.parentProjectId = parentId;
        changed = true;
      }
    }

    // Migrate owner_id cho tất cả parent_projects cũ
    for (const parent of Object.values(data.parentProjects as Record<string, ParentProjectMeta>)) {
      if (!parent.ownerId) {
        parent.ownerId = DEFAULT_USER_ID;
        changed = true;
      }
    }

    // Tự động chuyển dữ liệu cũ từ project_state.json nếu chưa có dự án nào
    if (Object.keys(data.parentProjects).length === 0) {
      const stateFile = path.join(process.cwd(), "data", "project_state.json");
      if (fs.existsSync(stateFile)) {
        try {
          const stateData = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          if (stateData && (stateData.sourceVideo || Array.isArray(stateData.shots))) {
            const parentId = "parent_legacy_skin1004";
            const folderId = "folder_legacy_skin1004";
            const pName = stateData.sourceVideo?.name || "Dự án Skin1004 (Gốc)";
            data.parentProjects[parentId] = {
              id: parentId,
              name: pName,
              description: "Dự án tự động chuyển đổi từ dữ liệu cục bộ",
              ownerId: DEFAULT_USER_ID,
              createdAt: stateData.sourceVideo?.createdAt || now,
              updatedAt: now,
            };
            data.projects[folderId] = {
              id: folderId,
              parentProjectId: parentId,
              name: "Folder mặc định",
              description: "Thư mục video và cắt cảnh",
              settings: stateData.diversityConfig || {},
              createdAt: stateData.sourceVideo?.createdAt || now,
              updatedAt: now,
            };
            if (Array.isArray(stateData.shots) && stateData.shots.length > 0) {
              const poolObj: CategoryPools = {
                open: [],
                product: [],
                texture: [],
                apply: [],
                end: [],
              };
              for (const s of stateData.shots) {
                const cat = (s.category || "open") as ShotCategory;
                if (poolObj[cat]) {
                  poolObj[cat].push({
                    id: s.id,
                    name: s.label || s.id,
                    fileName: stateData.sourceVideo?.fileName || "video.mp4",
                    category: cat,
                    localUrl: stateData.sourceVideo?.localUrl || "",
                    localPath: stateData.sourceVideo?.localPath,
                    duration: (s.end || 0) - (s.begin || 0),
                    sourceType: "local",
                  });
                }
              }
              data.pools[folderId] = poolObj;
            }
            changed = true;
          }
        } catch {
          // ignore
        }
      }
    }

    if (changed) {
      fs.writeFileSync(LOCAL_FALLBACK_FILE, JSON.stringify(data, null, 2), "utf8");
    }

    return data;
  } catch {
    return {
      users: {
        [DEFAULT_USER_ID]: {
          id: DEFAULT_USER_ID,
          email: DEFAULT_USER_EMAIL,
          name: DEFAULT_USER_NAME,
          passwordHash: hashPassword(DEFAULT_USER_PASSWORD),
          createdAt: now,
          updatedAt: now,
        },
      },
      shares: {},
      parentProjects: {},
      projects: {},
      pools: {},
      voices: {},
      rendered: {},
    };
  }
}

function writeLocalStorage(data: LocalStorageSchema) {
  ensureLocalDataDir();
  fs.writeFileSync(LOCAL_FALLBACK_FILE, JSON.stringify(data, null, 2), "utf8");
}

let dbClient: Database | null = null;
let dbInitialized = false;
let dbInitPromise: Promise<void> | null = null;
let lastCloudError: string | null = null;

export function resetClient() {
  try {
    if (dbClient) {
      dbClient.close?.();
    }
  } catch {
    // ignore
  }
  dbClient = null;
  dbInitialized = false;
  dbInitPromise = null;
}

export function getDatabaseStatus(): {
  isCloud: boolean;
  connected: boolean;
  error?: string;
} {
  const isCloud = Boolean(process.env.SQLITE_CLOUD_URL?.trim());
  return {
    isCloud,
    connected: isCloud ? dbInitialized : true,
    error: isCloud && !dbInitialized ? lastCloudError || undefined : undefined,
  };
}

function getClient(): Database | null {
  const connectionUrl = process.env.SQLITE_CLOUD_URL?.trim();
  if (!connectionUrl) return null;
  if (!dbClient) {
    dbClient = new Database(connectionUrl);
  }
  return dbClient;
}

export async function initDatabase() {
  if (dbInitialized) return;
  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const client = getClient();
      if (!client) {
        // Using local storage fallback
        readLocalStorage();
        dbInitialized = true;
        return;
      }

      try {
        const now = new Date().toISOString();

        // 1. Users table
        await client.sql`
          CREATE TABLE IF NOT EXISTS lachvid_users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            password_hash TEXT,
            avatar_url TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `;

        // 2. OAuth accounts table (chuẩn bị mở rộng Google / Facebook)
        await client.sql`
          CREATE TABLE IF NOT EXISTS lachvid_oauth_accounts (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_account_id TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
        `;

        // 3. Resource shares table
        await client.sql`
          CREATE TABLE IF NOT EXISTS lachvid_resource_shares (
            id TEXT PRIMARY KEY,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            shared_with_email TEXT NOT NULL,
            shared_with_user_id TEXT,
            permissions TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `;

        // 4. Parent projects table
        await client.sql`
          CREATE TABLE IF NOT EXISTS lachvid_parent_projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            owner_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `;

        // 5. Folders table
        await client.sql`
          CREATE TABLE IF NOT EXISTS lachvid_projects (
            id TEXT PRIMARY KEY,
            parent_project_id TEXT,
            name TEXT NOT NULL,
            description TEXT,
            settings TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
        `;

        // Safely check and add columns to lachvid_parent_projects
        try {
          const parentCols = (await client.sql`PRAGMA table_info(lachvid_parent_projects);`) as Array<{ name?: string }>;
          const parentColNames = new Set(
            Array.isArray(parentCols)
              ? parentCols.map((c) => String(c.name || "").toLowerCase())
              : []
          );
          if (!parentColNames.has("owner_id")) {
            await client.sql`ALTER TABLE lachvid_parent_projects ADD COLUMN owner_id TEXT;`;
          }
        } catch {
          // ignore if pragma fails
        }

        // Safely check and add columns to lachvid_projects without triggering duplicate column errors
        try {
          const projectCols = (await client.sql`PRAGMA table_info(lachvid_projects);`) as Array<{ name?: string }>;
          const projectColNames = new Set(
            Array.isArray(projectCols)
              ? projectCols.map((c) => String(c.name || "").toLowerCase())
              : []
          );

          if (!projectColNames.has("settings")) {
            await client.sql`ALTER TABLE lachvid_projects ADD COLUMN settings TEXT;`;
          }
          if (!projectColNames.has("parent_project_id")) {
            await client.sql`ALTER TABLE lachvid_projects ADD COLUMN parent_project_id TEXT;`;
          }
        } catch {
          // ignore if pragma fails
        }

        // Tạo user mặc định skin1004@omnigen.local trong SQLite Cloud nếu chưa có
        try {
          const defaultPasswordHash = hashPassword(DEFAULT_USER_PASSWORD);
          await client.sql`
            INSERT OR IGNORE INTO lachvid_users (id, email, name, password_hash, created_at, updated_at)
            VALUES (${DEFAULT_USER_ID}, ${DEFAULT_USER_EMAIL}, ${DEFAULT_USER_NAME}, ${defaultPasswordHash}, ${now}, ${now});
          `;
        } catch (uErr) {
          console.warn("Default user create warning:", uErr);
        }

        // Auto-migrate legacy projects to parent projects in SQLite Cloud & assign owner_id
        try {
          const orphans = (await client.sql`
            SELECT id, name, description, created_at, updated_at
            FROM lachvid_projects
            WHERE parent_project_id IS NULL OR parent_project_id = '';
          `) as Array<{
            id: string;
            name: string;
            description?: string;
            created_at: string;
            updated_at: string;
          }>;

          if (orphans && orphans.length > 0) {
            for (const orphan of orphans) {
              const parentId = `parent_${orphan.id}`;
              await client.sql`
                INSERT OR IGNORE INTO lachvid_parent_projects (id, name, description, owner_id, created_at, updated_at)
                VALUES (${parentId}, ${orphan.name}, ${orphan.description || ""}, ${DEFAULT_USER_ID}, ${orphan.created_at}, ${orphan.updated_at});
              `;
              await client.sql`
                UPDATE lachvid_projects
                SET parent_project_id = ${parentId}
                WHERE id = ${orphan.id};
              `;
            }
          }

          // Migrate các parent projects cũ chưa có owner_id
          await client.sql`
            UPDATE lachvid_parent_projects
            SET owner_id = ${DEFAULT_USER_ID}
            WHERE owner_id IS NULL OR owner_id = '';
          `;
        } catch (migErr) {
          console.warn("Migration orphan projects error:", migErr);
        }

        await client.sql`
          CREATE TABLE IF NOT EXISTS lachvid_category_items (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            category TEXT NOT NULL,
            name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            local_url TEXT NOT NULL,
            local_path TEXT,
            duration REAL NOT NULL,
            size_bytes INTEGER,
            lock_flip_h INTEGER DEFAULT 0,
            drive_file_id TEXT,
            source_type TEXT NOT NULL,
            content_hash TEXT,
            created_at TEXT NOT NULL
          );
        `;

        // Safely check and add columns to lachvid_category_items
        try {
          const catCols = (await client.sql`PRAGMA table_info(lachvid_category_items);`) as Array<{ name?: string }>;
          const catColNames = new Set(
            Array.isArray(catCols)
              ? catCols.map((c) => String(c.name || "").toLowerCase())
              : []
          );

          if (!catColNames.has("content_hash")) {
            await client.sql`ALTER TABLE lachvid_category_items ADD COLUMN content_hash TEXT;`;
          }
        } catch {
          // ignore if pragma fails
        }

        await client.sql`
          CREATE TABLE IF NOT EXISTS lachvid_voice_items (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL,
            file_name TEXT NOT NULL,
            local_url TEXT NOT NULL,
            local_path TEXT,
            duration REAL NOT NULL,
            source_type TEXT NOT NULL,
            drive_file_id TEXT,
            drive_raw_url TEXT,
            created_at TEXT NOT NULL
          );
        `;

        await client.sql`
          CREATE TABLE IF NOT EXISTS lachvid_rendered_history (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            tuple_key TEXT NOT NULL,
            video_name TEXT,
            payload TEXT,
            rendered_at TEXT NOT NULL
          );
        `;

        // Safely check and add columns to lachvid_rendered_history
        try {
          const histCols = (await client.sql`PRAGMA table_info(lachvid_rendered_history);`) as Array<{ name?: string }>;
          const histColNames = new Set(
            Array.isArray(histCols)
              ? histCols.map((c) => String(c.name || "").toLowerCase())
              : []
          );

          if (!histColNames.has("payload")) {
            await client.sql`ALTER TABLE lachvid_rendered_history ADD COLUMN payload TEXT;`;
          }
          if (!histColNames.has("status")) {
            await client.sql`ALTER TABLE lachvid_rendered_history ADD COLUMN status TEXT DEFAULT 'unused';`;
          }
        } catch {
          // ignore if pragma fails
        }

        dbInitialized = true;
        lastCloudError = null;
      } catch (err: unknown) {
        dbInitialized = false;
        dbInitPromise = null;
        lastCloudError = err instanceof Error ? err.message : String(err);
        console.warn("Lỗi khi kết nối/khởi tạo SQLite Cloud, chuyển sang dùng local fallback:", err);
      }
    })();
  }
  return dbInitPromise;
}

// ==========================================
// User Operations
// ==========================================

export async function getUserById(id: string): Promise<User | null> {
  const query = async () => {
    await initDatabase();
    const client = getClient();
    if (!client || !dbInitialized) {
      const local = readLocalStorage();
      return local.users?.[id] || null;
    }
    const rows = (await client.sql`
      SELECT * FROM lachvid_users WHERE id = ${id} LIMIT 1;
    `) as Array<{
      id: string;
      email: string;
      name: string;
      password_hash?: string;
      avatar_url?: string;
      created_at: string;
      updated_at: string;
    }>;
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      passwordHash: r.password_hash || undefined,
      avatarUrl: r.avatar_url || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  };

  try {
    return await query();
  } catch (err) {
    console.warn("Lỗi getUserById lần 1, đang reset connection và thử lại:", err);
    resetClient();
    try {
      return await query();
    } catch (retryErr) {
      console.error("Lỗi getUserById sau retry:", retryErr);
      return null;
    }
  }
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const normalized = email.trim().toLowerCase();

  const query = async () => {
    await initDatabase();
    const client = getClient();
    if (!client || !dbInitialized) {
      const local = readLocalStorage();
      const user = Object.values(local.users || {}).find(
        (u) => u.email.toLowerCase() === normalized
      );
      return user || null;
    }
    const rows = (await client.sql`
      SELECT * FROM lachvid_users WHERE LOWER(email) = ${normalized} LIMIT 1;
    `) as Array<{
      id: string;
      email: string;
      name: string;
      password_hash?: string;
      avatar_url?: string;
      created_at: string;
      updated_at: string;
    }>;
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      passwordHash: r.password_hash || undefined,
      avatarUrl: r.avatar_url || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  };

  try {
    return await query();
  } catch (err) {
    console.warn("Lỗi getUserByEmail lần 1, đang reset connection và thử lại:", err);
    resetClient();
    try {
      return await query();
    } catch (retryErr) {
      console.error("Lỗi getUserByEmail sau retry:", retryErr);
      throw retryErr;
    }
  }
}

export async function listUsers(
  excludeUserId?: string
): Promise<UserSafeProfile[]> {
  await initDatabase();
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    return Object.values(local.users || {})
      .filter((u) => !excludeUserId || u.id !== excludeUserId)
      .map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatarUrl || undefined,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  try {
    const rows = (await client.sql`
      SELECT id, email, name, avatar_url, created_at, updated_at
      FROM lachvid_users
      WHERE (${excludeUserId || ""} = '' OR id != ${excludeUserId || ""})
      ORDER BY name ASC;
    `) as Array<{
      id: string;
      email: string;
      name: string;
      avatar_url?: string;
      created_at: string;
      updated_at: string;
    }>;

    return (rows || []).map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      avatarUrl: r.avatar_url || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    console.error("Lỗi listUsers:", err);
    return [];
  }
}

export async function createUser(data: {
  email: string;
  name: string;
  passwordHash?: string;
  avatarUrl?: string;
}): Promise<User> {
  await initDatabase();
  const id = `usr_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const now = new Date().toISOString();
  const newUser: User = {
    id,
    email: data.email.trim().toLowerCase(),
    name: data.name.trim(),
    passwordHash: data.passwordHash,
    avatarUrl: data.avatarUrl,
    createdAt: now,
    updatedAt: now,
  };

  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    local.users[id] = newUser;
    writeLocalStorage(local);
    await claimPendingSharesForUser(newUser.id, newUser.email);
    return newUser;
  }

  try {
    await client.sql`
      INSERT INTO lachvid_users (id, email, name, password_hash, avatar_url, created_at, updated_at)
      VALUES (${id}, ${newUser.email}, ${newUser.name}, ${
      newUser.passwordHash || null
    }, ${newUser.avatarUrl || null}, ${now}, ${now});
    `;
    await claimPendingSharesForUser(newUser.id, newUser.email);
    return newUser;
  } catch (err) {
    console.error("Lỗi createUser:", err);
    throw err;
  }
}

/**
 * Tự động liên kết các bản ghi chia sẻ đang chờ kích hoạt theo email khi user mới đăng ký
 */
export async function claimPendingSharesForUser(
  userId: string,
  email: string
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    let changed = false;
    for (const s of Object.values(local.shares || {})) {
      if (s.sharedWithEmail.toLowerCase() === normalized && !s.sharedWithUserId) {
        s.sharedWithUserId = userId;
        changed = true;
      }
    }
    if (changed) writeLocalStorage(local);
    return;
  }
  try {
    await client.sql`
      UPDATE lachvid_resource_shares
      SET shared_with_user_id = ${userId}
      WHERE LOWER(shared_with_email) = ${normalized} AND (shared_with_user_id IS NULL OR shared_with_user_id = '');
    `;
  } catch (err) {
    console.warn("Lỗi claimPendingSharesForUser:", err);
  }
}

// ==========================================
// Project Sharing Operations
// ==========================================

export async function getProjectShares(
  projectId: string
): Promise<Array<ResourceShare & { sharedUserName?: string }>> {
  await initDatabase();
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    const list = Object.values(local.shares || {}).filter(
      (s) => s.resourceType === "project" && s.resourceId === projectId
    );
    return list.map((s) => ({
      ...s,
      sharedUserName: s.sharedWithUserId
        ? local.users?.[s.sharedWithUserId]?.name
        : undefined,
    }));
  }
  try {
    const rows = (await client.sql`
      SELECT s.*, u.name as user_name
      FROM lachvid_resource_shares s
      LEFT JOIN lachvid_users u ON s.shared_with_user_id = u.id
      WHERE s.resource_type = 'project' AND s.resource_id = ${projectId}
      ORDER BY s.created_at DESC;
    `) as Array<{
      id: string;
      resource_type: "project" | "folder";
      resource_id: string;
      owner_id: string;
      shared_with_email: string;
      shared_with_user_id?: string;
      permissions: string;
      created_at: string;
      updated_at: string;
      user_name?: string;
    }>;

    return rows.map((r) => {
      let perms = DEFAULT_SHARE_PERMISSIONS;
      try {
        perms = JSON.parse(r.permissions);
      } catch {
        // fallback
      }
      return {
        id: r.id,
        resourceType: r.resource_type,
        resourceId: r.resource_id,
        ownerId: r.owner_id,
        sharedWithEmail: r.shared_with_email,
        sharedWithUserId: r.shared_with_user_id || undefined,
        permissions: perms,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        sharedUserName: r.user_name || undefined,
      };
    });
  } catch (err) {
    console.error("Lỗi getProjectShares:", err);
    return [];
  }
}

export async function shareProject(
  ownerId: string,
  projectId: string,
  sharedWithEmail: string,
  permissions: ProjectSharePermissions
): Promise<ResourceShare> {
  await initDatabase();
  const normalizedEmail = sharedWithEmail.trim().toLowerCase();
  const existingUser = await getUserByEmail(normalizedEmail);
  const now = new Date().toISOString();
  const permsStr = JSON.stringify(permissions);

  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    // Kiểm tra xem đã có share cho email này với project này chưa
    const existingShare = Object.values(local.shares || {}).find(
      (s) =>
        s.resourceType === "project" &&
        s.resourceId === projectId &&
        s.sharedWithEmail.toLowerCase() === normalizedEmail
    );

    if (existingShare) {
      existingShare.permissions = permissions;
      existingShare.sharedWithUserId = existingUser?.id || existingShare.sharedWithUserId;
      existingShare.updatedAt = now;
      writeLocalStorage(local);
      return existingShare;
    }

    const id = `shr_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const newShare: ResourceShare = {
      id,
      resourceType: "project",
      resourceId: projectId,
      ownerId,
      sharedWithEmail: normalizedEmail,
      sharedWithUserId: existingUser?.id || null,
      permissions,
      createdAt: now,
      updatedAt: now,
    };
    local.shares[id] = newShare;
    writeLocalStorage(local);
    return newShare;
  }

  try {
    const existingRows = (await client.sql`
      SELECT id FROM lachvid_resource_shares
      WHERE resource_type = 'project' AND resource_id = ${projectId} AND LOWER(shared_with_email) = ${normalizedEmail}
      LIMIT 1;
    `) as Array<{ id: string }>;

    if (existingRows && existingRows.length > 0) {
      const shareId = existingRows[0].id;
      await client.sql`
        UPDATE lachvid_resource_shares
        SET permissions = ${permsStr}, shared_with_user_id = ${
        existingUser?.id || null
      }, updated_at = ${now}
        WHERE id = ${shareId};
      `;
      return {
        id: shareId,
        resourceType: "project",
        resourceId: projectId,
        ownerId,
        sharedWithEmail: normalizedEmail,
        sharedWithUserId: existingUser?.id || null,
        permissions,
        createdAt: now,
        updatedAt: now,
      };
    }

    const id = `shr_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    await client.sql`
      INSERT INTO lachvid_resource_shares (id, resource_type, resource_id, owner_id, shared_with_email, shared_with_user_id, permissions, created_at, updated_at)
      VALUES (${id}, 'project', ${projectId}, ${ownerId}, ${normalizedEmail}, ${
      existingUser?.id || null
    }, ${permsStr}, ${now}, ${now});
    `;

    return {
      id,
      resourceType: "project",
      resourceId: projectId,
      ownerId,
      sharedWithEmail: normalizedEmail,
      sharedWithUserId: existingUser?.id || null,
      permissions,
      createdAt: now,
      updatedAt: now,
    };
  } catch (err) {
    console.error("Lỗi shareProject:", err);
    throw err;
  }
}

export async function removeShare(
  shareId: string,
  ownerId: string
): Promise<boolean> {
  await initDatabase();
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    const share = local.shares?.[shareId];
    if (!share) return false;
    // Kiểm tra owner
    const project = local.parentProjects?.[share.resourceId];
    if (share.ownerId !== ownerId && project?.ownerId !== ownerId) {
      return false;
    }
    delete local.shares[shareId];
    writeLocalStorage(local);
    return true;
  }

  try {
    await client.sql`
      DELETE FROM lachvid_resource_shares
      WHERE id = ${shareId} AND (owner_id = ${ownerId} OR resource_id IN (SELECT id FROM lachvid_parent_projects WHERE owner_id = ${ownerId}));
    `;
    return true;
  } catch (err) {
    console.error("Lỗi removeShare:", err);
    return false;
  }
}

// ==========================================
// Authorization Resolution Helpers
// ==========================================

export async function resolveProjectAccess(
  projectId: string,
  userId?: string,
  userEmail?: string
): Promise<ProjectAccessInfo> {
  await initDatabase();
  const project = await getParentProjectById(projectId);
  if (!project) {
    return {
      role: "none",
      isOwner: false,
      canManageFolders: false,
      permissions: {
        split: { enabled: false, actions: [] },
        mix: { enabled: false, actions: [] },
        history: { enabled: false, actions: [] },
      },
    };
  }

  const owner = project.ownerId ? await getUserById(project.ownerId) : null;
  const ownerInfo = owner
    ? { id: owner.id, email: owner.email, name: owner.name }
    : undefined;

  // Nếu user là chủ sở hữu
  if (userId && project.ownerId === userId) {
    return {
      role: "owner",
      isOwner: true,
      canManageFolders: true,
      permissions: {
        split: { enabled: true, actions: ["view", "export", "edit"] },
        mix: { enabled: true, actions: ["view", "export", "edit"] },
        history: { enabled: true, actions: ["view", "export", "edit"] },
      },
      owner: ownerInfo,
    };
  }

  // Kiểm tra quyền chia sẻ
  let share: ResourceShare | null = null;
  const client = getClient();

  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    share =
      Object.values(local.shares || {}).find(
        (s) =>
          s.resourceType === "project" &&
          s.resourceId === projectId &&
          ((userId && s.sharedWithUserId === userId) ||
            (userEmail &&
              s.sharedWithEmail.toLowerCase() === userEmail.toLowerCase()))
      ) || null;
  } else {
    try {
      const normalizedEmail = (userEmail || "").trim().toLowerCase();
      const rows = (await client.sql`
        SELECT * FROM lachvid_resource_shares
        WHERE resource_type = 'project' AND resource_id = ${projectId}
          AND ((${userId || ""} != '' AND shared_with_user_id = ${
        userId || ""
      }) OR (${normalizedEmail} != '' AND LOWER(shared_with_email) = ${normalizedEmail}))
        LIMIT 1;
      `) as Array<{ permissions: string }>;

      if (rows && rows.length > 0) {
        try {
          const perms = JSON.parse(rows[0].permissions);
          share = {
            id: "",
            resourceType: "project",
            resourceId: projectId,
            ownerId: project.ownerId || "",
            sharedWithEmail: normalizedEmail,
            permissions: perms,
            createdAt: "",
            updatedAt: "",
          };
        } catch {
          // ignore
        }
      }
    } catch (err) {
      console.warn("Lỗi kiểm tra quyền share:", err);
    }
  }

  if (share) {
    const perms = share.permissions;
    // canManageFolders: true nếu có ít nhất 1 module có action "edit"
    const canManageFolders =
      Boolean(perms.split?.enabled && perms.split?.actions?.includes("edit")) ||
      Boolean(perms.mix?.enabled && perms.mix?.actions?.includes("edit")) ||
      Boolean(perms.history?.enabled && perms.history?.actions?.includes("edit"));

    return {
      role: "shared",
      isOwner: false,
      canManageFolders,
      permissions: perms,
      owner: ownerInfo,
    };
  }

  return {
    role: "none",
    isOwner: false,
    canManageFolders: false,
    permissions: {
      split: { enabled: false, actions: [] },
      mix: { enabled: false, actions: [] },
      history: { enabled: false, actions: [] },
    },
    owner: ownerInfo,
  };
}

export async function resolveFolderAccess(
  folderId: string,
  userId?: string,
  userEmail?: string
): Promise<ProjectAccessInfo & { folder: ProjectMeta | null }> {
  await initDatabase();
  const folder = await getProjectById(folderId);
  if (!folder || !folder.parentProjectId) {
    return {
      role: "none",
      isOwner: false,
      canManageFolders: false,
      permissions: {
        split: { enabled: false, actions: [] },
        mix: { enabled: false, actions: [] },
        history: { enabled: false, actions: [] },
      },
      folder: folder || null,
    };
  }

  const access = await resolveProjectAccess(
    folder.parentProjectId,
    userId,
    userEmail
  );
  return {
    ...access,
    folder,
  };
}

export async function getParentProjects(
  currentUserId?: string,
  currentUserEmail?: string
): Promise<ParentProjectMeta[]> {
  await initDatabase();
  const client = getClient();
  const normalizedEmail = (currentUserEmail || "").trim().toLowerCase();

  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    let list = Object.values(local.parentProjects || {});

    // Nếu có user hiện tại, lọc các project thuộc về user hoặc được share cho user
    if (currentUserId || normalizedEmail) {
      const myIds = new Set(
        list
          .filter((p) => p.ownerId && p.ownerId === currentUserId)
          .map((p) => p.id)
      );

      const sharedMap = new Map<string, ProjectSharePermissions>();
      for (const s of Object.values(local.shares || {})) {
        if (
          s.resourceType === "project" &&
          ((currentUserId && s.sharedWithUserId === currentUserId) ||
            (normalizedEmail &&
              s.sharedWithEmail.toLowerCase() === normalizedEmail))
        ) {
          sharedMap.set(s.resourceId, s.permissions);
        }
      }

      list = list.filter((p) => myIds.has(p.id) || sharedMap.has(p.id));
    }

    return list
      .map((parent) => {
        const childFolders = Object.values(local.projects).filter(
          (p) => p.parentProjectId === parent.id
        );
        let totalClips = 0;
        let totalRendered = 0;
        let totalVoices = 0;
        for (const f of childFolders) {
          const pool = local.pools[f.id] || {
            open: [],
            product: [],
            texture: [],
            apply: [],
            end: [],
          };
          const clipCount =
            pool.open.length +
            pool.product.length +
            pool.texture.length +
            pool.apply.length +
            pool.end.length;
          totalClips += clipCount;
          totalRendered += (local.rendered[f.id] || []).length;
          totalVoices += (local.voices?.[f.id] || []).length;
        }

        const isOwner = Boolean(
          currentUserId && parent.ownerId === currentUserId
        );
        let sharePermissions: ProjectSharePermissions | undefined;
        if (!isOwner && (currentUserId || normalizedEmail)) {
          const s = Object.values(local.shares || {}).find(
            (sh) =>
              sh.resourceType === "project" &&
              sh.resourceId === parent.id &&
              ((currentUserId && sh.sharedWithUserId === currentUserId) ||
                (normalizedEmail &&
                  sh.sharedWithEmail.toLowerCase() === normalizedEmail))
          );
          if (s) sharePermissions = s.permissions;
        }

        const ownerUser = parent.ownerId
          ? local.users?.[parent.ownerId]
          : undefined;

        return {
          ...parent,
          foldersCount: childFolders.length,
          poolCount: totalClips,
          renderedCount: totalRendered,
          voiceCount: totalVoices,
          isOwner,
          sharePermissions,
          ownerName: ownerUser?.name,
          ownerEmail: ownerUser?.email,
        };
      })
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
  }

  try {
    let rows: Array<{
      id: string;
      name: string;
      description?: string;
      owner_id?: string;
      created_at: string;
      updated_at: string;
      folders_count: number;
      pool_count: number;
      rendered_count: number;
      voice_count: number;
      owner_name?: string;
      owner_email?: string;
      share_permissions?: string;
    }>;

    if (currentUserId || normalizedEmail) {
      rows = (await client.sql`
        SELECT p.*,
          u.name as owner_name,
          u.email as owner_email,
          s.permissions as share_permissions,
          (SELECT COUNT(*) FROM lachvid_projects f WHERE f.parent_project_id = p.id) as folders_count,
          (SELECT COUNT(*) FROM lachvid_category_items c WHERE c.project_id IN (SELECT id FROM lachvid_projects WHERE parent_project_id = p.id)) as pool_count,
          (SELECT COUNT(*) FROM lachvid_rendered_history r WHERE r.project_id IN (SELECT id FROM lachvid_projects WHERE parent_project_id = p.id)) as rendered_count,
          (SELECT COUNT(*) FROM lachvid_voice_items v WHERE v.project_id IN (SELECT id FROM lachvid_projects WHERE parent_project_id = p.id)) as voice_count
        FROM lachvid_parent_projects p
        LEFT JOIN lachvid_users u ON p.owner_id = u.id
        LEFT JOIN lachvid_resource_shares s ON (
          s.resource_type = 'project' AND s.resource_id = p.id AND (
            (${currentUserId || ""} != '' AND s.shared_with_user_id = ${
        currentUserId || ""
      }) OR (${normalizedEmail} != '' AND LOWER(s.shared_with_email) = ${normalizedEmail})
          )
        )
        WHERE (p.owner_id = ${currentUserId || ""} OR (${currentUserId || ""} = ${DEFAULT_USER_ID} AND (p.owner_id IS NULL OR p.owner_id = '')) OR s.id IS NOT NULL)
        ORDER BY p.updated_at DESC;
      `) as typeof rows;
    } else {
      rows = (await client.sql`
        SELECT p.*,
          u.name as owner_name,
          u.email as owner_email,
          NULL as share_permissions,
          (SELECT COUNT(*) FROM lachvid_projects f WHERE f.parent_project_id = p.id) as folders_count,
          (SELECT COUNT(*) FROM lachvid_category_items c WHERE c.project_id IN (SELECT id FROM lachvid_projects WHERE parent_project_id = p.id)) as pool_count,
          (SELECT COUNT(*) FROM lachvid_rendered_history r WHERE r.project_id IN (SELECT id FROM lachvid_projects WHERE parent_project_id = p.id)) as rendered_count,
          (SELECT COUNT(*) FROM lachvid_voice_items v WHERE v.project_id IN (SELECT id FROM lachvid_projects WHERE parent_project_id = p.id)) as voice_count
        FROM lachvid_parent_projects p
        LEFT JOIN lachvid_users u ON p.owner_id = u.id
        ORDER BY p.updated_at DESC;
      `) as typeof rows;
    }

    return rows.map((r) => {
      const isOwner = Boolean(
        currentUserId &&
          (r.owner_id === currentUserId ||
            (currentUserId === DEFAULT_USER_ID && (!r.owner_id || r.owner_id === "")))
      );
      let sharePermissions: ProjectSharePermissions | undefined;
      if (r.share_permissions) {
        try {
          sharePermissions = JSON.parse(r.share_permissions);
        } catch {
          // ignore
        }
      }

      return {
        id: r.id,
        name: r.name,
        description: r.description || undefined,
        ownerId: r.owner_id || undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        foldersCount: Number(r.folders_count || 0),
        poolCount: Number(r.pool_count || 0),
        renderedCount: Number(r.rendered_count || 0),
        voiceCount: Number(r.voice_count || 0),
        isOwner,
        sharePermissions,
        ownerName: r.owner_name || undefined,
        ownerEmail: r.owner_email || undefined,
      };
    });
  } catch (err) {
    console.error("Lỗi getParentProjects:", err);
    return [];
  }
}

export async function getParentProjectById(
  id: string
): Promise<ParentProjectMeta | null> {
  await initDatabase();
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    const p = local.parentProjects?.[id] || null;
    if (!p) return null;
    const owner = p.ownerId ? local.users?.[p.ownerId] : undefined;
    return {
      ...p,
      ownerName: owner?.name,
      ownerEmail: owner?.email,
    };
  }
  try {
    const rows = (await client.sql`
      SELECT p.*, u.name as owner_name, u.email as owner_email
      FROM lachvid_parent_projects p
      LEFT JOIN lachvid_users u ON p.owner_id = u.id
      WHERE p.id = ${id} LIMIT 1;
    `) as Array<{
      id: string;
      name: string;
      description?: string;
      owner_id?: string;
      created_at: string;
      updated_at: string;
      owner_name?: string;
      owner_email?: string;
    }>;
    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      description: r.description || undefined,
      ownerId: r.owner_id || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      ownerName: r.owner_name || undefined,
      ownerEmail: r.owner_email || undefined,
    };
  } catch (err) {
    console.error("Lỗi getParentProjectById:", err);
    return null;
  }
}

export async function createParentProject(
  name: string,
  description = "",
  ownerId?: string
): Promise<ParentProjectMeta> {
  await initDatabase();
  const id = `parent_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const now = new Date().toISOString();
  const meta: ParentProjectMeta = {
    id,
    name: name.trim(),
    description: description.trim(),
    ownerId,
    createdAt: now,
    updatedAt: now,
    foldersCount: 0,
    poolCount: 0,
    renderedCount: 0,
  };
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    local.parentProjects[id] = meta;
    writeLocalStorage(local);
    return meta;
  }
  try {
    await client.sql`
      INSERT INTO lachvid_parent_projects (id, name, description, owner_id, created_at, updated_at)
      VALUES (${id}, ${meta.name}, ${meta.description || ""}, ${
      ownerId || null
    }, ${now}, ${now});
    `;
    return meta;
  } catch (err) {
    console.error("Lỗi createParentProject:", err);
    throw err;
  }
}

export async function updateParentProject(
  id: string,
  data: { name?: string; description?: string }
): Promise<boolean> {
  await initDatabase();
  const now = new Date().toISOString();
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    if (local.parentProjects?.[id]) {
      if (typeof data.name === "string" && data.name.trim()) {
        local.parentProjects[id].name = data.name.trim();
      }
      if (typeof data.description === "string") {
        local.parentProjects[id].description = data.description.trim();
      }
      local.parentProjects[id].updatedAt = now;
      writeLocalStorage(local);
      return true;
    }
    return false;
  }
  try {
    const existing = await getParentProjectById(id);
    if (!existing) return false;
    const name =
      typeof data.name === "string" && data.name.trim()
        ? data.name.trim()
        : existing.name;
    const desc =
      typeof data.description === "string"
        ? data.description.trim()
        : existing.description || "";
    await client.sql`
      UPDATE lachvid_parent_projects
      SET name = ${name}, description = ${desc}, updated_at = ${now}
      WHERE id = ${id};
    `;
    return true;
  } catch (err) {
    console.error("Lỗi updateParentProject:", err);
    return false;
  }
}

export async function deleteParentProject(id: string): Promise<boolean> {
  await initDatabase();
  const folders = await getFoldersByParentId(id);
  for (const f of folders) {
    await deleteProject(f.id);
  }
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    delete local.parentProjects[id];
    writeLocalStorage(local);
    return true;
  }
  try {
    await client.sql`DELETE FROM lachvid_parent_projects WHERE id = ${id};`;
    return true;
  } catch (err) {
    console.error("Lỗi deleteParentProject:", err);
    return false;
  }
}

export async function getFoldersByParentId(
  parentProjectId: string
): Promise<ProjectMeta[]> {
  await initDatabase();
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    const list = Object.values(local.projects).filter(
      (p) => p.parentProjectId === parentProjectId
    );
    return list
      .map((p) => {
        const rendered = local.rendered[p.id] || [];
        const pool = local.pools[p.id] || {
          open: [],
          product: [],
          texture: [],
          apply: [],
          end: [],
        };
        const voices = local.voices?.[p.id] || [];
        const poolCount =
          pool.open.length +
          pool.product.length +
          pool.texture.length +
          pool.apply.length +
          pool.end.length;
        return {
          ...p,
          renderedCount: rendered.length,
          poolCount,
          voiceCount: voices.length,
        };
      })
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      );
  }
  try {
    const rows = (await client.sql`
      SELECT p.*,
        (SELECT COUNT(*) FROM lachvid_rendered_history r WHERE r.project_id = p.id) as rendered_count,
        (SELECT COUNT(*) FROM lachvid_category_items c WHERE c.project_id = p.id) as pool_count,
        (SELECT COUNT(*) FROM lachvid_voice_items v WHERE v.project_id = p.id) as voice_count
      FROM lachvid_projects p
      WHERE p.parent_project_id = ${parentProjectId}
      ORDER BY p.updated_at DESC;
    `) as Array<{
      id: string;
      name: string;
      description?: string;
      parent_project_id?: string;
      created_at: string;
      updated_at: string;
      rendered_count: number;
      pool_count: number;
      voice_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      parentProjectId: r.parent_project_id || undefined,
      name: r.name,
      description: r.description || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      renderedCount: Number(r.rendered_count || 0),
      poolCount: Number(r.pool_count || 0),
      voiceCount: Number(r.voice_count || 0),
    }));
  } catch (err) {
    console.error("Lỗi getFoldersByParentId:", err);
    return [];
  }
}

export async function createFolder(
  parentProjectId: string,
  name: string,
  description = ""
): Promise<ProjectMeta> {
  await initDatabase();
  const id = `fld_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    id,
    parentProjectId,
    name: name.trim(),
    description: description.trim(),
    createdAt: now,
    updatedAt: now,
    renderedCount: 0,
    poolCount: 0,
  };
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    local.projects[id] = meta;
    local.pools[id] = { open: [], product: [], texture: [], apply: [], end: [] };
    local.voices[id] = [];
    local.rendered[id] = [];
    if (local.parentProjects?.[parentProjectId]) {
      local.parentProjects[parentProjectId].updatedAt = now;
    }
    writeLocalStorage(local);
    return meta;
  }
  try {
    await client.sql`
      INSERT INTO lachvid_projects (id, parent_project_id, name, description, created_at, updated_at)
      VALUES (${id}, ${parentProjectId}, ${meta.name}, ${
      meta.description || ""
    }, ${now}, ${now});
    `;
    await client.sql`
      UPDATE lachvid_parent_projects SET updated_at = ${now} WHERE id = ${parentProjectId};
    `;
    return meta;
  } catch (err) {
    console.error("Lỗi createFolder:", err);
    throw err;
  }
}

export async function getProjects(): Promise<ProjectMeta[]> {
  await initDatabase();
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    const list = Object.values(local.projects);
    return list.map((p) => {
      const rendered = local.rendered[p.id] || [];
      const pool = local.pools[p.id] || { open: [], product: [], texture: [], apply: [], end: [] };
      const voices = local.voices?.[p.id] || [];
      const poolCount =
        pool.open.length + pool.product.length + pool.texture.length + pool.apply.length + pool.end.length;
      return {
        ...p,
        renderedCount: rendered.length,
        poolCount,
        voiceCount: voices.length,
      };
    }).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  try {
    const rows = (await client.sql`
      SELECT p.*,
        (SELECT COUNT(*) FROM lachvid_rendered_history r WHERE r.project_id = p.id) as rendered_count,
        (SELECT COUNT(*) FROM lachvid_category_items c WHERE c.project_id = p.id) as pool_count,
        (SELECT COUNT(*) FROM lachvid_voice_items v WHERE v.project_id = p.id) as voice_count
      FROM lachvid_projects p
      ORDER BY p.updated_at DESC;
    `) as Array<{
      id: string;
      name: string;
      description?: string;
      created_at: string;
      updated_at: string;
      rendered_count: number;
      pool_count: number;
      voice_count: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      renderedCount: Number(r.rendered_count || 0),
      poolCount: Number(r.pool_count || 0),
      voiceCount: Number(r.voice_count || 0),
    }));
  } catch (err) {
    console.error("Lỗi khi lấy danh sách project từ SQLite Cloud:", err);
    return [];
  }
}

export async function getProjectById(id: string): Promise<ProjectMeta | null> {
  await initDatabase();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    const p = local.projects[id];
    if (!p) return null;
    const parent = p.parentProjectId ? local.parentProjects?.[p.parentProjectId] : undefined;
    return {
      ...p,
      parentProjectName: parent?.name,
    };
  }

  try {
    const rows = (await client.sql`
      SELECT p.*, pp.name as parent_project_name
      FROM lachvid_projects p
      LEFT JOIN lachvid_parent_projects pp ON p.parent_project_id = pp.id
      WHERE p.id = ${id} LIMIT 1;
    `) as Array<{
      id: string;
      parent_project_id?: string;
      parent_project_name?: string;
      name: string;
      description?: string;
      settings?: string;
      created_at: string;
      updated_at: string;
    }>;

    if (!rows || rows.length === 0) return null;
    const r = rows[0];
    let parsedSettings: Record<string, unknown> | undefined;
    if (r.settings) {
      try {
        parsedSettings = JSON.parse(r.settings);
      } catch {
        // ignore
      }
    }

    return {
      id: r.id,
      parentProjectId: r.parent_project_id || undefined,
      parentProjectName: r.parent_project_name || undefined,
      name: r.name,
      description: r.description || undefined,
      settings: parsedSettings,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  } catch (err) {
    console.error("Lỗi getProjectById:", err);
    return null;
  }
}

export async function updateProjectSettings(
  id: string,
  settings: Record<string, unknown>
): Promise<boolean> {
  await initDatabase();
  const now = new Date().toISOString();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    if (local.projects[id]) {
      local.projects[id].settings = settings;
      local.projects[id].updatedAt = now;
      writeLocalStorage(local);
    }
    return true;
  }

  try {
    const settingsStr = JSON.stringify(settings);
    await client.sql`
      UPDATE lachvid_projects
      SET settings = ${settingsStr}, updated_at = ${now}
      WHERE id = ${id};
    `;
    return true;
  } catch (err) {
    console.error("Lỗi updateProjectSettings:", err);
    return false;
  }
}

export async function updateProject(
  id: string,
  data: { name?: string; description?: string }
): Promise<boolean> {
  await initDatabase();
  const now = new Date().toISOString();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    if (local.projects[id]) {
      if (typeof data.name === "string" && data.name.trim()) {
        local.projects[id].name = data.name.trim();
      }
      if (typeof data.description === "string") {
        local.projects[id].description = data.description.trim();
      }
      local.projects[id].updatedAt = now;
      writeLocalStorage(local);
      return true;
    }
    return false;
  }

  try {
    const existing = await getProjectById(id);
    if (!existing) return false;
    const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : existing.name;
    const desc = typeof data.description === "string" ? data.description.trim() : (existing.description || "");
    await client.sql`
      UPDATE lachvid_projects
      SET name = ${name}, description = ${desc}, updated_at = ${now}
      WHERE id = ${id};
    `;
    return true;
  } catch (err) {
    console.error("Lỗi updateProject:", err);
    return false;
  }
}

export async function createProject(
  name: string,
  description = "",
  parentProjectId?: string
): Promise<ProjectMeta> {
  await initDatabase();
  const id = `prj_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 6)}`;
  const now = new Date().toISOString();

  let effectiveParentId = parentProjectId;
  if (!effectiveParentId) {
    const parent = await createParentProject(name, description);
    effectiveParentId = parent.id;
  }

  const meta: ProjectMeta = {
    id,
    parentProjectId: effectiveParentId,
    name: name.trim(),
    description: description.trim(),
    createdAt: now,
    updatedAt: now,
    renderedCount: 0,
    poolCount: 0,
  };

  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    local.projects[id] = meta;
    local.pools[id] = { open: [], product: [], texture: [], apply: [], end: [] };
    local.voices[id] = [];
    local.rendered[id] = [];
    if (local.parentProjects?.[effectiveParentId]) {
      local.parentProjects[effectiveParentId].updatedAt = now;
    }
    writeLocalStorage(local);
    return meta;
  }

  try {
    await client.sql`
      INSERT INTO lachvid_projects (id, parent_project_id, name, description, created_at, updated_at)
      VALUES (${id}, ${effectiveParentId}, ${meta.name}, ${meta.description || ""}, ${now}, ${now});
    `;
    await client.sql`
      UPDATE lachvid_parent_projects SET updated_at = ${now} WHERE id = ${effectiveParentId};
    `;
    return meta;
  } catch (err) {
    console.error("Lỗi createProject trên SQLite Cloud:", err);
    throw err;
  }
}

export async function deleteProject(id: string): Promise<boolean> {
  await initDatabase();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    delete local.projects[id];
    delete local.pools[id];
    delete local.voices[id];
    delete local.rendered[id];
    writeLocalStorage(local);
  } else {
    try {
      await client.sql`DELETE FROM lachvid_rendered_history WHERE project_id = ${id};`;
      await client.sql`DELETE FROM lachvid_category_items WHERE project_id = ${id};`;
      await client.sql`DELETE FROM lachvid_voice_items WHERE project_id = ${id};`;
      await client.sql`DELETE FROM lachvid_projects WHERE id = ${id};`;
    } catch (err) {
      console.error("Lỗi deleteProject trên SQLite Cloud:", err);
      return false;
    }
  }

  // Dọn dẹp cả thư mục session file tạm nếu có lưu theo projectId
  try {
    const sessionDir = path.join(path.join(require("node:os").tmpdir(), "lachvid_sessions"), id);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }

  return true;
}

export async function getProjectCategoryPools(projectId: string): Promise<CategoryPools> {
  await initDatabase();
  const empty: CategoryPools = { open: [], product: [], texture: [], apply: [], end: [] };
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    return local.pools[projectId] || empty;
  }

  try {
    const rows = (await client.sql`
      SELECT * FROM lachvid_category_items
      WHERE project_id = ${projectId}
      ORDER BY created_at ASC;
    `) as Array<{
      id: string;
      project_id: string;
      category: ShotCategory;
      name: string;
      file_name: string;
      local_url: string;
      local_path?: string;
      duration: number;
      size_bytes?: number;
      lock_flip_h: number;
      drive_file_id?: string;
      source_type: "drive" | "local";
      content_hash?: string;
    }>;

    const result: CategoryPools = { open: [], product: [], texture: [], apply: [], end: [] };
    for (const r of rows) {
      if (result[r.category]) {
        result[r.category].push({
          id: r.id,
          name: r.name,
          fileName: r.file_name,
          category: r.category,
          localUrl: r.local_url,
          localPath: r.local_path || undefined,
          duration: Number(r.duration || 4.0),
          sizeBytes: r.size_bytes ? Number(r.size_bytes) : undefined,
          lockFlipH: Boolean(r.lock_flip_h),
          driveFileId: r.drive_file_id || undefined,
          sourceType: r.source_type,
          contentHash: r.content_hash || undefined,
        });
      }
    }
    return result;
  } catch (err) {
    console.error("Lỗi getProjectCategoryPools:", err);
    return empty;
  }
}

export async function saveProjectCategoryPools(projectId: string, pools: CategoryPools) {
  await initDatabase();
  const now = new Date().toISOString();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    local.pools[projectId] = pools;
    if (local.projects[projectId]) {
      local.projects[projectId].updatedAt = now;
    }
    writeLocalStorage(local);
    return;
  }

  try {
    // Replace category items for this project
    await client.sql`DELETE FROM lachvid_category_items WHERE project_id = ${projectId};`;

    const cats: ShotCategory[] = ["open", "product", "texture", "apply", "end"];
    for (const cat of cats) {
      const items = pools[cat] || [];
      for (const it of items) {
        await client.sql`
          INSERT INTO lachvid_category_items (
            id, project_id, category, name, file_name, local_url, local_path,
            duration, size_bytes, lock_flip_h, drive_file_id, source_type, content_hash, created_at
          ) VALUES (
            ${it.id}, ${projectId}, ${cat}, ${it.name}, ${it.fileName}, ${it.localUrl},
            ${it.localPath || null}, ${it.duration}, ${it.sizeBytes || null},
            ${it.lockFlipH ? 1 : 0}, ${it.driveFileId || null}, ${it.sourceType || "drive"},
            ${it.contentHash || null}, ${now}
          );
        `;
      }
    }

    await client.sql`
      UPDATE lachvid_projects SET updated_at = ${now} WHERE id = ${projectId};
    `;
  } catch (err) {
    console.error("Lỗi saveProjectCategoryPools:", err);
  }
}

export async function getProjectVoiceTracks(projectId: string): Promise<MultiVoiceItem[]> {
  await initDatabase();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    return local.voices?.[projectId] || [];
  }

  try {
    const rows = (await client.sql`
      SELECT * FROM lachvid_voice_items
      WHERE project_id = ${projectId}
      ORDER BY created_at ASC;
    `) as Array<{
      id: string;
      project_id: string;
      name: string;
      file_name: string;
      local_url: string;
      local_path?: string;
      duration: number;
      source_type: "drive" | "local";
      drive_file_id?: string;
      drive_raw_url?: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      fileName: r.file_name,
      localUrl: r.local_url,
      localPath: r.local_path || undefined,
      duration: Number(r.duration || 20.0),
      sourceType: r.source_type,
      driveFileId: r.drive_file_id || undefined,
      driveRawUrl: r.drive_raw_url || undefined,
    }));
  } catch (err) {
    console.error("Lỗi getProjectVoiceTracks:", err);
    return [];
  }
}

export async function saveProjectVoiceTracks(projectId: string, voices: MultiVoiceItem[]) {
  await initDatabase();
  const now = new Date().toISOString();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    if (!local.voices) local.voices = {};
    local.voices[projectId] = voices;
    if (local.projects[projectId]) {
      local.projects[projectId].updatedAt = now;
    }
    writeLocalStorage(local);
    return;
  }

  try {
    await client.sql`DELETE FROM lachvid_voice_items WHERE project_id = ${projectId};`;

    for (const v of voices) {
      await client.sql`
        INSERT INTO lachvid_voice_items (
          id, project_id, name, file_name, local_url, local_path,
          duration, source_type, drive_file_id, drive_raw_url, created_at
        ) VALUES (
          ${v.id}, ${projectId}, ${v.name}, ${v.fileName}, ${v.localUrl},
          ${v.localPath || null}, ${v.duration}, ${v.sourceType || "drive"},
          ${v.driveFileId || null}, ${v.driveRawUrl || null}, ${now}
        );
      `;
    }

    await client.sql`
      UPDATE lachvid_projects SET updated_at = ${now} WHERE id = ${projectId};
    `;
  } catch (err) {
    console.error("Lỗi saveProjectVoiceTracks:", err);
  }
}

export async function getRenderedHistory(projectId: string): Promise<RenderedVideoRecord[]> {
  await initDatabase();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    return (local.rendered[projectId] || []).map((r) => ({
      ...r,
      status: (r.status === "used" ? "used" : "unused") as "unused" | "used",
    }));
  }

  try {
    const rows = (await client.sql`
      SELECT * FROM lachvid_rendered_history
      WHERE project_id = ${projectId}
      ORDER BY rendered_at DESC;
    `) as Array<{
      id: string;
      project_id: string;
      tuple_key: string;
      video_name?: string;
      payload?: string;
      status?: string;
      rendered_at: string;
    }>;

    return rows.map((r) => {
      let parsedPayload: Record<string, unknown> | undefined;
      if (r.payload) {
        try {
          parsedPayload = JSON.parse(r.payload);
        } catch {
          // ignore
        }
      }
      return {
        id: r.id,
        projectId: r.project_id,
        tupleKey: r.tuple_key,
        name: r.video_name || undefined,
        payload: parsedPayload,
        status: (r.status === "used" ? "used" : "unused") as "unused" | "used",
        renderedAt: r.rendered_at,
      };
    });
  } catch (err) {
    console.error("Lỗi getRenderedHistory:", err);
    return [];
  }
}

export async function recordRenderedVideos(
  projectId: string,
  records: Array<{ tupleKey: string; name?: string; payload?: unknown; status?: "unused" | "used" }>
) {
  if (!records || records.length === 0) return;
  await initDatabase();
  const now = new Date().toISOString();

  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    if (!local.rendered[projectId]) local.rendered[projectId] = [];
    for (const rec of records) {
      local.rendered[projectId].push({
        id: `rend_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        projectId,
        tupleKey: rec.tupleKey,
        name: rec.name,
        payload: rec.payload as Record<string, unknown> | undefined,
        status: rec.status || "unused",
        renderedAt: now,
      });
    }
    if (local.projects[projectId]) {
      local.projects[projectId].updatedAt = now;
    }
    writeLocalStorage(local);
    return;
  }

  try {
    for (const rec of records) {
      const id = `rend_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const payloadStr = rec.payload ? JSON.stringify(rec.payload) : null;
      const statusVal = rec.status === "used" ? "used" : "unused";
      await client.sql`
        INSERT INTO lachvid_rendered_history (id, project_id, tuple_key, video_name, payload, status, rendered_at)
        VALUES (${id}, ${projectId}, ${rec.tupleKey}, ${rec.name || null}, ${payloadStr}, ${statusVal}, ${now});
      `;
    }

    await client.sql`
      UPDATE lachvid_projects SET updated_at = ${now} WHERE id = ${projectId};
    `;
  } catch (err) {
    console.error("Lỗi recordRenderedVideos:", err);
  }
}

export async function clearProjectRenderedHistory(projectId: string) {
  await initDatabase();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    local.rendered[projectId] = [];
    writeLocalStorage(local);
    return;
  }

  try {
    await client.sql`
      DELETE FROM lachvid_rendered_history WHERE project_id = ${projectId};
    `;
  } catch (err) {
    console.error("Lỗi clearProjectRenderedHistory:", err);
  }
}

export async function getRenderedHistoryItemById(id: string): Promise<{ id: string; projectId: string; status: "unused" | "used" } | null> {
  await initDatabase();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    for (const [pId, items] of Object.entries(local.rendered || {})) {
      const found = items?.find((r) => r.id === id);
      if (found) {
        return { id: found.id, projectId: pId, status: found.status === "used" ? "used" : "unused" };
      }
    }
    return null;
  }

  try {
    const rows = (await client.sql`
      SELECT id, project_id, status FROM lachvid_rendered_history WHERE id = ${id} LIMIT 1;
    `) as Array<{ id: string; project_id: string; status?: string }>;
    if (!rows || rows.length === 0) return null;
    return {
      id: rows[0].id,
      projectId: rows[0].project_id,
      status: rows[0].status === "used" ? "used" : "unused",
    };
  } catch (err) {
    console.error("Lỗi getRenderedHistoryItemById:", err);
    return null;
  }
}

export async function deleteRenderedHistoryItem(id: string) {
  await initDatabase();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    for (const pId of Object.keys(local.rendered)) {
      local.rendered[pId] = local.rendered[pId].filter((r) => r.id !== id);
    }
    writeLocalStorage(local);
    return;
  }

  try {
    await client.sql`
      DELETE FROM lachvid_rendered_history WHERE id = ${id};
    `;
  } catch (err) {
    console.error("Lỗi deleteRenderedHistoryItem:", err);
  }
}

export async function updateRenderedHistoryStatus(id: string, status: "unused" | "used") {
  await initDatabase();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    for (const pId of Object.keys(local.rendered)) {
      const found = local.rendered[pId]?.find((r) => r.id === id);
      if (found) {
        found.status = status;
      }
    }
    writeLocalStorage(local);
    return;
  }

  try {
    await client.sql`
      UPDATE lachvid_rendered_history SET status = ${status} WHERE id = ${id};
    `;
  } catch (err) {
    console.error("Lỗi updateRenderedHistoryStatus:", err);
  }
}


