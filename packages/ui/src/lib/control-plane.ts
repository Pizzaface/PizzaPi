/**
 * Control plane API client for multitenancy features.
 * Uses VITE_CONTROL_PLANE_URL env var as the base URL.
 */

const BASE_URL = (import.meta as any).env?.VITE_CONTROL_PLANE_URL ?? "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body || `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ──────────────────────────────────────────────────────────

export interface Org {
  id: string;
  name: string;
  slug: string;
  domain: string;
  plan: string;
  createdAt: string;
  memberCount?: number;
  runnerCount?: number;
  healthy?: boolean;
}

export interface OrgMember {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member";
  joinedAt: string;
}

export interface OrgRunner {
  id: string;
  name: string;
  status: "online" | "offline";
  lastSeen: string;
}

// ── Org CRUD (admin) ───────────────────────────────────────────────

export async function listOrgs(): Promise<Org[]> {
  return request<Org[]>("/api/admin/orgs");
}

export async function createOrg(data: { name: string; slug: string }): Promise<Org> {
  return request<Org>("/api/admin/orgs", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function deleteOrg(id: string): Promise<void> {
  await request<void>(`/api/admin/orgs/${id}`, { method: "DELETE" });
}

// ── User orgs ──────────────────────────────────────────────────────

export async function listMyOrgs(): Promise<Org[]> {
  return request<Org[]>("/api/orgs");
}

// ── Org settings ───────────────────────────────────────────────────

export async function getOrg(slug: string): Promise<Org> {
  return request<Org>(`/api/orgs/${slug}`);
}

export async function listOrgMembers(slug: string): Promise<OrgMember[]> {
  return request<OrgMember[]>(`/api/orgs/${slug}/members`);
}

export async function inviteOrgMember(slug: string, email: string, role: string): Promise<void> {
  await request(`/api/orgs/${slug}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export async function removeOrgMember(slug: string, memberId: string): Promise<void> {
  await request(`/api/orgs/${slug}/members/${memberId}`, { method: "DELETE" });
}

export async function listOrgRunners(slug: string): Promise<OrgRunner[]> {
  return request<OrgRunner[]>(`/api/orgs/${slug}/runners`);
}
