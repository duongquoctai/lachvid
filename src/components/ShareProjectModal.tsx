"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  Film,
  History,
  Layers,
  Loader2,
  Mail,
  Plus,
  Share2,
  Trash2,
  UserCheck,
  UserX,
  X,
} from "lucide-react";
import { getUserInitials } from "@/components/UserAvatarMenu";
import {
  DEFAULT_SHARE_PERMISSIONS,
  ModuleAction,
  ProjectSharePermissions,
  ResourceShare,
  UserSafeProfile,
} from "@/types/lachvid";

interface ShareProjectModalProps {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onToast: (toast: { type: "info" | "success" | "error"; text: string }) => void;
}

export default function ShareProjectModal({
  projectId,
  projectName,
  onClose,
  onToast,
}: ShareProjectModalProps) {
  const [shares, setShares] = useState<
    Array<ResourceShare & { sharedUserName?: string }>
  >([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [targetEmail, setTargetEmail] = useState<string>("");
  const [permissions, setPermissions] = useState<ProjectSharePermissions>(
    DEFAULT_SHARE_PERMISSIONS
  );
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [deletingShareId, setDeletingShareId] = useState<string | null>(null);

  // Autocomplete danh sách user trong hệ thống
  const [systemUsers, setSystemUsers] = useState<UserSafeProfile[]>([]);
  const [isAutocompleteOpen, setIsAutocompleteOpen] = useState<boolean>(false);
  const autocompleteContainerRef = useRef<HTMLDivElement>(null);

  // Load danh sách những người đang được share
  const loadShares = useCallback(async () => {
    try {
      const res = await fetch(`/api/parent-projects/${projectId}/shares`);
      const data = await res.json();
      if (res.ok && data.shares) {
        setShares(data.shares);
      }
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    let ignore = false;
    fetch(`/api/parent-projects/${projectId}/shares`)
      .then((res) => res.json())
      .then((data) => {
        if (!ignore && data.shares) {
          setShares(data.shares);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });

    // Tải danh sách user trong hệ thống để phục vụ autocomplete
    fetch("/api/users")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!ignore && data?.users) {
          setSystemUsers(data.users);
        }
      })
      .catch(() => {});

    return () => {
      ignore = true;
    };
  }, [projectId]);

  // Click outside listener để đóng dropdown autocomplete
  useEffect(() => {
    if (!isAutocompleteOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        autocompleteContainerRef.current &&
        !autocompleteContainerRef.current.contains(e.target as Node)
      ) {
        setIsAutocompleteOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [isAutocompleteOpen]);

  // Tập hợp email của những người đã được chia sẻ dự án (để ẩn khỏi gợi ý)
  const sharedEmailsSet = useMemo(() => {
    return new Set(shares.map((s) => s.sharedWithEmail.toLowerCase().trim()));
  }, [shares]);

  // Danh sách user autocomplete thỏa điều kiện tìm kiếm và chưa có trong shares
  const filteredUsers = useMemo(() => {
    const q = targetEmail.trim().toLowerCase();
    return systemUsers.filter((u) => {
      // Ẩn người đã được chia sẻ
      if (sharedEmailsSet.has(u.email.toLowerCase().trim())) {
        return false;
      }
      // Nếu chưa nhập ký tự nào, hiển thị toàn bộ người chưa được chia sẻ
      if (!q) return true;
      // Nếu có ký tự, lọc theo tên hoặc email
      return (
        u.email.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q)
      );
    });
  }, [systemUsers, sharedEmailsSet, targetEmail]);

  // Toggle action cho module: khi bật export/edit -> tự động bật view & enabled
  const handleToggleAction = (
    moduleKey: keyof ProjectSharePermissions,
    action: ModuleAction
  ) => {
    setPermissions((prev) => {
      const current = prev[moduleKey] || { enabled: false, actions: [] };
      const currentActions = new Set(current.actions);

      if (currentActions.has(action)) {
        currentActions.delete(action);
        // Nếu bỏ view thì bỏ hết
        if (action === "view") {
          currentActions.clear();
        }
      } else {
        currentActions.add(action);
        // Nếu bật edit hoặc export thì bắt buộc bật view
        if (action === "edit" || action === "export") {
          currentActions.add("view");
        }
      }

      const actionsArr = Array.from(currentActions);
      return {
        ...prev,
        [moduleKey]: {
          enabled: actionsArr.length > 0,
          actions: actionsArr,
        },
      };
    });
  };

  // Toggle toàn bộ module
  const handleToggleModule = (moduleKey: keyof ProjectSharePermissions) => {
    setPermissions((prev) => {
      const current = prev[moduleKey];
      if (current.enabled) {
        return {
          ...prev,
          [moduleKey]: { enabled: false, actions: [] },
        };
      }
      return {
        ...prev,
        [moduleKey]: { enabled: true, actions: ["view", "export"] },
      };
    });
  };

  const handleShareSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = targetEmail.trim().toLowerCase();
    if (!email) {
      onToast({ type: "error", text: "Vui lòng nhập email người nhận." });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/parent-projects/${projectId}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, permissions }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Không thể chia sẻ dự án.");
      }

      onToast({
        type: "success",
        text: `Đã cấp quyền chia sẻ thành công cho ${email}.`,
      });
      setTargetEmail("");
      setPermissions(DEFAULT_SHARE_PERMISSIONS);
      loadShares();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast({ type: "error", text: msg });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemoveShare = async (shareId: string, email: string) => {
    setDeletingShareId(shareId);
    try {
      const res = await fetch(
        `/api/parent-projects/${projectId}/shares?shareId=${encodeURIComponent(
          shareId
        )}`,
        { method: "DELETE" }
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Không thể thu hồi quyền chia sẻ.");
      }

      onToast({
        type: "success",
        text: `Đã thu hồi quyền chia sẻ của ${email}.`,
      });
      loadShares();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      onToast({ type: "error", text: msg });
    } finally {
      setDeletingShareId(null);
    }
  };

  const handleEditExistingShare = (share: ResourceShare) => {
    setTargetEmail(share.sharedWithEmail);
    setPermissions(share.permissions);
  };

  const modulesList: Array<{
    key: keyof ProjectSharePermissions;
    title: string;
    icon: React.ReactNode;
    desc: string;
  }> = [
    {
      key: "split",
      title: "Tách cảnh video",
      icon: <Film className="w-4 h-4 text-rose-400" />,
      desc: "Xem video gốc, tải cảnh cắt, hoặc chỉnh sửa mốc giây & tách scene",
    },
    {
      key: "mix",
      title: "Trộn video & kho clip",
      icon: <Layers className="w-4 h-4 text-indigo-400" />,
      desc: "Xem kho clip 5 category, bấm trộn tổ hợp và tải file MP4/ZIP",
    },
    {
      key: "history",
      title: "Lịch sử render",
      icon: <History className="w-4 h-4 text-emerald-400" />,
      desc: "Xem danh sách video, tải video MP4, bật/tắt trạng thái sử dụng hoặc xóa",
    },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-2xl w-full p-6 sm:p-7 space-y-6 shadow-2xl relative overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Share2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-sm sm:text-base font-extrabold text-white flex items-center gap-2">
                <span>Chia sẻ dự án</span>
                <span className="text-xs font-normal text-indigo-300 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/30 truncate max-w-[200px]">
                  {projectName}
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Phân quyền chi tiết theo từng module cho thành viên trong nhóm
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto space-y-6 pr-1">
          {/* Share Form */}
          <form onSubmit={handleShareSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-slate-300">
                Email người nhận <span className="text-rose-400">*</span>
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1" ref={autocompleteContainerRef}>
                  <Mail className="w-4 h-4 text-slate-500 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="email"
                    required
                    value={targetEmail}
                    onFocus={() => setIsAutocompleteOpen(true)}
                    onChange={(e) => {
                      setTargetEmail(e.target.value);
                      setIsAutocompleteOpen(true);
                    }}
                    placeholder="thanhvien@example.com"
                    className="w-full pl-10 pr-3.5 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 transition"
                  />

                  {/* Dropdown danh sách gợi ý autocomplete */}
                  {isAutocompleteOpen && (
                    <div className="absolute left-0 right-0 top-full mt-1.5 max-h-56 overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 shadow-2xl p-1.5 z-50 divide-y divide-slate-800/60">
                      {filteredUsers.length > 0 ? (
                        <>
                          <div className="px-2.5 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                            Thành viên trong hệ thống ({filteredUsers.length})
                          </div>
                          <div className="space-y-0.5 pt-1">
                            {filteredUsers.map((u) => {
                              const initials = getUserInitials(u.name, u.email);
                              return (
                                <button
                                  key={u.id}
                                  type="button"
                                  onClick={() => {
                                    setTargetEmail(u.email);
                                    setIsAutocompleteOpen(false);
                                  }}
                                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left hover:bg-slate-800 transition group cursor-pointer"
                                >
                                  <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-indigo-600 to-rose-600 border border-indigo-400/30 flex items-center justify-center text-white text-[11px] font-bold shrink-0">
                                    {initials}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-bold text-white group-hover:text-indigo-300 transition truncate">
                                      {u.name}
                                    </p>
                                    <p className="text-[11px] text-slate-400 font-mono truncate">
                                      {u.email}
                                    </p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="p-3 text-center">
                          <p className="text-xs text-slate-300 font-medium">
                            Không có thành viên nào trùng khớp
                          </p>
                          <p className="text-[11px] text-slate-500 mt-0.5">
                            Bạn vẫn có thể chia sẻ cho email này (Chờ đăng ký)
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting || !targetEmail.trim()}
                  className="px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition shadow-lg shadow-indigo-600/30 flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Plus className="w-4 h-4" />
                  )}
                  <span>Lưu quyền chia sẻ</span>
                </button>
              </div>
            </div>

            {/* Permission Matrix */}
            <div className="space-y-2.5">
              <label className="text-xs font-semibold text-slate-300 flex items-center justify-between">
                <span>Ma trận quyền theo từng module:</span>
                <span className="text-[11px] font-normal text-slate-500">
                  (Cấp quyền edit sẽ cho phép tạo/xóa folder con)
                </span>
              </label>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 divide-y divide-slate-800/80 overflow-hidden">
                {modulesList.map((mod) => {
                  const modConfig = permissions[mod.key] || {
                    enabled: false,
                    actions: [],
                  };
                  const isEnabled = modConfig.enabled;

                  return (
                    <div
                      key={mod.key}
                      className={`p-3.5 sm:p-4 transition ${
                        isEnabled ? "bg-slate-900/40" : "opacity-60"
                      }`}
                    >
                      <div className="space-y-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <button
                            type="button"
                            onClick={() => handleToggleModule(mod.key)}
                            className={`w-5 h-5 rounded-lg border flex items-center justify-center shrink-0 mt-0.5 transition ${
                              isEnabled
                                ? "bg-indigo-600 border-indigo-500 text-white"
                                : "border-slate-700 bg-slate-950"
                            }`}
                          >
                            {isEnabled && <Check className="w-3.5 h-3.5 stroke-[3]" />}
                          </button>
                          <div className="space-y-0.5 flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {mod.icon}
                              <h4 className="text-xs font-bold text-white">
                                {mod.title}
                              </h4>
                            </div>
                            <p className="text-[11px] text-slate-400 leading-relaxed">
                              {mod.desc}
                            </p>
                          </div>
                        </div>

                        {/* Actions pills: Xuống dòng lệch phải, chữ không bị rớt dòng */}
                        <div className="flex justify-end items-center gap-2 pt-2 border-t border-slate-800/60">
                          {(["view", "export", "edit"] as ModuleAction[]).map(
                            (action) => {
                              const isChecked =
                                isEnabled && modConfig.actions.includes(action);
                              const actionLabels: Record<ModuleAction, string> = {
                                view: "Xem",
                                export: "Tải / xuất",
                                edit: "Chỉnh sửa",
                              };

                              return (
                                <button
                                  key={action}
                                  type="button"
                                  onClick={() =>
                                    handleToggleAction(mod.key, action)
                                  }
                                  className={`whitespace-nowrap px-3 py-1.5 rounded-xl text-xs font-semibold border transition shrink-0 ${
                                    isChecked
                                      ? "bg-indigo-600/20 text-indigo-300 border-indigo-500/50 shadow-sm"
                                      : "bg-slate-950 text-slate-500 border-slate-800 hover:text-slate-300"
                                  }`}
                                >
                                  {actionLabels[action]}
                                </button>
                              );
                            }
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </form>

          {/* List of currently shared users */}
          <div className="space-y-3 pt-2 border-t border-slate-800">
            <h3 className="text-xs font-bold text-white flex items-center justify-between">
              <span>Đang chia sẻ với ({shares.length}):</span>
              <span className="text-[11px] font-normal text-slate-400">
                Bấm vào dòng để sửa nhanh quyền
              </span>
            </h3>

            {isLoading ? (
              <div className="py-6 flex items-center justify-center gap-2 text-xs text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                <span>Đang tải danh sách chia sẻ...</span>
              </div>
            ) : shares.length === 0 ? (
              <div className="p-6 rounded-2xl bg-slate-950/40 border border-dashed border-slate-800 text-center text-xs text-slate-500">
                Chưa có ai được chia sẻ dự án này.
              </div>
            ) : (
              <div className="space-y-2">
                {shares.map((share) => {
                  const isRegistered = Boolean(share.sharedWithUserId);
                  const isDeleting = deletingShareId === share.id;

                  return (
                    <div
                      key={share.id}
                      onClick={() => handleEditExistingShare(share)}
                      className="p-3 rounded-2xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition flex items-center justify-between gap-3 cursor-pointer group"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs font-bold text-white">
                            {share.sharedWithEmail}
                          </span>
                          {share.sharedUserName && (
                            <span className="text-[11px] text-slate-400">
                              ({share.sharedUserName})
                            </span>
                          )}
                          {isRegistered ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              <UserCheck className="w-3 h-3" />
                              <span>Đang hoạt động</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              <UserX className="w-3 h-3" />
                              <span>Chờ đăng ký</span>
                            </span>
                          )}
                        </div>

                        {/* Active permissions badges */}
                        <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
                          {modulesList.map((m) => {
                            const p = share.permissions[m.key];
                            if (!p?.enabled) return null;
                            const hasEdit = p.actions.includes("edit");
                            const hasExport = p.actions.includes("export");
                            return (
                              <span
                                key={m.key}
                                className={`px-2 py-0.5 rounded-md border font-medium ${
                                  hasEdit
                                    ? "bg-rose-500/10 text-rose-300 border-rose-500/30"
                                    : hasExport
                                    ? "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
                                    : "bg-slate-900 text-slate-400 border-slate-800"
                                }`}
                              >
                                {m.title}: {p.actions.join(", ")}
                              </span>
                            );
                          })}
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={isDeleting}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveShare(share.id, share.sharedWithEmail);
                        }}
                        className="p-2 rounded-xl text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition shrink-0"
                        title="Thu hồi quyền chia sẻ"
                      >
                        {isDeleting ? (
                          <Loader2 className="w-4 h-4 animate-spin text-rose-400" />
                        ) : (
                          <Trash2 className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-slate-800 flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-semibold text-slate-300 transition"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
