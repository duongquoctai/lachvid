import { Database } from "@sqlitecloud/drivers";
import fs from "node:fs";
import path from "node:path";
import { CategoryPools, CategoryVideoItem, ShotCategory } from "@/types/lachvid";

export interface ProjectMeta {
  id: string;
  name: string;
  description?: string;
  settings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  renderedCount?: number;
  poolCount?: number;
}

export interface RenderedVideoRecord {
  id: string;
  projectId: string;
  tupleKey: string; // format: openFingerprint|productFingerprint|textureFingerprint|applyFingerprint|endFingerprint
  name?: string;
  renderedAt: string;
}

const LOCAL_FALLBACK_FILE = path.join(process.cwd(), "data", "sqlitecloud_local.json");

function ensureLocalDataDir() {
  const dir = path.dirname(LOCAL_FALLBACK_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

interface LocalStorageSchema {
  projects: Record<string, ProjectMeta>;
  pools: Record<string, CategoryPools>;
  rendered: Record<string, RenderedVideoRecord[]>; // projectId -> records
}

function readLocalStorage(): LocalStorageSchema {
  ensureLocalDataDir();
  if (!fs.existsSync(LOCAL_FALLBACK_FILE)) {
    const init: LocalStorageSchema = { projects: {}, pools: {}, rendered: {} };
    fs.writeFileSync(LOCAL_FALLBACK_FILE, JSON.stringify(init, null, 2), "utf8");
    return init;
  }
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FALLBACK_FILE, "utf8"));
  } catch {
    return { projects: {}, pools: {}, rendered: {} };
  }
}

function writeLocalStorage(data: LocalStorageSchema) {
  ensureLocalDataDir();
  fs.writeFileSync(LOCAL_FALLBACK_FILE, JSON.stringify(data, null, 2), "utf8");
}

let dbClient: Database | null = null;
let dbInitialized = false;

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
  const client = getClient();
  if (!client) {
    // Using local storage fallback
    readLocalStorage();
    dbInitialized = true;
    return;
  }

  try {
    await client.sql`
      CREATE TABLE IF NOT EXISTS lachvid_projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        settings TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `;

    try {
      await client.sql`ALTER TABLE lachvid_projects ADD COLUMN settings TEXT;`;
    } catch {
      // ignore if column already exists
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
        created_at TEXT NOT NULL
      );
    `;

    await client.sql`
      CREATE TABLE IF NOT EXISTS lachvid_rendered_history (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        tuple_key TEXT NOT NULL,
        video_name TEXT,
        rendered_at TEXT NOT NULL
      );
    `;

    dbInitialized = true;
  } catch (err) {
    console.warn("Lỗi khi kết nối/khởi tạo SQLite Cloud, chuyển sang dùng local fallback:", err);
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
      const poolCount =
        pool.open.length + pool.product.length + pool.texture.length + pool.apply.length + pool.end.length;
      return {
        ...p,
        renderedCount: rendered.length,
        poolCount,
      };
    }).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  try {
    const rows = (await client.sql`
      SELECT p.*,
        (SELECT COUNT(*) FROM lachvid_rendered_history r WHERE r.project_id = p.id) as rendered_count,
        (SELECT COUNT(*) FROM lachvid_category_items c WHERE c.project_id = p.id) as pool_count
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
    }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description || undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      renderedCount: Number(r.rendered_count || 0),
      poolCount: Number(r.pool_count || 0),
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
    return local.projects[id] || null;
  }

  try {
    const rows = (await client.sql`
      SELECT * FROM lachvid_projects WHERE id = ${id} LIMIT 1;
    `) as Array<{
      id: string;
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

export async function createProject(name: string, description = ""): Promise<ProjectMeta> {
  await initDatabase();
  const id = `prj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const meta: ProjectMeta = {
    id,
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
    local.rendered[id] = [];
    writeLocalStorage(local);
    return meta;
  }

  try {
    await client.sql`
      INSERT INTO lachvid_projects (id, name, description, created_at, updated_at)
      VALUES (${id}, ${meta.name}, ${meta.description || ""}, ${now}, ${now});
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
    delete local.rendered[id];
    writeLocalStorage(local);
  } else {
    try {
      await client.sql`DELETE FROM lachvid_rendered_history WHERE project_id = ${id};`;
      await client.sql`DELETE FROM lachvid_category_items WHERE project_id = ${id};`;
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
            duration, size_bytes, lock_flip_h, drive_file_id, source_type, created_at
          ) VALUES (
            ${it.id}, ${projectId}, ${cat}, ${it.name}, ${it.fileName}, ${it.localUrl},
            ${it.localPath || null}, ${it.duration}, ${it.sizeBytes || null},
            ${it.lockFlipH ? 1 : 0}, ${it.driveFileId || null}, ${it.sourceType || "drive"}, ${now}
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

export async function getRenderedHistory(projectId: string): Promise<RenderedVideoRecord[]> {
  await initDatabase();
  const client = getClient();
  if (!client) {
    const local = readLocalStorage();
    return local.rendered[projectId] || [];
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
      rendered_at: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      projectId: r.project_id,
      tupleKey: r.tuple_key,
      name: r.video_name || undefined,
      renderedAt: r.rendered_at,
    }));
  } catch (err) {
    console.error("Lỗi getRenderedHistory:", err);
    return [];
  }
}

export async function recordRenderedVideos(
  projectId: string,
  records: Array<{ tupleKey: string; name?: string }>
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
      await client.sql`
        INSERT INTO lachvid_rendered_history (id, project_id, tuple_key, video_name, rendered_at)
        VALUES (${id}, ${projectId}, ${rec.tupleKey}, ${rec.name || null}, ${now});
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
