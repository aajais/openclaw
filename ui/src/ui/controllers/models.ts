import type { GatewayBrowserClient } from "../gateway.ts";

type ModelCatalogEntry = {
  id: string;
  provider?: string | null;
};

export type ModelsCatalogState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  modelsCatalogLoading: boolean;
  modelsCatalogError: string | null;
  modelsCatalogIds: string[];
};

function toModelRef(entry: ModelCatalogEntry): string {
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const provider = typeof entry.provider === "string" ? entry.provider.trim() : "";
  if (!id) {
    return "";
  }
  return provider ? `${provider}/${id}` : id;
}

export async function loadModelsCatalog(state: ModelsCatalogState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.modelsCatalogLoading) {
    return;
  }
  state.modelsCatalogLoading = true;
  state.modelsCatalogError = null;
  try {
    const res = await state.client.request<{ models?: ModelCatalogEntry[] }>("models.list", {});
    const seen = new Set<string>();
    const next: string[] = [];
    for (const entry of Array.isArray(res?.models) ? res.models : []) {
      const ref = toModelRef(entry);
      if (!ref || seen.has(ref)) {
        continue;
      }
      seen.add(ref);
      next.push(ref);
    }
    state.modelsCatalogIds = next;
  } catch (err) {
    state.modelsCatalogError = String(err);
  } finally {
    state.modelsCatalogLoading = false;
  }
}
