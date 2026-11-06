"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
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

interface ProjectItem {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  renderedCount?: number;
  poolCount?: number;
}

export default function HomePage() {
  const router = useRouter();
  const [projectList, setProjectList] = useState<ProjectItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [showCreateModal, setShowCreateModal] = useState<boolean>(false);
  const [newProjectName, setNewProjectName] = useState<string>("");
  const [newProjectDesc, setNewProjectDesc] = useState<string>("");
  const [editingProject, setEditingProject] = useState<ProjectItem | null>(null);
  const [editProjectName, setEditProjectName] = useState<string>("");
  const [editProjectDesc, setEditProjectDesc] = useState<string>("");
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const [openMenuProjectId, setOpenMenuProjectId] = useState<string | null>(null);
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

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/project");
      const data = await res.json();
      if (data.projects) {
        setProjectList(data.projects);
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    fetch("/api/project")
      .then((res) => res.json())
      .then((data) => {
        if (!ignore && data.projects) {
          setProjectList(data.projects);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (!openMenuProjectId) return;
    const handleClickOutside = () => setOpenMenuProjectId(null);
    window.addEventListener("click", handleClickOutside);
    return () => window.removeEventListener("click", handleClickOutside);
  }, [openMenuProjectId]);

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) {
      addToast({ type: "error", text: "Vui lòng nhập tên dự án." });
      return;
    }
    setBusyMessage("Đang tạo dự án mới...");
    try {
      const res = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: newProjectName.trim(),
          description: newProjectDesc.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không thể tạo dự án");

      setShowCreateModal(false);
      setNewProjectName("");
      setNewProjectDesc("");
      addToast({
        type: "success",
        text: `Đã tạo thành công dự án "${data.project.name}"!`,
      });

      // Chuyển trực tiếp sang route /projects/[id]
      router.push(`/projects/${data.project.id}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast({ type: "error", text: msg });
    } finally {
      setBusyMessage(null);
    }
  };

  const handleOpenEditModal = (p: ProjectItem, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditingProject(p);
    setEditProjectName(p.name);
    setEditProjectDesc(p.description || "");
  };

  const handleUpdateProject = async () => {
    if (!editingProject) return;
    const trimmed = editProjectName.trim();
    if (!trimmed) {
      addToast({ type: "error", text: "Vui lòng nhập tên dự án." });
      return;
    }
    setIsUpdating(true);
    try {
      const res = await fetch(`/api/project/${editingProject.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          description: editProjectDesc.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không thể cập nhật dự án");

      setProjectList((prev) =>
        prev.map((item) =>
          item.id === editingProject.id
            ? {
                ...item,
                name: trimmed,
                description: editProjectDesc.trim(),
                updatedAt: new Date().toISOString(),
              }
            : item
        )
      );
      setEditingProject(null);
      addToast({
        type: "success",
        text: `Đã cập nhật tên dự án thành "${trimmed}".`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast({ type: "error", text: msg });
    } finally {
      setIsUpdating(false);
    }
  };

  const handleDeleteProject = async (
    id: string,
    name: string,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    if (
      !confirm(
        `Bạn có chắc chắn muốn xóa dự án "${name}"?\nToàn bộ dữ liệu (kho clip import, lịch sử video đã render) của dự án này sẽ bị xóa hoàn toàn.`,
      )
    ) {
      return;
    }

    try {
      const res = await fetch(`/api/project/${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không thể xóa dự án");

      addToast({ type: "success", text: `Đã xóa dự án "${name}".` });
      fetchProjects();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast({ type: "error", text: msg });
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Top Header - Không còn nút tạo dự án ở header */}
      <header className="sticky top-0 z-40 bg-slate-900/90 backdrop-blur-md border-b border-slate-800 px-6 py-3.5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-rose-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-rose-500/20">
            <Film className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-extrabold tracking-tight">
              <span>Lachvid Studio</span>
            </h1>
            <p className="text-xs text-slate-400">
              Hệ thống tách video slicer & trộn lách content mỹ phẩm
            </p>
          </div>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full space-y-6">
        <div className="space-y-6 animate-in fade-in duration-300">
          {/* Header banner */}
          <div className="bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-slate-800 rounded-3xl p-7 relative overflow-hidden">
            <div className="absolute -top-12 -right-12 w-48 h-48 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none" />
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 relative z-10">
              <div className="space-y-1.5">
                <h2 className="text-xl font-extrabold text-white tracking-tight flex items-center gap-2">
                  <span>Quản lý dự án & brand</span>
                  <span className="text-xs font-normal px-2.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                    Cloud sync
                  </span>
                </h2>
                <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
                  Chọn một dự án để tiếp tục làm việc hoặc tạo mới. Dữ liệu kho clip và lịch sử render sẽ được lưu trữ đồng bộ, giúp các thành viên cùng team không bị trùng lặp video khi render qua các ngày.
                </p>
              </div>

              {/* Nút Tạo dự án màu indigo-600 */}
              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-xl shadow-indigo-600/30 transition shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>Tạo dự án</span>
              </button>
            </div>
          </div>

          {/* Project List */}
          {isLoading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-3 text-slate-400">
              <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
              <p className="text-xs">Đang tải danh sách dự án...</p>
            </div>
          ) : projectList.length === 0 ? (
            <div className="bg-slate-900/40 border border-dashed border-slate-800 rounded-3xl p-12 text-center space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center mx-auto text-indigo-400">
                <FolderOpen className="w-8 h-8" />
              </div>
              <div className="space-y-1">
                <h3 className="text-base font-bold text-white">Chưa có dự án hoặc brand nào</h3>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Mời tạo dự án để bắt đầu import kho clip Drive và quản lý lịch sử render không trùng lặp cho team của bạn.
                </p>
              </div>

              {/* Nút Tạo dự án màu indigo-600 */}
              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-600/30 transition"
              >
                <Plus className="w-4 h-4" />
                <span>Tạo dự án</span>
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {projectList.map((p) => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className={`group bg-slate-900/80 hover:bg-slate-900 border border-slate-800 hover:border-indigo-500/50 rounded-2xl p-5 space-y-4 cursor-pointer transition-all hover:shadow-xl hover:shadow-indigo-950/40 relative flex flex-col justify-between ${
                    openMenuProjectId === p.id ? "z-20 border-slate-700" : "z-0"
                  }`}
                >
                  <div className="space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <div className="w-10 h-10 rounded-xl bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300 group-hover:scale-105 transition">
                          <Layers className="w-5 h-5" />
                        </div>
                        <div>
                          <h3 className="text-sm font-bold text-white group-hover:text-indigo-300 transition">
                            {p.name}
                          </h3>
                          <p className="text-[11px] text-slate-400">
                            Cập nhật {new Date(p.updatedAt).toLocaleDateString("vi-VN")}
                          </p>
                        </div>
                      </div>

                      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            e.preventDefault();
                            setOpenMenuProjectId((prev) => (prev === p.id ? null : p.id));
                          }}
                          className={`p-1.5 rounded-lg transition ${
                            openMenuProjectId === p.id
                              ? "text-white bg-slate-800"
                              : "text-slate-500 hover:text-slate-300 hover:bg-slate-800"
                          }`}
                          title="Tùy chọn"
                        >
                          <MoreVertical className="w-4 h-4" />
                        </button>

                        {openMenuProjectId === p.id && (
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
                                setOpenMenuProjectId(null);
                                handleOpenEditModal(p, e);
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
                                setOpenMenuProjectId(null);
                                handleDeleteProject(p.id, p.name, e);
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

                    {p.description && (
                      <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">
                        {p.description}
                      </p>
                    )}
                  </div>

                  <div className="pt-3 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1 font-medium text-slate-300">
                        <Film className="w-3.5 h-3.5 text-indigo-400" />
                        <span>{p.poolCount || 0} clip</span>
                      </span>
                      <span className="flex items-center gap-1 font-medium text-emerald-300">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span>{p.renderedCount || 0} đã render</span>
                      </span>
                    </div>

                    <span className="text-[11px] font-bold text-indigo-400 group-hover:translate-x-0.5 transition flex items-center gap-1">
                      <span>Mở</span>
                      <ChevronRight className="w-3 h-3" />
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Modal tạo dự án mới */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center text-white">
                  <Plus className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-bold text-white">Tạo dự án mới</h3>
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
                  Tên dự án / Thương hiệu <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="Ví dụ: Brand A - Kem chống nắng"
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreateProject();
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Mô tả dự án (Tùy chọn)
                </label>
                <textarea
                  rows={2}
                  value={newProjectDesc}
                  onChange={(e) => setNewProjectDesc(e.target.value)}
                  placeholder="Ghi chú về chiến dịch, sản phẩm, hướng dẫn..."
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
                Hủy
              </button>
              <button
                type="button"
                disabled={!newProjectName.trim()}
                onClick={handleCreateProject}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/30 disabled:opacity-50"
              >
                <span>Tạo dự án</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal chỉnh sửa dự án */}
      {editingProject && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                  <Pencil className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-bold text-white">Chỉnh sửa tên dự án</h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingProject(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Tên dự án / Thương hiệu <span className="text-rose-400">*</span>
                </label>
                <input
                  type="text"
                  value={editProjectName}
                  onChange={(e) => setEditProjectName(e.target.value)}
                  placeholder="Nhập tên mới cho dự án..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleUpdateProject();
                  }}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Mô tả dự án (Tùy chọn)
                </label>
                <textarea
                  rows={2}
                  value={editProjectDesc}
                  onChange={(e) => setEditProjectDesc(e.target.value)}
                  placeholder="Ghi chú về chiến dịch, sản phẩm, hướng dẫn..."
                  className="w-full px-3.5 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition resize-none"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setEditingProject(null)}
                disabled={isUpdating}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition disabled:opacity-50"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={!editProjectName.trim() || isUpdating}
                onClick={handleUpdateProject}
                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/30 disabled:opacity-50"
              >
                {isUpdating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Lưu thay đổi</span>
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
