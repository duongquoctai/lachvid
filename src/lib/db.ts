import { Database } from "@sqlitecloud/drivers";
import fs from "node:fs";
import path from "node:path";
import {
  CategoryPools,
  CategoryVideoItem,
  MultiVoiceItem,
  RenderedVideoRecord,
  ShotCategory,
} from "@/types/lachvid";

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
  parentProjects: Record<string, ParentProjectMeta>;
  projects: Record<string, ProjectMeta>;
  pools: Record<string, CategoryPools>;
  voices: Record<string, MultiVoiceItem[]>; // projectId -> voices
  rendered: Record<string, RenderedVideoRecord[]>; // projectId -> records
}

function readLocalStorage(): LocalStorageSchema {
  ensureLocalDataDir();
  if (!fs.existsSync(LOCAL_FALLBACK_FILE)) {
    const init: LocalStorageSchema = {
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
    if (!data.parentProjects) data.parentProjects = {};
    if (!data.voices) data.voices = {};
    if (!data.rendered) data.rendered = {};
    if (!data.pools) data.pools = {};
    if (!data.projects) data.projects = {};

    // Auto-migrate legacy projects to each have a matching parent project
    let changed = false;
    for (const p of Object.values(data.projects as Record<string, ProjectMeta>)) {
      if (!p.parentProjectId) {
        const parentId = `parent_${p.id}`;
        if (!data.parentProjects[parentId]) {
          data.parentProjects[parentId] = {
            id: parentId,
            name: p.name,
            description: p.description || "",
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
          };
        }
        p.parentProjectId = parentId;
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(LOCAL_FALLBACK_FILE, JSON.stringify(data, null, 2), "utf8");
    }

    return data;
  } catch {
    return {
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

        // Auto-migrate legacy projects to parent projects in SQLite Cloud
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
                INSERT OR IGNORE INTO lachvid_parent_projects (id, name, description, created_at, updated_at)
                VALUES (${parentId}, ${orphan.name}, ${orphan.description || ""}, ${orphan.created_at}, ${orphan.updated_at});
              `;
              await client.sql`
                UPDATE lachvid_projects
                SET parent_project_id = ${parentId}
                WHERE id = ${orphan.id};
              `;
            }
          }
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
      } catch (err) {
        console.warn("Lỗi khi kết nối/khởi tạo SQLite Cloud, chuyển sang dùng local fallback:", err);
      }
    })();
  }
  return dbInitPromise;
}

export async function getParentProjects(): Promise<ParentProjectMeta[]> {
  await initDatabase();
  const client = getClient();
  if (!client || !dbInitialized) {
    const local = readLocalStorage();
    const list = Object.values(local.parentProjects || {});
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
        return {
          ...parent,
          foldersCount: childFolders.length,
          poolCount: totalClips,
          renderedCount: totalRendered,
          voiceCount: totalVoices,
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
        (SELECT COUNT(*) FROM lachvid_projects f WHERE f.parent_project_id = p.id) as folders_count,
        (SELECT COUNT(*) FROM lachvid_category_items c WHERE c.project_id IN (SELECT id FROM lachvid_projects WHERE parent_project_id = p.id)) as pool_count,
        (SELECT COUNT(*) FROM lachvid_rendered_history r WHERE r.project_id IN (SELECT id FROM lachvid_projects WHERE parent_project_id = p.id)) as rendered_count,
        (SELECT COUNT(*) FROM lachvid_voice_items v WHERE v.project_id IN (SELECT id FROM lachvid_projects WHERE parent_project_id = p.id)) as voice_count
      FROM lachvid_parent_projects p
      ORDER BY p.updated_at DESC;
    `) as Array<{
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
    }>;

    return rows.map((r) => ({
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
    }));
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
    return local.parentProjects?.[id] || null;
  }
  try {
    const rows = (await client.sql`
      SELECT * FROM lachvid_parent_projects WHERE id = ${id} LIMIT 1;
    `) as Array<{
      id: string;
      name: string;
      description?: string;
      owner_id?: string;
      created_at: string;
      updated_at: string;
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


