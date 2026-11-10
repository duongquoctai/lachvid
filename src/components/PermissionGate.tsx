"use client";

import React, { createContext, useCallback, useContext, useMemo } from "react";
import {
  ModuleAction,
  ProjectAccessInfo,
  ProjectSharePermissions,
} from "@/types/lachvid";

export type ProjectModule = keyof ProjectSharePermissions; // "split" | "mix" | "history"

export interface ProjectAccessContextValue {
  access: ProjectAccessInfo | null;
  isOwner: boolean;
  can: (module: ProjectModule, action: ModuleAction) => boolean;
  canView: (module: ProjectModule) => boolean;
  canExport: (module: ProjectModule) => boolean;
  canEdit: (module: ProjectModule) => boolean;
  notifyPermissionDenied: (customMessage?: string) => void;
}

const ProjectAccessContext = createContext<ProjectAccessContextValue | null>(null);

export interface ProjectAccessProviderProps {
  access: ProjectAccessInfo | null;
  onPermissionDenied?: (customMessage?: string) => void;
  children: React.ReactNode;
}

export function ProjectAccessProvider({
  access,
  onPermissionDenied,
  children,
}: ProjectAccessProviderProps) {
  const isOwner = Boolean(access?.isOwner);

  const can = useCallback(
    (module: ProjectModule, action: ModuleAction): boolean => {
      if (isOwner) return true;
      if (!access) return true; // Khi chưa có access context (legacy/local), cho phép mặc định
      const modConfig = access.permissions?.[module];
      if (!modConfig?.enabled) return false;
      return Boolean(modConfig.actions?.includes(action));
    },
    [isOwner, access]
  );

  const canView = useCallback(
    (module: ProjectModule) => can(module, "view"),
    [can]
  );
  const canExport = useCallback(
    (module: ProjectModule) => can(module, "export"),
    [can]
  );
  const canEdit = useCallback(
    (module: ProjectModule) => can(module, "edit"),
    [can]
  );

  const notifyPermissionDenied = useCallback(
    (customMessage?: string) => {
      if (onPermissionDenied) {
        onPermissionDenied(customMessage);
      }
    },
    [onPermissionDenied]
  );

  const value = useMemo<ProjectAccessContextValue>(
    () => ({
      access,
      isOwner,
      can,
      canView,
      canExport,
      canEdit,
      notifyPermissionDenied,
    }),
    [access, isOwner, can, canView, canExport, canEdit, notifyPermissionDenied]
  );

  return (
    <ProjectAccessContext.Provider value={value}>
      {children}
    </ProjectAccessContext.Provider>
  );
}

export function useProjectAccess(): ProjectAccessContextValue {
  const ctx = useContext(ProjectAccessContext);
  if (!ctx) {
    return {
      access: null,
      isOwner: true,
      can: () => true,
      canView: () => true,
      canExport: () => true,
      canEdit: () => true,
      notifyPermissionDenied: () => {},
    };
  }
  return ctx;
}

export interface PermissionGateProps {
  module: ProjectModule;
  action: ModuleAction;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

export function PermissionGate({
  module,
  action,
  fallback = null,
  children,
}: PermissionGateProps) {
  const { can } = useProjectAccess();
  if (!can(module, action)) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
