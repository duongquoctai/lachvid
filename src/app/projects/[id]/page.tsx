"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  Film,
  FolderOpen,
  Info,
  Layers,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";

interface FolderItem {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  poolCount?: number;
  renderedCount?: number;
}

interface ParentProjectInfo {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export default function ProjectFoldersPage() {
  const router = useRouter();
  const params = useParams();
  const projectId = typeof params?.id === "string" ? params.id : "";

  const [parentProject, setParentProject] = useState<ParentProjectInfo | null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Create folder modal states
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newFolderName, setNewFolderName] = useState<string>("");
  const [newFolderDesc, setNewFolderDesc] = useState<string>("");

  // Edit folder modal states
  const [editingFolder, setEditingFolder] = useState<FolderItem | null>(null);
  const [editFolderName, setEditFolderName] = useState<string>("");
  const [editFolderDesc, setEditFolderDesc] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState<boolean>(false);

  // Delete folder modal states
  const [folderToDelete, setFolderToDelete] = useState<FolderItem | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);

  const [openMenuFolderId, setOpenMenuFolderId] = useState<string | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);

  const [toasts, setToasts] = useState<
    Array<{
      id: string;
      type: "info" | "success" | "error";
      text: string;
    }>
  >([]);

  const addToast = useCallback(
    (toast: { type: "info" | "success" | "error"; text: string }) => {
      const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      setToasts((prev) => [...prev, { id, ...toast }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 5000);
    },
    [],
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/parent-projects/${encodeURIComponent(projectId)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.parentProject) {
          setParentProject(data.parentProject);
          setFolders(data.folders || []);
          setIsLoading(false);
          return;
        }
      }

      // Fallback check: maybe it's a legacy folder id directly
      const folderRes = await fetch(`/api/project/${encodeURIComponent(projectId)}`);
      if (folderRes.ok) {
        const folderData = await folderRes.json();
        if (folderData.project?.parentProjectId) {
          router.replace(
            `/projects/${folderData.project.parentProjectId}/folders/${projectId}`
          );
          return;
        }
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, [projectId, router]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!openMenuFolderId) return;
    const handleClickOutside = () => setOpenMenuFolderId(null);
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [openMenuFolderId]);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim()) {
      addToast({ type: "error", text: "Vui lòng nhập tên folder." });
      return;
    }
    setBusyMessage("Đang tạo folder mới...");
    try {
      const res = await fetch(`/api/parent-projects/${encodeURIComponent(projectId)}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newFolderName.trim(),
          description: newFolderDesc.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không thể tạo folder");

      setShowCreateModal(false);
      setNewFolderName("");
      setNewFolderDesc("");
      addToast({
        type: "success",
        text: `Đã tạo thành công folder "${data.folder.name}"!`,
      });

      // Navigate straight to the new folder workspace
      router.push(`/projects/${projectId}/folders/${data.folder.id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  const handleOpenEditModal = (f: FolderItem, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditingFolder(f);
    setEditFolderName(f.name);
    setEditFolderDesc(f.description || "");
  };

  const handleUpdateFolder = async () => {
    if (!editingFolder) return;
    const trimmed = editFolderName.trim();
    if (!trimmed) {
      addToast({ type: "error", text: "Vui lòng nhập tên folder." });
      return;
    }
    setIsUpdating(true);
    try {
      const res = await fetch(`/api/project/${editingFolder.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          description: editFolderDesc.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không thể cập nhật folder");

      setFolders((prev) =>
        prev.map((item) =>
          item.id === editingFolder.id
            ? {
                ...item,
                name: trimmed,
                description: editFolderDesc.trim(),
                updatedAt: new Date().toISOString(),
              }
            : item
        )
      );
      setEditingFolder(null);
      addToast({
        type: "success",
        text: `Đã cập nhật tên folder thành "${trimmed}".`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast({ type: "error", text: msg });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleConfirmDeleteFolder = async () => {
    if (!folderToDelete) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/project/${folderToDelete.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không thể xóa folder");

      addToast({ type: "success", text: `Đã xóa folder "${folderToDelete.name}".` });
      setFolderToDelete(null);
      loadData();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast({ type: "error", text: msg });
    } finally {
      setIsDeleting(false);
    }
  };

  const totalClips = folders.reduce((sum, f) => sum + (f.poolCount || 0), 0);
  const totalRendered = folders.reduce((sum, f) => sum + (f.renderedCount || 0), 0);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header with Breadcrumbs */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-6 py-3.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            href="/"
            className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition"
            title="Quay lại danh sách dự án"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>

          <div className="flex items-center gap-2 text-xs">
            <Link
              href="/"
              className="text-slate-400 hover:text-slate-200 transition font-medium"
            >
              Dự án
            </Link>
            <span className="text-slate-600">/</span>
            <span className="font-bold text-white truncate max-w-[200px] sm:max-w-xs">
              {parentProject?.name || "Chi tiết dự án"}
            </span>
          </div>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6">
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* Project Header Banner */}
          <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-3xl p-7 relative overflow-hidden">
            <div className="absolute -top-12 -right-12 w-48 h-48 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 relative z-10">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-extrabold text-white tracking-tight">
                    {parentProject?.name || "Dự án"}
                  </h2>
                  <span className="text-xs font-normal px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                    {folders.length} folder
                  </span>
                </div>
                <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
                  {parentProject?.description ||
                    "Quản lý các folder dòng sản phẩm trong dự án này. Mỗi folder có kho clip và lịch sử render riêng biệt."}
                </p>
                <div className="flex items-center gap-4 text-xs text-slate-400 pt-1">
                  <span className="flex items-center gap-1 font-medium text-sky-400">
                    <Film className="w-3.5 h-3.5" />
                    <span>{totalClips} clip tổng</span>
                  </span>
                  <span className="flex items-center gap-1 font-medium text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{totalRendered} video đã render</span>
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-xl shadow-indigo-600/30 transition shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>Tạo folder mới</span>
              </button>
            </div>
          </div>

          {/* Folders List */}
          {isLoading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
              <p className="text-xs">Đang tải danh sách folder...</p>
            </div>
          ) : folders.length === 0 ? (
            <div className="bg-slate-900/40 border border-dashed border-slate-800 rounded-3xl p-12 text-center space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto text-indigo-400">
                <FolderOpen className="w-8 h-8" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-white">Chưa có folder nào</h3>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Hãy tạo folder đầu tiên (ví dụ: Kem chống nắng, Sữa rửa mặt, Serum...) để bắt đầu import kho clip Drive và trộn video.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-600/30 transition"
              >
                <Plus className="w-4 h-4" />
                <span>Tạo folder</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {folders.map((f) => (
                <Link
                  key={f.id}
                  href={`/projects/${projectId}/folders/${f.id}`}
                  className={`group bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-2xl p-5 space-y-4 cursor-pointer transition-all hover:shadow-xl hover:shadow-indigo-950/40 relative flex flex-col justify-between ${
                    openMenuFolderId === f.id ? "z-20 border-slate-700" : "z-0"
                  }`}
                >
                  <div className="space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300 group-hover:scale-105 transition">
                          <FolderOpen className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-white group-hover:text-indigo-300 transition">
                            {f.name}
                          </h3>
                          <p className="text-[11px] text-slate-400">
                            Cập nhật {new Date(f.updatedAt).toLocaleDateString("vi-VN")}
                          </p>
                        </div>
                      </div>

                      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setOpenMenuFolderId((prev) => (prev === f.id ? null : f.id));
                          }}
                          className={`p-1.5 rounded-lg transition ${
                            openMenuFolderId === f.id
                              ? "text-white bg-slate-800"
                              : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"
                          }`}
                          title="Tùy chọn"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>

                        {openMenuFolderId === f.id && (
                          <div
                            className="absolute right-0 top-full mt-1.5 w-36 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl py-1 z-30 animate-in fade-in zoom-in-95 duration-150 backdrop-blur-md"
                            onClick={(e) => {
                              e.stopPropagation();
                              e.preventDefault();
                            }}
                          >
                            <button
                              type="button"
                              onClick={(e) => {
                                setOpenMenuFolderId(null);
                                handleOpenEditModal(f, e);
                              }}
                              className="w-full px-3 py-2 text-left text-xs font-medium text-slate-300 hover:text-white hover:bg-indigo-600/20 flex items-center gap-2 transition"
                            >
                              <Pencil className="w-3.5 h-3.5 text-indigo-400" />
                              <span>Sửa tên</span>
                            </button>

                            <div className="h-px bg-slate-800 my-1" />

                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                e.preventDefault();
                                setOpenMenuFolderId(null);
                                setFolderToDelete(f);
                              }}
                              className="w-full px-3 py-2 text-left text-xs font-medium text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 flex items-center gap-2 transition"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                              <span>Xóa</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {f.description && (
                      <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                        {f.description}
                      </p>
                    )}
                  </div>

                  <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1 font-medium text-sky-400">
                        <Film className="w-3.5 h-3.5" />
                        <span>{f.poolCount || 0} clip</span>
                      </span>
                      <span className="flex items-center gap-1 font-medium text-emerald-300">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{f.renderedCount || 0} đã render</span>
                      </span>
                    </div>

                    <span className="text-[11px] font-bold text-indigo-400 group-hover:translate-x-0.5 transition flex items-center gap-1">
                      <span>Mở folder</span>
                      <ChevronRight className="w-3 h-3" />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Modal tạo folder mới */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center text-white">
                  <Plus className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-bold text-white">Tạo folder mới</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Tên folder (dòng sản phẩm / chiến dịch) <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="Ví dụ: Kem chống nắng"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateFolder();
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Mô tả folder (Tùy chọn)
                </label>
                <textarea
                  rows={2}
                  value={newFolderDesc}
                  onChange={(e) => setNewFolderDesc(e.target.value)}
                  placeholder="Ghi chú về dòng sản phẩm này..."
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition resize-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={!newFolderName.trim()}
                onClick={handleCreateFolder}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/30 disabled:opacity-50"
              >
                <span>Tạo folder</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal chỉnh sửa folder */}
      {editingFolder && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                  <Pencil className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-bold text-white">Chỉnh sửa tên folder</h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingFolder(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Tên folder <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={editFolderName}
                  onChange={(e) => setEditFolderName(e.target.value)}
                  placeholder="Nhập tên mới cho folder..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleUpdateFolder();
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Mô tả folder (Tùy chọn)
                </label>
                <textarea
                  rows={2}
                  value={editFolderDesc}
                  onChange={(e) => setEditFolderDesc(e.target.value)}
                  placeholder="Ghi chú về dòng sản phẩm này..."
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition resize-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setEditingFolder(null)}
                disabled={isUpdating}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition disabled:opacity-50"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={!editFolderName.trim() || isUpdating}
                onClick={handleUpdateFolder}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/30 disabled:opacity-50"
              >
                {isUpdating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Lưu thay đổi</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal xác nhận xóa folder */}
      {folderToDelete && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-5 shadow-2xl relative overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="absolute -top-10 -right-10 w-32 h-32 bg-rose-500/15 rounded-full blur-3xl pointer-events-none" />

            <div className="flex items-start gap-3.5">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0 text-rose-400">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h3 className="text-sm font-bold text-white">
                  Xác nhận xóa folder
                </h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Bạn có chắc muốn xóa folder{" "}
                  <span className="text-rose-300 font-bold">
                    &quot;{folderToDelete.name}&quot;
                  </span>
                  ?
                </p>
              </div>
            </div>

            <div className="rounded-xl bg-slate-950/70 border border-slate-800 p-3 space-y-1.5 text-[11px] text-slate-400">
              <div className="flex items-center gap-2 text-amber-300 font-medium">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>Lưu ý quan trọng:</span>
              </div>
              <ul className="list-disc list-inside space-y-1 pl-1 text-slate-300">
                <li>
                  Toàn bộ{" "}
                  <span className="text-amber-200 font-bold">
                    {folderToDelete.poolCount || 0} clip
                  </span>{" "}
                  và{" "}
                  <span className="text-amber-200 font-bold">
                    {folderToDelete.renderedCount || 0} video đã render
                  </span>{" "}
                  trong folder này sẽ bị xóa hoàn toàn.
                </li>
                <li>Hành động này không thể hoàn tác.</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-800">
              <button
                type="button"
                disabled={isDeleting}
                onClick={() => setFolderToDelete(null)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition disabled:opacity-50"
              >
                Hủy bỏ
              </button>
              <button
                type="button"
                disabled={isDeleting}
                onClick={handleConfirmDeleteFolder}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition shadow-lg shadow-rose-600/25 disabled:opacity-50"
              >
                {isDeleting ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Trash2 className="w-3.5 h-3.5" />
                )}
                <span>{isDeleting ? "Đang xóa..." : "Xác nhận xóa"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global Loading Overlay */}
      {busyMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-md px-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
            <p className="text-xs text-slate-300 font-mono">{busyMessage}</p>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-xl p-3 shadow-xl border backdrop-blur-md flex items-start gap-2.5 ${
              toast.type === "success"
                ? "bg-slate-900 border-emerald-500/40 text-emerald-200"
                : toast.type === "error"
                  ? "bg-slate-900 border-rose-500/40 text-rose-200"
                  : "bg-slate-900 border-sky-500/40 text-sky-200"
            }`}
          >
            {toast.type === "success" && (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            )}
            {toast.type === "error" && (
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            )}
            {toast.type === "info" && (
              <Info className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
            )}
            <p className="text-xs flex-1">{toast.text}</p>
            <button
              onClick={() => removeToast(toast.id)}
              className="text-slate-400 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
